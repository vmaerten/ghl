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
import CommitSelector from './CommitSelector.tsx'
import FileTree, { type FileTreeHandle, type TreeEntry } from './FileTree.tsx'
import Resizer, { storedWidth } from './Resizer.tsx'
import CommentThread, { type Composer, type SaveState } from './CommentThread.tsx'
import { searchDiff } from './diffSearch.ts'
import { asMarkdown } from '../../src/export.ts'
import { treeOrder } from './fileOrder.ts'
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
  const [picking, setPicking] = useState<'base' | 'target' | 'commit' | null>(null)
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
  /** One commit of that range, or null for all of them. */
  const [commit, setCommit] = useState<string | null>(() =>
    new URLSearchParams(location.search).get('commit'),
  )
  /** True while the diff stops at HEAD, leaving uncommitted work out. */
  const [committed, setCommitted] = useState(() =>
    new URLSearchParams(location.search).has('committed'),
  )
  /**
   * True while untracked files are part of the diff rather than merely listed.
   *
   * Not `untracked`: `data.untracked` is the list of their paths, and two names
   * that close three lines apart on different types is a trap for free.
   */
  const [withUntracked, setWithUntracked] = useState(() =>
    new URLSearchParams(location.search).has('untracked'),
  )
  /**
   * Generated files stay in the canonical patch but leave the rendered review
   * by default. Unlike the five values in `query`, this is presentation state:
   * changing it must not fetch the same diff again.
   */
  const [showGenerated, setShowGenerated] = useState(() =>
    new URLSearchParams(location.search).has('generated'),
  )
  /**
   * A base forced from the command line, until something is picked here.
   *
   * Held rather than ignored: the server has no memory of it, so a parameter we
   * stop sending is a base we stop forcing — which is how picking one takes
   * effect in the session that picked it (#55).
   */
  const [baseOverride, setBaseOverride] = useState<string | null>(() =>
    new URLSearchParams(location.search).get('base'),
  )
  const viewRef = useRef<CodeViewHandle<undefined>>(null)
  /** Folding and revealing live inside the tree, which owns that state. */
  const treeRef = useRef<FileTreeHandle>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [sidebarWidth, setSidebarWidth] = useState(storedWidth)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const selectionBeforeSearchRef = useRef<{
    id: string
    range: SelectedLineRange
  } | null>(null)

  /**
   * What the server needs to build the diff this page is showing.
   *
   * One string for every call that has to agree with the view — the read, and
   * the comment write whose anchor is cut from the same patch.
   */
  const query = useMemo(() => {
    const params = new URLSearchParams()
    if (baseOverride) params.set('base', baseOverride)
    if (target) params.set('target', target)
    if (commit) params.set('commit', commit)
    if (committed) params.set('committed', '1')
    if (withUntracked) params.set('untracked', '1')
    return params.size > 0 ? `?${params}` : ''
  }, [baseOverride, target, commit, committed, withUntracked])

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
  }, [repoId, query])

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
    // Another revision is another history: the commit belonged to the old one.
    url.searchParams.delete('commit')
    setCommit(null)
    history.replaceState(null, '', url)
  }, [])

  /** Take the uncommitted work out of the diff, or put it back. */
  const toggleCommitted = useCallback(() => {
    setCommitted((on) => {
      const url = new URL(location.href)
      if (on) url.searchParams.delete('committed')
      else url.searchParams.set('committed', '1')
      history.replaceState(null, '', url)
      return !on
    })
  }, [])

  /** Put the untracked files in the diff, or take them back out. */
  const toggleUntracked = useCallback(() => {
    setWithUntracked((on) => {
      const url = new URL(location.href)
      if (on) url.searchParams.delete('untracked')
      else url.searchParams.set('untracked', '1')
      history.replaceState(null, '', url)
      return !on
    })
  }, [])

  /** Narrow to one commit, or back to the whole range. Also kept in the URL. */
  const pickCommit = useCallback((sha: string | null) => {
    setPicking(null)
    setCommit(sha)
    const url = new URL(location.href)
    if (sha) url.searchParams.set('commit', sha)
    else url.searchParams.delete('commit')
    history.replaceState(null, '', url)
  }, [])

  /**
   * Every file in the diff, in the tree's order rather than the patch's.
   *
   * git sorts whole paths bytewise, the tree groups directories first, and the
   * two disagree from the first row — so `j`/`k` used to walk an order the eye
   * was not following. The order is the tree's own, asked for (see fileOrder.ts).
   */
  const allItems = useMemo((): DiffItem[] => {
    if (!data?.patch) return []
    // The range is in the key, not only the head sha: the library caches
    // highlighting under it and warns that content changing under one key is
    // the caller's problem. Two views of the same checkout share a head sha —
    // the branch and one of its commits — and the second was served rows
    // highlighted for the first.
    const files = parsePatchFiles(data.patch, `${repoId}-${data.head.sha}-${data.range}`)
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
    const order = treeOrder(files.map((file) => file.path))
    return files.toSorted(
      (left, right) => (order.get(left.path) ?? 0) - (order.get(right.path) ?? 0),
    )
  }, [data, repoId])

  const generatedPaths = useMemo(
    () => new Set((data?.files ?? []).filter((file) => file.generated).map((file) => file.path)),
    [data],
  )

  /**
   * One list for every part of the review the reader can navigate.
   *
   * Generated sections are removed rather than passed as `collapsed`: hundreds
   * of short collapsed headers saturate CodeView's virtual window and cost more
   * than rendering the useful files alone. The full patch remains in `data`.
   */
  const visibleItems = useMemo(
    () => (showGenerated ? allItems : allItems.filter((item) => !generatedPaths.has(item.path))),
    [allItems, generatedPaths, showGenerated],
  )

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
      visibleItems.map((item) => {
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
    [visibleItems, viewed, annotations],
  )

  const stats = data?.totals ?? { files: 0, additions: 0, deletions: 0 }
  const viewedCount = visibleItems.reduce((count, item) => count + Number(item.path in viewed), 0)
  const storedViewedCount = Object.keys(viewed).length

  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const comment of comments) {
      counts.set(comment.path, (counts.get(comment.path) ?? 0) + 1)
    }
    return counts
  }, [comments])

  const generatedCommentCount = useMemo(() => {
    let count = 0
    for (const path of generatedPaths) count += commentCounts.get(path) ?? 0
    return count
  }, [generatedPaths, commentCounts])

  const generatedViewedCount = useMemo(() => {
    let count = 0
    for (const path of generatedPaths) count += Number(path in viewed)
    return count
  }, [generatedPaths, viewed])

  /** Tree entries: every visible file, enriched with git's per-file counts. */
  const entries = useMemo((): TreeEntry[] => {
    const byPath = new Map((data?.files ?? []).map((f) => [f.path, f] as const))
    return visibleItems.map((item) => {
      const stat = byPath.get(item.path)
      return {
        id: item.id,
        path: item.path,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        binary: stat?.binary ?? false,
        status: stat?.status ?? 'modified',
        // Membership, not truthiness: the stored hash is null for files git
        // reports without one, and that must still count as viewed.
        viewed: item.path in viewed,
        // A viewed file folds shut and takes its cards off screen with it, so
        // the tree is the only place left that says a comment is there.
        comments: commentCounts.get(item.path) ?? 0,
      }
    })
  }, [visibleItems, data, viewed, commentCounts])

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
      // The same query as the read: the server rebuilds the patch to cut the
      // anchor, and it has to be the patch this remark was written on.
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
   * Reveal or remove every generated section without refetching the patch.
   *
   * Keep the current path selected when it exists on both sides of the toggle.
   * If it is itself being hidden, the same bounded position is the least
   * surprising neighbour. An editor on a hidden file must close too, or the
   * global keyboard guard would remain active with no composer on screen; its
   * draft stays in `draftsRef` and comes back when that line is opened again.
   */
  const toggleGenerated = useCallback(() => {
    const next = !showGenerated
    const currentPath = items[activeIndex]?.path
    const nextItems = next ? allItems : allItems.filter((item) => !generatedPaths.has(item.path))
    const samePath = currentPath ? nextItems.findIndex((item) => item.path === currentPath) : -1

    if (!next && composer && generatedPaths.has(composer.path)) closeComposer()
    setActiveIndex(
      samePath >= 0 ? samePath : Math.max(0, Math.min(activeIndex, nextItems.length - 1)),
    )
    setShowGenerated(next)

    const url = new URL(location.href)
    if (next) url.searchParams.set('generated', '1')
    else url.searchParams.delete('generated')
    history.replaceState(null, '', url)
  }, [showGenerated, items, activeIndex, allItems, generatedPaths, composer, closeComposer])

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
      if (baseOverride) {
        // Drop the base forced from the command line: it is written down now, in
        // `.git/config`, and leaving the parameter on would keep overriding the
        // very choice just made — which was the whole of #55. No refresh here:
        // clearing it rebuilds `query`, and the effect watching it refetches on
        // its own, where calling refresh now would fire the stale query first.
        setBaseOverride(null)
        const url = new URL(location.href)
        url.searchParams.delete('base')
        history.replaceState(null, '', url)
        return
      }
      await refresh()
    },
    [data, repoId, refresh, target, baseOverride],
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

  /** Browser find cannot see CodeView rows that the virtual window has unmounted. */
  const searchMatches = useMemo(() => searchDiff(items, searchQuery), [items, searchQuery])
  const boundedSearchIndex = searchMatches.length > 0 ? searchIndex % searchMatches.length : 0
  const activeSearchMatch = searchMatches[boundedSearchIndex]

  const openSearch = useCallback(() => {
    setPicking(null)
    if (!searchOpen) selectionBeforeSearchRef.current = viewRef.current?.getSelectedLines() ?? null
    setSearchOpen(true)
    requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })
  }, [searchOpen])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    viewRef.current?.setSelectedLines(selectionBeforeSearchRef.current)
    selectionBeforeSearchRef.current = null
  }, [])

  const stepSearch = useCallback(
    (offset: number) => {
      if (searchMatches.length === 0) return
      setSearchIndex((current) => (current + offset + searchMatches.length) % searchMatches.length)
    },
    [searchMatches.length],
  )

  useEffect(() => {
    if (!searchOpen) return
    searchInputRef.current?.focus()
    searchInputRef.current?.select()
  }, [searchOpen])

  useEffect(() => {
    if (!searchOpen) return
    if (!activeSearchMatch) {
      viewRef.current?.clearSelectedLines()
      return
    }

    const itemIndex = items.findIndex((item) => item.id === activeSearchMatch.id)
    if (itemIndex >= 0) setActiveIndex(itemIndex)
    treeRef.current?.reveal(activeSearchMatch.path)

    if (activeSearchMatch.type === 'path') {
      viewRef.current?.clearSelectedLines()
      viewRef.current?.scrollTo({
        type: 'item',
        id: activeSearchMatch.id,
        align: 'start',
      })
      return
    }

    const range = {
      start: activeSearchMatch.lineNumber,
      end: activeSearchMatch.lineNumber,
      side: activeSearchMatch.side,
      endSide: activeSearchMatch.side,
    }
    viewRef.current?.setSelectedLines({ id: activeSearchMatch.id, range })
    viewRef.current?.scrollTo({
      type: 'line',
      id: activeSearchMatch.id,
      lineNumber: activeSearchMatch.lineNumber,
      side: activeSearchMatch.side,
      align: 'center',
    })
  }, [searchOpen, activeSearchMatch, items])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLocaleLowerCase()
      const command = event.metaKey || event.ctrlKey

      if (items.length > 0 && command && !event.altKey && key === 'f') {
        event.preventDefault()
        openSearch()
        return
      }
      if (searchOpen && ((command && !event.altKey && key === 'g') || event.key === 'F3')) {
        event.preventDefault()
        stepSearch(event.shiftKey ? -1 : 1)
        return
      }

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
      // `l` for log, which is what the list is. `c` is the comment key.
      else if (event.key === 'l') setPicking('commit')
      else if (event.key === 'j') goTo(activeIndex + 1)
      else if (event.key === 'k') goTo(activeIndex - 1)
      else if (event.key === 'r' || event.key === 'R') refresh()
      else if (event.key === 'c') {
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
    refresh,
    items,
    viewed,
    toggleViewed,
    picking,
    composer,
    openComposer,
    searchOpen,
    openSearch,
    stepSearch,
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
  const repoName = data?.repo.path.split('/').filter(Boolean).at(-1) ?? 'Repository'

  return (
    <div className="app">
      <header className="topbar">
        <div className="appbar">
          <div className="repo-context">
            <span className="brand-mark" aria-hidden="true">
              g
            </span>
            <span className="product-name">ghl</span>
            <span className="repo-divider">/</span>
            <strong className="repo-name" title={data?.repo.path}>
              {repoName}
            </strong>
            <span className="review-badge">Review</span>
          </div>

          <div className="app-actions">
            <div className="toggle view-toggle" aria-label="Diff layout">
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

            <button type="button" className="refresh" onClick={refresh} disabled={refreshing}>
              <span className={refreshing ? 'refresh-icon spinning' : 'refresh-icon'} aria-hidden>
                ↻
              </span>
              <span className="refresh-label">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
            </button>

            <details className="shortcuts">
              <summary className="icon-button" aria-label="Keyboard shortcuts" title="Shortcuts">
                ?
              </summary>
              <div className="shortcuts-panel">
                <strong>Keyboard shortcuts</strong>
                <dl>
                  <div>
                    <dt>
                      <kbd>b</kbd>
                    </dt>
                    <dd>Choose base</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>t</kbd>
                    </dt>
                    <dd>Choose target</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>l</kbd>
                    </dt>
                    <dd>Choose commit</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>j</kbd> <kbd>k</kbd>
                    </dt>
                    <dd>Move between files</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>v</kbd>
                    </dt>
                    <dd>Mark viewed</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>c</kbd>
                    </dt>
                    <dd>Comment selection</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>r</kbd>
                    </dt>
                    <dd>Refresh</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>⌘/Ctrl</kbd> <kbd>f</kbd>
                    </dt>
                    <dd>Search changed code</dd>
                  </div>
                </dl>
              </div>
            </details>
          </div>
        </div>

        <div className="reviewbar">
          <div className="revision">
            <div className="toolbar-group compare-group">
              <span className="toolbar-label">
                Compare {baseSource && <span className="source">· base {baseSource}</span>}
              </span>
              <div className="revision-flow">
                <span className="base-anchor">
                  <span className="ref-role">Base</span>
                  <button
                    type="button"
                    className="ref base"
                    onClick={() => setPicking((p) => (p === 'base' ? null : 'base'))}
                    title="Change the base (b)"
                    aria-label={`Base: ${data?.base?.ref ?? 'loading'}`}
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

                <span className="arrow" aria-hidden="true">
                  →
                </span>

                <span className="base-anchor">
                  <span className="ref-role">Target</span>
                  <button
                    type="button"
                    className="ref target"
                    onClick={() => setPicking((p) => (p === 'target' ? null : 'target'))}
                    title="Review another revision (t)"
                    aria-label={`Target: ${data?.target?.ref ?? 'HEAD'}`}
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
              </div>
            </div>

            {/* Beside the chain, not a third link in it: `main → feature → abc1234`
                reads as "from main up to that commit", which is the cumulative
                diff. This one is the commit's own. */}
            <div className="toolbar-group commit-group">
              <span className="toolbar-label">Commit</span>
              <span className="base-anchor">
                <button
                  type="button"
                  className="ref commit"
                  onClick={() => setPicking((p) => (p === 'commit' ? null : 'commit'))}
                  title="Show one commit (l)"
                  aria-expanded={picking === 'commit'}
                  disabled={!data}
                >
                  {data?.commit ? `${data.commit.short} ${data.commit.subject}` : 'All commits'}{' '}
                  <span className="caret">▾</span>
                </button>

                {picking === 'commit' && data && (
                  <CommitSelector
                    repoId={repoId}
                    target={target}
                    current={data.commit}
                    onPick={pickCommit}
                    onClose={() => setPicking(null)}
                  />
                )}
              </span>
            </div>

            <div className="toolbar-group scope-group">
              <span className="toolbar-label">Include</span>
              <div className="scope-controls">
                {/* A state, not a command: it changes what the diff contains. */}
                <label className="scope-check" title="Include the uncommitted work, staged or not">
                  <input
                    type="checkbox"
                    className="worktree"
                    // The server's answer, not this button's own state: in a commit or
                    // a ref view the working tree is out whatever the flag says, and a
                    // checked box there would claim the opposite.
                    checked={data?.target.workingTree ?? !committed}
                    onChange={toggleCommitted}
                    // Already out of the diff there, and both cases say so themselves.
                    disabled={!data || target !== null || commit !== null}
                  />
                  <span>Working tree</span>
                </label>

                <label className="scope-check" title="Include the files git does not track yet">
                  <input
                    type="checkbox"
                    className="untracked"
                    checked={data?.untrackedIncluded ?? withUntracked}
                    onChange={toggleUntracked}
                    // One condition for the four cases that leave nothing to include —
                    // a ref, a commit, the working tree out, a checkout with no stray
                    // file — because `buildPatch` empties the list in all of them.
                    disabled={!data || data.untracked.length === 0}
                  />
                  <span>
                    {/* The count is the whole reason the default is off: 2 changed
                        files against 446 untracked ones is what it protects against,
                        and it reads both ways — what is being hidden, or what was
                        taken in. */}
                    Untracked
                    {data && data.untracked.length > 0 ? ` (${data.untracked.length})` : ''}
                  </span>
                </label>
              </div>
            </div>

            {data?.commit ? (
              <span className="source revision-note">one commit — the base is not compared</span>
            ) : (
              data &&
              !data.target.workingTree && (
                <span className="source revision-note">
                  {target ? 'reviewing a ref, working tree excluded' : 'working tree excluded'}
                </span>
              )
            )}
          </div>

          {data && (
            <span className="stats" aria-label="Diff statistics">
              <span className="file-count">{stats.files} files</span>
              <span className="add">+{stats.additions}</span>
              <span className="del">−{stats.deletions}</span>
            </span>
          )}
        </div>

        {/* The stack is a third, conditional level: it tells a different story
            than the comparison controls above and should never disrupt them. */}
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

      {error && <p className="message">{error}</p>}

      {!error && data && allItems.length === 0 && (
        <p className="message">
          {data.commit ? (
            <>
              Nothing to show — <code>{data.commit.short}</code> changes no file.
            </>
          ) : committed ? (
            // Not "matches the base": the work may well be there, uncommitted,
            // and it is this button that is hiding it.
            <>
              Nothing to show — nothing is committed above <code>{data.base.ref}</code>, and the
              working tree is excluded.
            </>
          ) : data.untracked.length > 0 ? (
            // Not "matches the base" either: the files are there, and the button
            // carrying that count is what keeps them out.
            <>
              Nothing to show — nothing but {data.untracked.length} untracked file(s), which the
              Untracked checkbox brings in.
            </>
          ) : (
            <>
              Nothing to show — <code>{data.head.branch}</code> matches <code>{data.base.ref}</code>
              .
            </>
          )}
        </p>
      )}

      {allItems.length > 0 && (
        <div
          className="body"
          ref={bodyRef}
          style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
        >
          <aside className="sidebar">
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
              {storedViewedCount > 0 && (
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
            {generatedPaths.size > 0 && (
              <button
                type="button"
                className="generated-files"
                aria-expanded={showGenerated}
                onClick={toggleGenerated}
                title={
                  showGenerated
                    ? 'Hide files detected as generated'
                    : 'Include files detected as generated in this review'
                }
              >
                <span className="generated-caret" aria-hidden="true">
                  {showGenerated ? '▾' : '▸'}
                </span>
                <span>
                  {generatedPaths.size} generated file{generatedPaths.size > 1 ? 's' : ''}
                </span>
                <span className="spacer" />
                {generatedViewedCount > 0 && (
                  <span className="generated-viewed">✓{generatedViewedCount}</span>
                )}
                {generatedCommentCount > 0 && (
                  <span className="generated-comments">✎{generatedCommentCount}</span>
                )}
                <span className="generated-action">{showGenerated ? 'Hide' : 'Show'}</span>
              </button>
            )}
            <FileTree
              ref={treeRef}
              entries={entries}
              activePath={activePath}
              onSelect={selectByPath}
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
            {items.length === 0 && generatedPaths.size > 0 && !showGenerated && (
              <div className="generated-empty" role="status">
                <span>
                  All {generatedPaths.size} changed file{generatedPaths.size > 1 ? 's are' : ' is'}{' '}
                  generated.
                </span>
                <button type="button" onClick={toggleGenerated}>
                  Show {generatedPaths.size > 1 ? 'files' : 'file'}
                </button>
              </div>
            )}
            <div className="diff-search" role="search" hidden={!searchOpen}>
              <label className="visually-hidden" htmlFor="diff-search-input">
                Search changed code
              </label>
              <input
                id="diff-search-input"
                ref={searchInputRef}
                className="diff-search-input"
                type="search"
                value={searchQuery}
                placeholder="Search changed code…"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setSearchQuery(event.target.value)
                  setSearchIndex(0)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    stepSearch(event.shiftKey ? -1 : 1)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    closeSearch()
                  }
                }}
              />
              <output className="diff-search-count" aria-live="polite">
                {searchQuery.trim()
                  ? searchMatches.length > 0
                    ? `${boundedSearchIndex + 1}/${searchMatches.length}`
                    : 'No results'
                  : ''}
              </output>
              <button
                type="button"
                aria-label="Previous match"
                title="Previous match (Shift+Enter)"
                disabled={searchMatches.length === 0}
                onClick={() => stepSearch(-1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label="Next match"
                title="Next match (Enter)"
                disabled={searchMatches.length === 0}
                onClick={() => stepSearch(1)}
              >
                ↓
              </button>
              <button
                type="button"
                aria-label="Close search"
                title="Close (Escape)"
                onClick={closeSearch}
              >
                ×
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
