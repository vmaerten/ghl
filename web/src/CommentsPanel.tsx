import { readDrafts, saveDraft } from './draftSession.tsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ServedComment } from '../../src/types.ts'
import type { SaveState } from './commentPersistence.ts'
import CommentCard, { lineLabel } from './CommentCard.tsx'
import Icon from './Icon.tsx'

export default function CommentsPanel({
  scope,
  fingerprints,
  open,
  comments,
  currentRange,
  saving,
  copied,
  copyError,
  onClose,
  onCopy,
  onView,
  canView,
  onUpdate,
  onDelete,
  onRetry,
}: {
  scope: string
  fingerprints: Record<string, string | null>
  open: boolean
  comments: ServedComment[]
  currentRange: string
  saving: Map<string, SaveState>
  copied: string | null
  copyError: string | null
  onClose: () => void
  onCopy: (comment?: ServedComment) => void
  onView: (comment: ServedComment) => void
  canView: (comment: ServedComment) => boolean
  onUpdate: (comment: ServedComment, body: string) => Promise<void>
  onDelete: (id: string) => void
  onRetry: (comment: ServedComment) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saveError, setSaveError] = useState('')
  const fingerprintKey = JSON.stringify(fingerprints)
  useEffect(() => {
    const currentFingerprints = JSON.parse(fingerprintKey) as Record<string, string | null>
    const saved = Object.values(readDrafts(scope)).findLast(
      (entry) =>
        entry.source === 'panel' && currentFingerprints[entry.composer.path] === entry.fingerprint,
    )
    setEditing(saved?.composer.editing ?? null)
    setDraft(saved?.body ?? '')
  }, [scope, fingerprintKey])
  const persistDraft = (comment: ServedComment, body: string, submitted = false) =>
    saveDraft(scope, `panel:${comment.id}`, {
      composer: {
        key: comment.id,
        path: comment.path,
        side: comment.side,
        start: comment.start,
        end: comment.end,
        editing: comment.id,
      },
      body,
      source: 'panel',
      submitted,
      fingerprint: fingerprints[comment.path] ?? null,
    })
  const cancel = () => {
    if (editing) saveDraft(scope, `panel:${editing}`, null)
    setEditing(null)
    setSaveError('')
  }
  const groups = useMemo(() => {
    const result = new Map<string, ServedComment[]>()
    for (const comment of comments.toSorted(
      (a, b) =>
        a.path.localeCompare(b.path) || a.start - b.start || a.createdAt.localeCompare(b.createdAt),
    )) {
      const group = result.get(comment.path) ?? []
      group.push(comment)
      result.set(comment.path, group)
    }
    return [...result]
  }, [comments])
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal()
    else if (!open && dialog.current?.open) dialog.current.close()
  }, [open])
  const update = async (comment: ServedComment) => {
    if (!draft.trim()) return
    try {
      persistDraft(comment, draft.trim(), true)
      await onUpdate(comment, draft.trim())
      cancel()
    } catch {
      setSaveError('Could not save this edit. Your draft is kept; try Update again.')
    }
  }
  return (
    <dialog
      ref={dialog}
      className="comments-panel"
      id="comments-panel"
      aria-labelledby="comments-title"
      onCancel={onClose}
      onClose={onClose}
      onClick={(event) => {
        if (
          event.target === event.currentTarget &&
          event.clientX < event.currentTarget.getBoundingClientRect().left
        )
          onClose()
      }}
    >
      <div className="comments-panel-head">
        <h2 id="comments-title">
          <Icon name="comment" /> Comments <span className="counter">{comments.length}</span>
        </h2>
        <button
          className="icon-button"
          type="button"
          aria-label="Close comments"
          onClick={onClose}
          autoFocus
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="comments-panel-toolbar">
        <span>All comments in this repository</span>
        <button
          type="button"
          className="button primary"
          disabled={comments.length === 0}
          onClick={() => onCopy()}
        >
          <Icon name="copy" />
          {copied === 'all' ? 'Copied' : 'Copy all'}
        </button>
      </div>
      {copyError && (
        <p className="warning" role="alert">
          {copyError}
        </p>
      )}
      <div className="comments-panel-list">
        {groups.length === 0 && (
          <div className="comments-empty">
            <Icon name="comment" />
            <h3>No comments yet</h3>
            <p>
              Select lines in the diff and press <kbd>c</kbd>, or use the + in the gutter to leave a
              comment.
            </p>
          </div>
        )}
        {open &&
          groups.map(([path, group]) => (
            <section className="comment-file" key={path} aria-label={path}>
              <h3>
                <Icon name="file" />
                <span>{path}</span>
                <span className="counter">{group.length}</span>
              </h3>
              {group.map((comment) =>
                editing === comment.id ? (
                  <form
                    key={comment.id}
                    className="panel-editor"
                    onSubmit={(event) => {
                      event.preventDefault()
                      update(comment)
                    }}
                  >
                    <label>
                      Edit comment · {lineLabel(comment.start, comment.end)}
                      <textarea
                        autoFocus
                        rows={5}
                        value={draft}
                        onChange={(event) => {
                          setDraft(event.target.value)
                          persistDraft(comment, event.target.value)
                        }}
                        onKeyDown={(event) => {
                          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                            event.preventDefault()
                            update(comment)
                          } else if (event.key === 'Escape') {
                            event.preventDefault()
                            event.stopPropagation()
                            cancel()
                          }
                        }}
                      />
                    </label>
                    {saveError && (
                      <p className="warning" role="alert">
                        {saveError}
                      </p>
                    )}
                    <footer>
                      <button type="button" className="button" onClick={cancel}>
                        Cancel
                      </button>
                      <button type="submit" className="button primary" disabled={!draft.trim()}>
                        Update
                      </button>
                    </footer>
                  </form>
                ) : (
                  <CommentCard
                    key={comment.id}
                    comment={comment}
                    currentRange={currentRange}
                    state={saving.get(comment.id)}
                    copied={copied === comment.id}
                    onCopy={onCopy}
                    onEdit={(item) => {
                      setEditing(item.id)
                      const saved = readDrafts(scope)[`panel:${item.id}`]
                      const body =
                        saved && saved.fingerprint === (fingerprints[item.path] ?? null)
                          ? saved.body
                          : item.body
                      setDraft(body)
                      persistDraft(item, body)
                      setSaveError('')
                    }}
                    onDelete={onDelete}
                    onRetry={onRetry}
                  >
                    <footer className="comment-navigation">
                      {canView(comment) ? (
                        <button className="link" type="button" onClick={() => onView(comment)}>
                          View in diff
                        </button>
                      ) : (
                        <span>Outside the current diff</span>
                      )}
                    </footer>
                  </CommentCard>
                ),
              )}
            </section>
          ))}
      </div>
    </dialog>
  )
}
