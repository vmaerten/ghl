import { useEffect, useState } from 'react'
import { readSession, writeSession } from './reviewSession.ts'
import type { ServedComment } from '../../src/types.ts'
import type { Composer } from './CommentThread.tsx'

export interface SessionDraft {
  composer: Composer
  body: string
  fingerprint: string | null
  source: 'diff' | 'panel'
  submitted?: boolean
}
export function draftScope(repoId: string | null, query: string) {
  return `${repoId}:drafts:${query}`
}
const knownScopes = new Set<string>()

export function readDrafts(scope: string): Record<string, SessionDraft> {
  knownScopes.add(scope)
  const drafts = readSession(scope).drafts
  return drafts && typeof drafts === 'object' ? (drafts as Record<string, SessionDraft>) : {}
}
export function saveDraft(scope: string, id: string, draft: SessionDraft | null) {
  const drafts = { ...readDrafts(scope) }
  if (draft) {
    const previous = drafts[id]
    if (previous?.body && previous.fingerprint !== draft.fingerprint) {
      drafts[`${id}:recovered:${crypto.randomUUID()}`] = previous
    }
    // Insertion order records which editor was used most recently.
    delete drafts[id]
    drafts[id] = draft
  } else delete drafts[id]
  writeSession(scope, { drafts })
  window.dispatchEvent(new Event('ghl-drafts'))
}
/** A successful retry must retire the retained draft as well as its failure badge. */
export function acknowledgeDrafts(
  repoId: string | null,
  comments: ServedComment[],
  saving: Map<string, unknown>,
) {
  for (const scope of knownScopes) {
    if (!scope.startsWith(`${repoId}:drafts:`)) continue
    for (const [id, draft] of Object.entries(readDrafts(scope))) {
      if (!draft.submitted) continue
      if (
        comments.some(
          (comment) =>
            !saving.has(comment.id) &&
            (draft.composer.editing === null || draft.composer.editing === comment.id) &&
            comment.path === draft.composer.path &&
            comment.side === draft.composer.side &&
            comment.start === draft.composer.start &&
            comment.end === draft.composer.end &&
            comment.body === draft.body.trim(),
        )
      )
        saveDraft(scope, id, null)
    }
  }
}

export function RecoveredDrafts({
  scope,
  fingerprints,
}: {
  scope: string
  fingerprints: Record<string, string | null>
}) {
  const [, refresh] = useState(0)
  useEffect(() => {
    const update = () => refresh((n) => n + 1)
    window.addEventListener('ghl-drafts', update)
    return () => window.removeEventListener('ghl-drafts', update)
  }, [])
  const recovered = Object.entries(readDrafts(scope)).filter(
    ([, draft]) => draft.body && fingerprints[draft.composer.path] !== draft.fingerprint,
  )
  if (!recovered.length) return null
  return (
    <div className="recovered-drafts" role="status">
      <strong>Recovered drafts — the code has changed</strong>
      <p>Copy your text before choosing a new location.</p>
      {recovered.map(([id, draft]) => (
        <div key={id}>
          <label>
            {draft.composer.path}
            <textarea readOnly value={draft.body} onFocus={(event) => event.target.select()} />
          </label>
          <button className="button" onClick={() => saveDraft(scope, id, null)}>
            Discard draft
          </button>
        </div>
      ))}
    </div>
  )
}
