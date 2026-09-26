import { writeRequest } from './reviewSession.ts'
import { useMemo, useSyncExternalStore } from 'react'

import type { Comment, ServedComment } from '../../src/types.ts'

export type SaveState = 'saving' | 'failed'
export type CommentSubmission = Pick<Comment, 'path' | 'side' | 'start' | 'end' | 'body'> & {
  editing: string | null
}

interface CommentTransport {
  save: (comment: ServedComment, query: string, editing: boolean) => Promise<ServedComment>
  remove: (id: string) => Promise<void>
}

interface PendingSave {
  kind: 'save'
  comment: ServedComment
  query: string
  editing: boolean
  status: SaveState | null
  changedAt: number
}

interface PendingDelete {
  kind: 'delete'
  comment: null
  status: 'saving' | null
  changedAt: number
}

/** Own optimistic text, write ordering and refresh reconciliation for one repository. */
export function createCommentPersistence(transport: CommentTransport) {
  let served: ServedComment[] = []
  let clock = 0
  let readVersion = 0
  let snapshot: { comments: ServedComment[]; saving: Map<string, SaveState> } = {
    comments: [],
    saving: new Map(),
  }
  const local = new Map<string, PendingSave | PendingDelete>()
  const writes = new Map<string, Promise<void>>()
  const persisted = new Set<string>()
  const listeners = new Set<() => void>()

  const publish = () => {
    const comments = new Map(served.map((comment) => [comment.id, comment]))
    const saving = new Map<string, SaveState>()
    for (const [id, entry] of local) {
      if (entry.comment) {
        comments.set(id, entry.comment)
        if (entry.status) saving.set(id, entry.status)
      } else comments.delete(id)
    }
    snapshot = { comments: [...comments.values()], saving }
    for (const listener of listeners) listener()
  }

  // Serialize only writes to the same comment; unrelated comments remain independent.
  const enqueue = (id: string, operation: () => Promise<void>) => {
    const task = (writes.get(id) ?? Promise.resolve()).then(operation)
    const tail = task.catch(() => {})
    writes.set(id, tail)
    void tail.then(() => {
      if (writes.get(id) === tail) writes.delete(id)
      return undefined
    })
    return task
  }

  const save = (comment: ServedComment, query: string, editing = false) => {
    const entry: PendingSave = {
      kind: 'save',
      comment,
      query,
      editing,
      status: 'saving',
      changedAt: ++clock,
    }
    local.set(comment.id, entry)
    publish()
    return enqueue(comment.id, async () => {
      try {
        // A queued edit can follow a failed creation. It still needs to create
        // the comment; PATCH is only valid once the server has acknowledged it.
        entry.editing = editing && persisted.has(comment.id)
        entry.comment = await transport.save(comment, query, entry.editing)
        persisted.add(comment.id)
        entry.status = null
      } catch {
        entry.status = 'failed'
      }
      entry.changedAt = ++clock
      if (local.get(comment.id) === entry) publish()
    })
  }

  return {
    settle: async (retry = false) => {
      while (writes.size) await Promise.all(writes.values())
      const entries = [...local.values()]
      if (retry)
        for (const entry of entries) {
          if (entry.kind === 'save' && entry.status === 'failed')
            await save(entry.comment, entry.query, entry.editing)
        }
      if ([...local.values()].some((entry) => entry.status === 'failed'))
        throw new Error('Comments could not be saved. Retry before switching repositories.')
    },
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    // Capture when the read began, not when its response arrived: a stale read
    // must not overwrite a write that completed while it was in flight.
    refresh: () => {
      const startedAt = clock
      const version = ++readVersion
      return (comments: ServedComment[]) => {
        if (version !== readVersion) return
        served = comments
        for (const comment of comments) persisted.add(comment.id)
        for (const [id, entry] of local) {
          if (entry.status === null && entry.changedAt <= startedAt) local.delete(id)
        }
        publish()
      }
    },
    submit: (draft: CommentSubmission, { range, query }: { range: string; query: string }) => {
      const existing = snapshot.comments.find((comment) => comment.id === draft.editing)
      return save(
        {
          id: draft.editing ?? crypto.randomUUID(),
          path: draft.path,
          side: draft.side,
          start: draft.start,
          end: draft.end,
          body: draft.body,
          range: existing?.range ?? range,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          anchor: existing?.anchor ?? [],
          code: existing?.code ?? [],
          stale: existing?.stale ?? false,
        },
        query,
        draft.editing !== null,
      )
    },
    retry: (id: string) => {
      const entry = local.get(id)
      // Keep the comparison on which the text was written, even after navigation.
      if (entry?.kind === 'save' && entry.status === 'failed')
        return save(entry.comment, entry.query, entry.editing)
      return Promise.resolve()
    },
    remove: (id: string) => {
      const comment = snapshot.comments.find((item) => item.id === id)
      if (!comment) return Promise.resolve()
      const previous = local.get(id)
      const entry: PendingDelete = {
        kind: 'delete',
        comment: null,
        status: 'saving',
        changedAt: ++clock,
      }
      local.set(id, entry)
      publish()
      return enqueue(id, async () => {
        try {
          await transport.remove(id)
          entry.status = null
          entry.changedAt = ++clock
        } catch (error) {
          if (local.get(id) === entry) {
            // A preceding save may have settled while this delete was queued.
            const restored: PendingSave =
              previous?.kind === 'save'
                ? previous
                : {
                    kind: 'save',
                    comment,
                    query: '',
                    editing: true,
                    status: null,
                    changedAt: 0,
                  }
            restored.changedAt = ++clock
            local.set(id, restored)
            publish()
          }
          throw error
        }
        if (local.get(id) === entry) publish()
      })
    },
  }
}

export function useCommentPersistence(repoId: string | null) {
  const persistence = useMemo(
    () =>
      createCommentPersistence({
        save: async (comment, query, editing) => {
          const response = await writeRequest(`/r/${repoId}/api/comments${query}`, {
            method: editing ? 'PATCH' : 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(comment),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body: { comment: ServedComment } = await response.json()
          return body.comment
        },
        remove: async (id) => {
          const response = await writeRequest(
            `/r/${repoId}/api/comments?id=${encodeURIComponent(id)}`,
            {
              method: 'DELETE',
            },
          )
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
        },
      }),
    [repoId],
  )
  return [
    useSyncExternalStore(persistence.subscribe, persistence.getSnapshot),
    persistence,
  ] as const
}
