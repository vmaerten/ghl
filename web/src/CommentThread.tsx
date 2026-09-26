import { useRef, type RefObject } from 'react'

import type { Comment, ServedComment } from '../../src/types.ts'
import type { SaveState } from './commentPersistence.ts'
import CommentCard, { lineLabel } from './CommentCard.tsx'

/** Where a comment is being written, or which one is being rewritten. */
export interface Composer {
  /** The annotation this belongs to: path, side and anchor line. */
  key: string
  path: string
  side: 'deletions' | 'additions'
  start: number
  end: number
  /** Id of the comment being edited, or null when writing a new one. */
  editing: string | null
}

interface Props {
  comments: ServedComment[]
  copied: string | null
  onCopy: (comment: ServedComment) => void
  composing: Composer | null
  /** What the diff on screen compares, to spot comments written against another. */
  currentRange: string
  saving: Map<string, SaveState>
  /**
   * Drafts, held outside this component on purpose.
   *
   * The pane drops an item's element once it leaves the virtual window, which
   * unmounts this card — a draft kept in its own state would be lost to a scroll.
   */
  drafts: RefObject<Map<string, string>>
  onDraft: (body: string) => void
  onSubmit: (body: string) => void
  onCancel: () => void
  onEdit: (comment: Comment) => void
  onDelete: (id: string) => void
  onRetry: (comment: ServedComment) => void
}

export default function CommentThread({
  comments,
  copied,
  onCopy,
  composing,
  currentRange,
  saving,
  drafts,
  onDraft,
  onSubmit,
  onCancel,
  onEdit,
  onDelete,
  onRetry,
}: Props) {
  const area = useRef<HTMLTextAreaElement>(null)
  const draftKey = composing ? `${composing.key}:${composing.editing ?? 'new'}` : ''

  const submit = () => {
    const body = area.current?.value.trim() ?? ''
    if (body) onSubmit(body)
  }

  return (
    <div className="comment-thread">
      {comments.map((comment) => {
        if (composing?.editing === comment.id) return null
        return (
          <CommentCard
            key={comment.id}
            comment={comment}
            currentRange={currentRange}
            state={saving.get(comment.id)}
            copied={copied === comment.id}
            onCopy={onCopy}
            onEdit={onEdit}
            onDelete={onDelete}
            onRetry={onRetry}
          />
        )
      })}

      {composing && (
        <div className="comment-composer">
          <label>
            <span className="comment-lines">{lineLabel(composing.start, composing.end)}</span>
            <textarea
              // Keyed by target: remounting is what re-reads defaultValue, so an
              // uncontrolled field follows the composer from one line to the next.
              key={draftKey}
              ref={area}
              rows={4}
              autoFocus
              placeholder="What should change here?"
              defaultValue={drafts.current?.get(draftKey) ?? ''}
              // Into the ref, not into state: a keystroke must not re-render the
              // application, and the pane re-measures items only on its own passes.
              onChange={(event) => {
                drafts.current?.set(draftKey, event.target.value)
                onDraft(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  // The global handler treats Escape as nothing, but the picker
                  // pattern is to stop it here rather than rely on that.
                  event.stopPropagation()
                  onCancel()
                } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  submit()
                }
              }}
            />
          </label>
          <footer>
            <span className="hint">
              <kbd>⌘</kbd>
              <kbd>↵</kbd> save · <kbd>esc</kbd> cancel
            </span>
            <span className="spacer" />
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submit}>
              {composing.editing ? 'Update' : 'Comment'}
            </button>
          </footer>
        </div>
      )}
    </div>
  )
}
