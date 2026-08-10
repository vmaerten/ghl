import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  getFiletypeFromFileName,
  isDiffAnnotation,
  parsePatchFiles,
  type CodeViewDiffItem,
  type CodeViewItem,
  type DiffLineAnnotation,
  type LineAnnotation,
  type SelectedLineRange,
} from '@pierre/diffs'
import { CodeView, useStableCallback, type CodeViewHandle } from '@pierre/diffs/react'

import RefSelector from './RefSelector.tsx'
import FileTree, { type FileTreeHandle, type TreeEntry } from './FileTree.tsx'
import Resizer, { storedWidth } from './Resizer.tsx'
import CommentThread, { type Composer, type SaveState } from './CommentThread.tsx'
import { asMarkdown } from '../../src/export.ts'
import { compareTreePaths } from './fileOrder.ts'
import type {
  BaseSource,
  Comment,
  DiffPayload,
  DiffSide,
  ServedComment,
  ViewedMap,
} from '../../src/types.ts'

/**
 * `CodeViewDiffItem` carries no path; we add one and read it back from our own
 * array, which the library ignores.
 */
type DiffItem = CodeViewDiffItem & { path: string }

/**
 * What the library hands a selection callback. `CodeViewDiffItemContext` is not
 * exported by any entry point, so this names the part we read.
 */
type SelectionContext = { item: CodeViewItem<undefined> }

/**
 * One annotation per (file, side, line): several comments on the same line share
 * a card.
 *
 * The library does stack annotations per line, but they all land in the first
 * `<slot>` of that name and `renderAnnotation` is not told which one it is
 * rendering — two annotations on a line would draw the same card twice.
 */
const threadKey = (path: string, side: DiffSide, line: number) =>
  // The one byte a path cannot hold, written as an escape rather than typed: a
  // literal NUL in the source makes git call the file binary, and this file's
  // diff stops being reviewable — in this repository of all places.
  `${path}\u0000${side}\u0000${line}`

/** The repo id lives in the path: /r/<repoId>. */
function repoIdFromLocation() {
  const match = window.location.pathname.match(/^\/r\/([^/]+)/)
  return match?.[1] ?? null
}

/** Well under the server's idle threshold, and cheap enough to be invisible. */
const HEARTBEAT_MS = 5 * 60_000

/** A fetch that never reached anything rejects with a TypeError, not an HTTP status. */
const NOT_LISTENING = 'ghl is no longer listening — run `ghl` again in that repository'

/** Shorter than the CLI's wording: this is a badge in a topbar, not a report. */
const BASE_SOURCES: Record<BaseSource, string> = {
  override: 'given on the command line',
  remembered: 'remembered',
  stack: 'from the stack',
  guessed: 'guessed',
  trunk: 'trunk',
}

export default function App() {
  const repoId = useMemo(repoIdFromLocation, [])
  const [data, setData] = useState<DiffPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>('unified')
  const [activeIndex, setActiveIndex] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  /** path -> hash of the diff section that was marked as read. */
  const [viewed, setViewedState] = useState<ViewedMap>({})
  const [picking, setPicking] = useState<'base' | 'target' | null>(null)
  const [comments, setComments] = useState<ServedComment[]>([])
  const [composer, setComposer] = useState<Composer | null>(null)
  /** Momentary, so the button can say the clipboard actually took it. */
  const [copied, setCopied] = useState(false)
  /** id -> how its last write went. Read while painting, so it is state. */
  const [saving, setSaving] = useState<Map<string, SaveState>>(new Map())
  /**
   * Comments the server has not confirmed, by id.
   *
   * A ref rather than state because `refresh()` has to merge them back in, and
   * depending on them would rebuild `refresh` and re-fire the effect that calls
   * it. Without this merge, an `r` between writing and saving loses the text.
   */
  const pendingRef = useRef(new Map<string, ServedComment>())
  const draftsRef = useRef(new Map<string, string>())
  /** Set by the gutter "+" so the selection that follows opens a composer. */
  const gutterRequestRef = useRef<SelectedLineRange | null>(null)
  /** Revision under review. null means the working tree of this checkout. */
  const [target, setTarget] = useState<string | null>(() =>
    new URLSearchParams(location.search).get('target'),
  )
  const viewRef = useRef<CodeViewHandle<undefined>>(null)
  /** Folding and revealing live inside the tree, which owns that state. */
  const treeRef = useRef<FileTreeHandle>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [sidebarWidth, setSidebarWidth] = useState(storedWidth)
  /**
   * What the sidebar is filtered on. Not persisted, unlike the width beside it:
   * a filter restored on load is a diff that looks half empty for no visible
   * reason.
   */
  const [filter, setFilter] = useState('')
  /** The files it kept, or null when there is none. Comes from the tree. */
  const [matches, setMatches] = useState<string[] | null>(null)
  const filterInputRef = useRef<HTMLInputElement>(null)

  /**
   * The single refresh path.
   *
   * Everything that reloads the diff goes through here — the R key now, a
   * watcher later, which is what keeps that a ten-line change.
   */
  const refresh = useCallback(async () => {
    if (!repoId) {
      setError('no repository in the URL (expected /r/<repoId>)')
      return
    }
    setRefreshing(true)
    try {
      const query = target ? `?target=${encodeURIComponent(target)}` : ''
      const response = await fetch(`/r/${repoId}/api/diff${query}`)
      const body: DiffPayload & { error?: string } = await response.json()
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      setData(body)
      // The server already dropped ticks whose file changed since.
      setViewedState(body.viewed ?? {})
      // Whatever the server has, plus what it has not been told yet: a comment
      // still in flight, or one whose write failed, must survive a refresh.
      const served = body.comments ?? []
      const unconfirmed = [...pendingRef.current.values()].filter(
        (pending) => !served.some((comment) => comment.id === pending.id),
      )
      setComments([...served, ...unconfirmed])
      setError(null)
    } catch (cause) {
      if (cause instanceof TypeError) setError(NOT_LISTENING)
      else setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRefreshing(false)
    }
  }, [repoId, target])

  useEffect(() => {
    refresh()
  }, [refresh])

  /**
   * Say we are still here, while we are still here.
   *
   * One process now serves every repository and stops on its own once nothing
   * watches it. Reading a long diff sends no request at all, so without this it
   * would stop under an open tab — the heartbeat is what makes the threshold
   * mean "no tab" rather than "no click".
   */
  useEffect(() => {
    const beat = () => {
      if (document.visibilityState === 'visible') fetch('/api/health').catch(() => {})
    }
    const timer = setInterval(beat, HEARTBEAT_MS)
    document.addEventListener('visibilitychange', beat)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', beat)
    }
  }, [])

  /** Review another revision. Kept in the URL so a reload stays on it. */
  const pickTarget = useCallback((ref: string | null) => {
    setPicking(null)
    setTarget(ref)
    const url = new URL(location.href)
    if (ref) url.searchParams.set('target', ref)
    else url.searchParams.delete('target')
    history.replaceState(null, '', url)
  }, [])

  /**
   * Every file in the diff, in the tree's order rather than the patch's.
   *
   * git sorts whole paths bytewise, the tree groups directories first, and the
   * two disagree from the first row — so `j`/`k` used to walk an order the eye
   * was not following. One rule now feeds both (see fileOrder.ts).
   */
  const allItems = useMemo((): DiffItem[] => {
    if (!data?.patch) return []
    return parsePatchFiles(data.patch, `${repoId}-${data.head.sha}`)
      .flatMap((patch) => patch.files ?? [])
      .map((fileDiff, index) => ({
        id: fileDiff.cacheKey ?? `file-${index}`,
        path: fileDiff.name,
        type: 'diff' as const,
        // A rename that changes the extension asks for the grammar of the *old*
        // name, which is never preloaded — the file then throws and renders as
        // nothing at all. Pinning the language to the new name is what the
        // result should be anyway, and it is the only side that is loaded.
        fileDiff:
          fileDiff.prevName &&
          getFiletypeFromFileName(fileDiff.prevName) !== getFiletypeFromFileName(fileDiff.name)
            ? { ...fileDiff, lang: getFiletypeFromFileName(fileDiff.name) }
            : fileDiff,
      }))
      .toSorted((left, right) => compareTreePaths(left.path, right.path))
  }, [data, repoId])

  /**
   * What CodeView renders: every file, the viewed ones folded shut.
   *
   * As GitHub does it. Removing them from the array instead — which is what this
   * used to do — changed the item list on every tick, and the pane rebuilds its
   * virtual window from scratch when that happens: the reader was thrown back to
   * the top of the diff each time, and a file clicked in the tree came back
   * somewhere they never saw. See decision 7 in PLAN.md for what it costs.
   */
  /** Comments grouped by the card that will show them, oldest first. */
  const threads = useMemo(() => {
    const map = new Map<string, ServedComment[]>()
    for (const comment of comments) {
      // On `end`: the annotation row is emitted after its line, so anchoring on
      // the last line of the range puts the card under the block, as GitHub does.
      const key = threadKey(comment.path, comment.side, comment.end)
      const thread = map.get(key)
      if (thread) thread.push(comment)
      else map.set(key, [comment])
    }
    for (const thread of map.values()) {
      thread.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    }
    return map
  }, [comments])

  /** Per file: the annotations to hand the pane, and a fingerprint of the set. */
  const annotations = useMemo(() => {
    const byPath = new Map<string, DiffLineAnnotation[]>()
    const add = (path: string, side: DiffSide, lineNumber: number) => {
      const list = byPath.get(path) ?? []
      if (!list.some((a) => a.side === side && a.lineNumber === lineNumber)) {
        list.push({ side, lineNumber })
      }
      byPath.set(path, list)
    }
    for (const thread of threads.values()) {
      const first = thread[0]
      if (first) add(first.path, first.side, first.end)
    }
    // An open composer is an annotation of its own: it is what makes the empty
    // card appear on a line that has no comment yet.
    if (composer) add(composer.path, composer.side, composer.end)

    const fingerprints = new Map<string, string>()
    for (const [path, list] of byPath) {
      // A stable order: the library keys the wrapper of each card by index, so a
      // set that reorders hands a mounted card — and the draft in it — to
      // another line instead of unmounting it.
      list.sort(
        (left, right) => left.lineNumber - right.lineNumber || (left.side < right.side ? -1 : 1),
      )
      fingerprints.set(path, list.map((a) => `${a.side[0]}${a.lineNumber}`).join(','))
    }
    return { byPath, fingerprints }
  }, [threads, composer])

  const versions = useRef(new Map<string, { key: string; version: number }>())
  const items = useMemo(
    () =>
      allItems.map((item) => {
        const collapsed = item.path in viewed
        // The pane re-reads an item only when its `version` moves; anything
        // reaching it *through* the item — `collapsed`, `annotations` — is
        // otherwise accepted and then ignored, silently, which is how a file
        // could be ticked and never fold.
        //
        // The fingerprint holds the anchors, not the bodies. Editing a body
        // therefore costs nothing here: only the identity of `renderAnnotation`
        // changes, and that re-renders the card alone.
        const key = `${collapsed ? 'c' : '-'} ${annotations.fingerprints.get(item.path) ?? ''}`
        const previous = versions.current.get(item.path)
        const version =
          previous === undefined || previous.key === key
            ? (previous?.version ?? 0)
            : previous.version + 1
        versions.current.set(item.path, { key, version })
        return { ...item, collapsed, version, annotations: annotations.byPath.get(item.path) }
      }),
    [allItems, viewed, annotations],
  )

  const stats = data?.totals ?? { files: 0, additions: 0, deletions: 0 }
  const viewedCount = Object.keys(viewed).length

  const untrackedSet = useMemo(() => new Set(data?.untracked ?? []), [data])

  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const comment of comments) {
      counts.set(comment.path, (counts.get(comment.path) ?? 0) + 1)
    }
    return counts
  }, [comments])

  /** Tree entries: every file, viewed or not, enriched with git's per-file counts. */
  const entries = useMemo((): TreeEntry[] => {
    const byPath = new Map((data?.files ?? []).map((f) => [f.path, f] as const))
    return allItems.map((item) => {
      const stat = byPath.get(item.path)
      return {
        id: item.id,
        path: item.path,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        binary: stat?.binary ?? false,
        // Untracked files never reach `git diff`, so they carry no status of
        // their own — the untracked list is the only place that knows.
        status: untrackedSet.has(item.path) ? 'untracked' : (stat?.status ?? 'modified'),
        // Membership, not truthiness: the stored hash is null for files git
        // reports without one, and that must still count as viewed.
        viewed: item.path in viewed,
        // A viewed file folds shut and takes its cards off screen with it, so
        // the tree is the only place left that says a comment is there.
        comments: commentCounts.get(item.path) ?? 0,
      }
    })
  }, [allItems, data, viewed, untrackedSet, commentCounts])

  const toggleViewed = useCallback(
    async (path: string, next: boolean) => {
      if (!data) return
      const hash = data.files.find((f) => f.path === path)?.hash ?? null
      // Optimistic: the diff pane reacts immediately, the write follows.
      setViewedState((current) => {
        const updated = { ...current }
        if (next) updated[path] = hash
        else delete updated[path]
        return updated
      })
      try {
        await fetch(`/r/${repoId}/api/viewed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ range: data.range, path, hash, viewed: next }),
        })
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        setError(`could not save viewed state: ${detail}`)
      }
    },
    [data, repoId],
  )

  const resetViewed = useCallback(async () => {
    if (!data) return
    setViewedState({})
    await fetch(`/r/${repoId}/api/viewed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ range: data.range, clear: true }),
    })
  }, [data, repoId])

  /**
   * Send a comment, and let the card carry the outcome.
   *
   * Deliberately not `toggleViewed`'s pattern of a banner above the page: losing
   * a tick costs a click, losing a sentence costs the sentence, and a global
   * banner never says *which* comment is missing from the export.
   */
  const save = useStableCallback(async (comment: ServedComment) => {
    pendingRef.current.set(comment.id, comment)
    setSaving((current) => new Map(current).set(comment.id, 'saving'))
    try {
      // The target travels with the write, as it does with the read: the server
      // rebuilds the patch to cut the anchor, and it has to be the same patch.
      const query = target ? `?target=${encodeURIComponent(target)}` : ''
      const response = await fetch(`/r/${repoId}/api/comments${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(comment),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body: { comment: ServedComment } = await response.json()
      pendingRef.current.delete(comment.id)
      // The server fills the anchor and keeps the original createdAt, so take
      // its version rather than leaving the optimistic one in place.
      setComments((current) => current.map((c) => (c.id === body.comment.id ? body.comment : c)))
      setSaving((current) => {
        const next = new Map(current)
        next.delete(comment.id)
        return next
      })
    } catch {
      setSaving((current) => new Map(current).set(comment.id, 'failed'))
    }
  })

  const submitComment = useStableCallback((body: string) => {
    if (!composer || !data) return
    const existing = composer.editing
      ? comments.find((comment) => comment.id === composer.editing)
      : undefined
    const comment: ServedComment = {
      // Written against what is on screen, so it describes it by construction.
      // The server decides otherwise on the next read, never here.
      stale: false,
      // Optimistic and therefore unknown until the server answers: it cuts the
      // lines from the patch, and this side has no business guessing them.
      code: existing?.code ?? [],
      // From here, not from the server: a save retried after having in fact
      // succeeded then rewrites its own entry instead of adding a second one.
      id: composer.editing ?? crypto.randomUUID(),
      path: composer.path,
      side: composer.side,
      start: composer.start,
      end: composer.end,
      body,
      anchor: existing?.anchor ?? [],
      range: data.range,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }
    setComments((current) =>
      current.some((c) => c.id === comment.id)
        ? current.map((c) => (c.id === comment.id ? comment : c))
        : [...current, comment],
    )
    draftsRef.current.delete(`${composer.key}:${composer.editing ?? 'new'}`)
    // Saving releases the lines too, or the second remark of a review reopens on
    // the line the first one was written on.
    setComposer(null)
    viewRef.current?.clearSelectedLines()
    save(comment)
  })

  const deleteComment = useStableCallback(async (id: string) => {
    setComments((current) => current.filter((comment) => comment.id !== id))
    pendingRef.current.delete(id)
    try {
      await fetch(`/r/${repoId}/api/comments?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    } catch (cause) {
      setError(`could not delete the comment: ${cause instanceof Error ? cause.message : cause}`)
    }
  })

  /** Open a composer on a selected range, from the gutter or from `c`. */
  const openComposer = useStableCallback((path: string, range: SelectedLineRange) => {
    const side = (range.endSide ?? range.side ?? 'additions') as DiffSide
    // Dragged across the two columns of a split view, the ends count in
    // different files: keep the line the gesture finished on rather than store a
    // range whose bounds do not share a coordinate system.
    const crossed =
      range.side !== undefined && range.endSide !== undefined && range.side !== range.endSide
    const start = crossed ? range.end : Math.min(range.start, range.end)
    const end = crossed ? range.end : Math.max(range.start, range.end)
    setComposer({ key: threadKey(path, side, end), path, side, start, end, editing: null })
  })

  const editComment = useStableCallback((comment: Comment) => {
    const key = threadKey(comment.path, comment.side, comment.end)
    draftsRef.current.set(`${key}:${comment.id}`, comment.body)
    setComposer({
      key,
      path: comment.path,
      side: comment.side,
      start: comment.start,
      end: comment.end,
      editing: comment.id,
    })
  })

  /**
   * Close the composer, and let go of the lines it was opened on.
   *
   * Both halves, always. While a selection stands, the library pins the gutter
   * "+" to the bottom of it instead of letting it follow the pointer — so a
   * composer merely closed leaves the button stuck on the line just abandoned,
   * and every later click reopens that same line. There is no way out of it from
   * the page, which is what made it look like the diff had stopped responding.
   */
  const closeComposer = useStableCallback(() => {
    setComposer(null)
    viewRef.current?.clearSelectedLines()
  })

  /**
   * Put the whole review on the clipboard, as markdown.
   *
   * `asMarkdown` is the CLI's too, so the button and `ghl comments` cannot
   * produce different text for the same review. Failing to reach the clipboard is
   * said out loud: the point of the gesture is that the text left the page.
   */
  const copyComments = useStableCallback(async () => {
    if (!data) return
    try {
      await navigator.clipboard.writeText(asMarkdown(comments, { range: data.range }))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (cause) {
      setError(`could not copy: ${cause instanceof Error ? cause.message : cause}`)
    }
  })

  /** Remember the chosen base for this branch, then reload against it. */
  const pickBase = useCallback(
    async (base: string | null) => {
      setPicking(null)
      if (!base || base === data?.base?.ref) return
      await fetch(`/r/${repoId}/api/base`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ base, target }),
      })
      await refresh()
    },
    [data, repoId, refresh, target],
  )

  /** Where the cursor may land: every item, or the ones the filter kept. */
  const navigable = useMemo(() => {
    if (!matches) return null
    const kept = new Set(matches)
    return items.flatMap((item, index) => (kept.has(item.path) ? [index] : []))
  }, [items, matches])

  /**
   * The next file in that direction — not `activeIndex ± 1`, so the cursor stays
   * on a row the sidebar is showing. Setting a filter does not move it (that
   * would scroll the pane on every keystroke), so the first step is what enters
   * the subset.
   */
  const step = useCallback(
    (direction: 1 | -1) => {
      if (!navigable) return activeIndex + direction
      const next =
        direction === 1
          ? navigable.find((index) => index > activeIndex)
          : navigable.findLast((index) => index < activeIndex)
      return next ?? activeIndex
    },
    [navigable, activeIndex],
  )

  /** Navigation walks the rendered items — what is left to read. */
  const goTo = useCallback(
    (index: number) => {
      const bounded = Math.max(0, Math.min(index, items.length - 1))
      // Not `target`: that name already means the revision under review.
      const item = items[bounded]
      if (!item) return
      setActiveIndex(bounded)

      // The tree folds directories, so ask it to bring the file back into view
      // rather than moving the selection somewhere invisible.
      treeRef.current?.reveal(item.path)
      viewRef.current?.scrollTo({ type: 'item', id: item.id, align: 'start' })
    },
    [items],
  )

  /** Every file is in the list now, viewed or not, so a click always lands. */
  const selectByPath = useCallback(
    (path: string) => goTo(items.findIndex((item) => item.path === path)),
    [items, goTo],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Never steal keys from an input or from a browser shortcut.
      // Not `target`: that name already means the revision under review.
      const focused = event.target
      const tag = focused instanceof HTMLElement ? focused.tagName : null
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (focused instanceof HTMLElement && focused.isContentEditable) return
      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (picking) return // the picker owns the keyboard while open
      // And so does the composer. The guard above only covers a focused field,
      // and the pane hands focus back to its own root whenever it re-renders an
      // item — so a composer can be open with the focus nowhere near it.
      if (composer) return

      if (event.key === 'b') setPicking('base')
      else if (event.key === 't') setPicking('target')
      else if (event.key === 'j') goTo(step(1))
      else if (event.key === 'k') goTo(step(-1))
      else if (event.key === 'r' || event.key === 'R') refresh()
      else if (event.key === '/') {
        // Selected, not merely focused: `/` over a filter already in force is a
        // second thought, and typing straight over it is the shortest way to say so.
        filterInputRef.current?.focus()
        filterInputRef.current?.select()
      } else if (event.key === 'c') {
        // The selection, not the file under `j`/`k`: a comment is about the lines
        // that were picked, which may be in a file the cursor is not on.
        const selection = viewRef.current?.getSelectedLines()
        if (!selection) return
        const path = items.find((item) => item.id === selection.id)?.path
        if (!path) return
        openComposer(path, selection.range)
      } else if (event.key === 'v') {
        const current = items[activeIndex]
        if (current) toggleViewed(current.path, !(current.path in viewed))
      } else return

      event.preventDefault()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    activeIndex,
    goTo,
    step,
    refresh,
    items,
    viewed,
    toggleViewed,
    picking,
    composer,
    openComposer,
  ])

  const resizeSidebar = useCallback((width: number) => {
    setSidebarWidth(width)
    localStorage.setItem('ghl.sidebarWidth', String(width))
  }, [])

  /**
   * The gutter "+" reports a range but not which file it is in.
   *
   * `onGutterUtilityClick` takes the range alone, and it fires *before* the
   * selection is committed, so reading the handle at that moment gives the
   * previous selection. The range is kept here and claimed by the selection
   * callback below, which is handed the item — the two run back to back in the
   * same pointerup.
   */
  const onGutterUtilityClick = useStableCallback((range: SelectedLineRange) => {
    gutterRequestRef.current = { ...range }
  })

  const onLineSelectionEnd = useStableCallback(
    (_range: SelectedLineRange | null, context: SelectionContext) => {
      const requested = gutterRequestRef.current
      gutterRequestRef.current = null
      // Only the gutter opens a composer here: a plain drag selects, and `c` is
      // what turns a selection into a comment.
      if (!requested || context.item.type !== 'diff') return
      openComposer(context.item.fileDiff.name, requested)
    },
  )

  const options = useMemo(
    () => ({
      diffStyle,
      theme: 'github-dark' as const,
      stickyHeaders: true,
      // Both gutter APIs are declared mutually exclusive and the library throws
      // on the pair, so this is the native "+" button, not a rendered one.
      // Setting the handler is also what enables dragging on the gutter.
      enableGutterUtility: true,
      onGutterUtilityClick,
      enableLineSelection: true,
      onLineSelectionEnd,
    }),
    [diffStyle, onGutterUtilityClick, onLineSelectionEnd],
  )

  /**
   * The card under a commented line: the whole thread, plus its composer.
   *
   * Not stabilised behind a ref, and not carried in the annotation's `metadata`
   * either. `metadata` comes from the item snapshot the pane refreshes only when
   * `version` moves, so a body edited without bumping it would render stale —
   * the same trap as `renderHeaderMetadata` above, one level down.
   */
  const renderAnnotation = useCallback(
    (annotation: LineAnnotation | DiffLineAnnotation, item: CodeViewItem<undefined>) => {
      if (item.type !== 'diff' || !isDiffAnnotation(annotation)) return null
      const key = threadKey(item.fileDiff.name, annotation.side, annotation.lineNumber)
      const thread = threads.get(key)
      const composing = composer?.key === key ? composer : null
      if (!thread && !composing) return null
      return (
        <CommentThread
          key={key}
          comments={thread ?? []}
          composing={composing}
          currentRange={data?.range ?? ''}
          saving={saving}
          drafts={draftsRef}
          onSubmit={submitComment}
          onCancel={closeComposer}
          onEdit={editComment}
          onDelete={deleteComment}
          onRetry={save}
        />
      )
    },
    [
      threads,
      composer,
      data?.range,
      saving,
      submitComment,
      closeComposer,
      editComment,
      deleteComment,
      save,
    ],
  )

  /**
   * The Viewed control lives in the library's own file header.
   *
   * It has to be rebuilt when `viewed` changes. Holding it stable and reading
   * through refs keeps the pane from rebuilding, but the header is then never
   * rendered again: the box never ticks, and un-viewing from it is impossible
   * because the handler still closes over the value it was built with.
   */
  const renderHeaderMetadata = useCallback(
    (item: CodeViewItem<undefined>) => {
      const path = item.type === 'diff' ? item.fileDiff.name : null
      if (!path) return null
      const isViewed = path in viewed
      return (
        <label className="viewed-toggle" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={isViewed}
            onChange={() => toggleViewed(path, !isViewed)}
          />
          Viewed
        </label>
      )
    },
    [viewed, toggleViewed],
  )

  const baseSource = data ? BASE_SOURCES[data.base.source] : null

  const activePath = items[activeIndex]?.path
  const stack = data?.base.stack ?? null

  return (
    <div className="app">
      <header className="topbar">
        <div className="revision">
          <span className="base-anchor">
            <button
              type="button"
              className="ref base"
              onClick={() => setPicking((p) => (p === 'base' ? null : 'base'))}
              title="Change the base (b)"
              aria-expanded={picking === 'base'}
              disabled={!data}
            >
              {data?.base?.ref ?? '…'} <span className="caret">▾</span>
            </button>

            {picking === 'base' && data && (
              <RefSelector
                repoId={repoId}
                current={data.base.ref}
                source={data.base.source}
                onPick={pickBase}
                onClose={() => setPicking(null)}
              />
            )}
          </span>

          <span className="arrow">→</span>

          <span className="base-anchor">
            <button
              type="button"
              className="ref target"
              onClick={() => setPicking((p) => (p === 'target' ? null : 'target'))}
              title="Review another revision (t)"
              aria-expanded={picking === 'target'}
              disabled={!data}
            >
              {data?.target?.ref ?? 'HEAD'} <span className="caret">▾</span>
            </button>

            {picking === 'target' && data && (
              <RefSelector
                repoId={repoId}
                current={data.target.ref}
                source={data.target.workingTree ? 'working tree' : 'ref'}
                extra={{
                  value: '__working_tree__ this checkout working tree',
                  label: 'This checkout (working tree)',
                  hint: 'uncommitted work included',
                  pick: null,
                }}
                onPick={pickTarget}
                onClose={() => setPicking(null)}
              />
            )}
          </span>

          {baseSource && <span className="source">base {baseSource}</span>}
          {data && !data.target.workingTree && (
            <span className="source">reviewing a ref, working tree excluded</span>
          )}
        </div>

        {data && (
          <span className="stats">
            {stats.files} files <span className="add">+{stats.additions}</span>{' '}
            <span className="del">−{stats.deletions}</span>
          </span>
        )}

        <span className="spacer" />

        <span className="hint">
          <kbd>b</kbd> base · <kbd>j</kbd>
          <kbd>k</kbd> files · <kbd>v</kbd> viewed · <kbd>c</kbd> comment · <kbd>r</kbd> refresh
        </span>

        <button type="button" className="refresh" onClick={refresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>

        <div className="toggle">
          <button
            type="button"
            aria-pressed={diffStyle === 'unified'}
            onClick={() => setDiffStyle('unified')}
          >
            Unified
          </button>
          <button
            type="button"
            aria-pressed={diffStyle === 'split'}
            onClick={() => setDiffStyle('split')}
          >
            Split
          </button>
        </div>

        {/* Last child, and full width: the topbar wraps, so the chain gets a row
            of its own without any of the controls above it moving. */}
        {stack && (
          <nav className="stack" aria-label="Stack">
            <span>{stack.trunk}</span>
            {stack.layers.map((layer, index) => (
              <span
                key={layer.branch}
                className={`stack-layer${index === stack.current ? ' current' : ''}${
                  layer.merged ? ' merged' : ''
                }`}
              >
                <span className="arrow">→</span>
                <button
                  type="button"
                  className="ref stack-name"
                  aria-current={index === stack.current ? 'true' : undefined}
                  disabled={!layer.exists}
                  title={
                    layer.exists
                      ? `Review ${layer.branch} against ${layer.base}`
                      : `${layer.branch} is gone from this checkout`
                  }
                  // The checked-out branch goes through the working tree rather
                  // than its own ref, or uncommitted work drops out of the diff.
                  onClick={() =>
                    pickTarget(layer.branch === data?.head.branch ? null : layer.branch)
                  }
                >
                  {layer.branch}
                </button>
                {layer.pr && (
                  <a
                    className="stack-pr"
                    href={layer.pr.url}
                    target="_blank"
                    rel="noreferrer"
                    title={`Pull request #${layer.pr.number} on GitHub`}
                  >
                    #{layer.pr.number}
                  </a>
                )}
                {layer.merged && <span className="badge">merged</span>}
              </span>
            ))}
          </nav>
        )}
      </header>

      {data?.notice && <div className="warning">{data.notice}</div>}

      {data?.state?.operation && (
        <div className="warning">
          {data.state.operation} in progress — {data.state.conflicted.length} conflicted file(s).
          This diff may not mean what you expect.
        </div>
      )}

      {data && data.untracked.length > 0 && !data.untrackedIncluded && (
        <div className="warning">
          {data.untracked.length} untracked file(s) hidden. Run with <code>--untracked</code> to
          include them.
        </div>
      )}

      {error && <p className="message">{error}</p>}

      {!error && data && allItems.length === 0 && (
        <p className="message">
          Nothing to show — <code>{data.head.branch}</code> matches <code>{data.base.ref}</code>.
        </p>
      )}

      {allItems.length > 0 && (
        <div
          className="body"
          ref={bodyRef}
          style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
        >
          {/* A query nothing answers filters nothing, and the whole tree comes
              back under the words "no file matches" (§5 of PLAN.md). Hence the
              class — hiding the rows, never unmounting the tree, which holds the
              model and every fold. */}
          <aside className={matches?.length === 0 ? 'sidebar filtered-empty' : 'sidebar'}>
            <div className="sidebar-head">
              <span>
                {viewedCount > 0
                  ? `${viewedCount}/${entries.length} viewed`
                  : `${entries.length} files`}
              </span>
              <span className="spacer" />
              {/* The end of a review: the remarks go somewhere they can be acted
                  on. Same markdown `ghl comments` writes, from the same function. */}
              {comments.length > 0 && (
                <button
                  type="button"
                  onClick={copyComments}
                  title={`Copy ${comments.length} comment(s) as markdown`}
                >
                  {copied ? 'Copied' : `Copy ✎${comments.length}`}
                </button>
              )}
              {viewedCount > 0 && (
                <button type="button" onClick={resetViewed} title="Unmark every file">
                  Reset
                </button>
              )}
              <button type="button" onClick={() => treeRef.current?.collapseAll()}>
                Collapse all
              </button>
              <button type="button" onClick={() => treeRef.current?.expandAll()}>
                Expand all
              </button>
            </div>

            {/* Ours, in the light DOM, rather than the tree's own — decision 6d.
                The INPUT guard on the keyboard handler covers this one for free. */}
            <div className="tree-filter">
              <input
                ref={filterInputRef}
                type="text"
                value={filter}
                placeholder="Filter files (/)"
                aria-label="Filter files"
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  // Both hand the keyboard back, or the next `j` is typed in here.
                  // Enter keeps the query — the only way to walk what it just kept.
                  if (event.key === 'Escape') setFilter('')
                  else if (event.key !== 'Enter') return
                  event.currentTarget.blur()
                }}
              />
              {matches && (
                <span className="count">
                  {matches.length}/{entries.length}
                </span>
              )}
              {filter.length > 0 && (
                <button type="button" onClick={() => setFilter('')} title="Clear the filter">
                  ✕
                </button>
              )}
            </div>

            {matches?.length === 0 && <p className="tree-empty">No file matches.</p>}

            <FileTree
              ref={treeRef}
              entries={entries}
              activePath={activePath}
              onSelect={selectByPath}
              filter={filter}
              onMatches={setMatches}
            />
          </aside>

          <Resizer containerRef={bodyRef} onCommit={resizeSidebar} />

          {/* CodeView owns its scrolling. The style lands on its own scroller, so it
              needs both a real height (or it measures 0 and mounts nothing) and
              `overflowY: auto` — it only recomputes the virtual window from the
              element it scrolls itself, never from an ancestor.

              Nothing conditional above it inside `.diff`: a sibling appearing or
              disappearing shifts CodeView's position among its parent's children,
              and React remounts it — losing the scroll along with it. */}
          <div className="diff">
            <CodeView
              ref={viewRef}
              items={items}
              options={options}
              renderHeaderMetadata={renderHeaderMetadata}
              renderAnnotation={renderAnnotation}
              style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
