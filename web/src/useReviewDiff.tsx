import { draftScope, readDrafts, saveDraft, acknowledgeDrafts } from './draftSession.tsx'
import { readSession, sessionSaver, writeSession } from './reviewSession.ts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getFiletypeFromFileName,
  isDiffAnnotation,
  parsePatchFiles,
  type CodeViewDiffItem,
  type CodeViewFileItem,
  type CodeViewItem,
  type DiffLineAnnotation,
  type LineAnnotation,
  type SelectedLineRange,
} from '@pierre/diffs'
import { CodeView, useStableCallback, type CodeViewHandle } from '@pierre/diffs/react'

import type { SyntaxTheme } from './theme.ts'
import CommentThread, { type Composer } from './CommentThread.tsx'
import type { CommentSubmission, SaveState } from './commentPersistence.ts'
import ImageDiff from './ImageDiff.tsx'
import type { TreeEntry } from './FileTree.tsx'
import { diffFilesLoader, type ContextError } from './diffFiles.ts'
import { searchDiff } from './diffSearch.ts'
import { treeOrder } from './fileOrder.ts'
import type {
  Comment,
  DiffPayload,
  DiffSide,
  ImageComparison,
  ServedComment,
  ViewedMap,
} from '../../src/types.ts'

/** The loaded comparison and the lifetime of the request that owns it. */
export type LoadedReviewDiff = DiffPayload & {
  loadId: number
  query: string
  signal: AbortSignal
}

interface ReviewDiffOptions {
  repoId: string | null
  data: LoadedReviewDiff | null
  diffStyle: 'unified' | 'split'
  syntaxTheme: SyntaxTheme
  viewed: ViewedMap
  comments: ServedComment[]
  copied: string | null
  onCopy: (comment: ServedComment) => void
  saving: Map<string, SaveState>
  onViewedChange: (path: string, viewed: boolean) => void
  onSubmit: (comment: CommentSubmission) => Promise<void>
  onDelete: (id: string) => void
  onRetry: (comment: ServedComment) => void
  onRevealFile: (path: string) => void
}

/**
 * `CodeViewDiffItem` carries no path; we add one and read it back from our own
 * array, which the library ignores.
 */
type DiffItem = (CodeViewDiffItem | (CodeViewFileItem & { image: ImageComparison })) & {
  path: string
}

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

/**
 * Own the renderer protocol: callers provide review state and act on paths and
 * source lines; item identities, mutable metadata and selection ordering stay here.
 * The returned view keeps the same React position across review-state updates.
 */
export function useReviewDiff({
  repoId,
  data,
  diffStyle,
  syntaxTheme,
  viewed,
  comments,
  copied,
  onCopy,
  saving,
  onViewedChange: toggleViewed,
  onSubmit,
  onDelete: deleteComment,
  onRetry: save,
  onRevealFile: revealFile,
}: ReviewDiffOptions) {
  const viewRef = useRef<CodeViewHandle<undefined>>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [revealedPath, setRevealedPath] = useState<string | null>(null)
  const [commentTarget, setCommentTarget] = useState<ServedComment | null>(null)
  useEffect(() => {
    setRevealedPath(null)
  }, [viewed, data?.range])
  const [composer, setComposer] = useState<Composer | null>(null)
  const draftsRef = useRef(new Map<string, string>())
  const submittedDrafts = useRef(new Set<string>())
  const scope = draftScope(repoId, data?.query ?? '')
  const saveComposer = useStableCallback((next: Composer, body: string, submitted = false) => {
    saveDraft(scope, `${next.key}:${next.editing ?? 'new'}`, {
      composer: next,
      body,
      fingerprint: data?.files.find((file) => file.path === next.path)?.hash ?? null,
      source: 'diff',
      submitted,
    })
  })
  useEffect(() => {
    if (!data) return
    acknowledgeDrafts(repoId, comments, saving)
    const saved = Object.entries(readDrafts(draftScope(repoId, data.query))).filter(
      ([key, draft]) =>
        !submittedDrafts.current.has(`${scope}:${key}`) &&
        draft.source === 'diff' &&
        data.files.some(
          (file) => file.path === draft.composer.path && file.hash === draft.fingerprint,
        ),
    )
    draftsRef.current = new Map(saved.map(([key, draft]) => [key, draft.body]))
    setComposer(saved.at(-1)?.[1].composer ?? null)
  }, [repoId, data, scope, comments, saving])
  const gutterRequestRef = useRef<SelectedLineRange | null>(null)
  const [contextErrors, setContextErrors] = useState<Record<string, ContextError>>({})
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const selectionBeforeSearchRef = useRef<{ id: string; range: SelectedLineRange } | null>(null)

  // Refresh cancels the old comparison before its replacement arrives. Clear
  // its errors at that point, including when the replacement request fails.
  const signal = data?.signal
  useEffect(() => {
    const clear = () => setContextErrors({})
    if (signal?.aborted) clear()
    signal?.addEventListener('abort', clear)
    return () => signal?.removeEventListener('abort', clear)
  }, [signal])

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
    const imageFiles = new Map(
      data.files.filter((file) => file.image).map((file) => [file.path, file]),
    )
    const files: DiffItem[] = parsePatchFiles(
      data.patch,
      `${repoId}-${data.head.sha}-${data.range}-${data.loadId}`,
    )
      .flatMap((patch) => patch.files ?? [])
      .filter((file) => !imageFiles.has(file.name))
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
    // Empty file items give images the same header, navigation and measured
    // file-level annotation slot as text, without inventing source lines.
    for (const file of imageFiles.values()) {
      files.push({
        id: `image:${data.range}:${file.path}:${file.hash}`,
        path: file.path,
        type: 'file',
        file: { name: file.path, contents: '', lang: 'text', cacheKey: `image:${file.hash}` },
        image: file.image!,
      })
    }
    const order = treeOrder(files.map((file) => file.path))
    return files.toSorted(
      (left, right) => (order.get(left.path) ?? 0) - (order.get(right.path) ?? 0),
    )
  }, [data, repoId])

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

  // Hydration mutates FileDiffMetadata in place, including its line arrays and
  // hunk offsets. Search retains a separate snapshot of the initial patch.
  const searchItems = useMemo(() => structuredClone(allItems), [allItems])

  const loadDiffFiles = useMemo(
    () =>
      data && repoId
        ? diffFilesLoader(repoId, data, data.query, data.signal, (path, failure) => {
            setContextErrors((previous) => {
              const next = { ...previous }
              if (failure) next[path] = failure
              else delete next[path]
              return next
            })
          })
        : undefined,
    [data, repoId],
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
  const versions = useRef(new Map<string, { key: string; version: number }>())
  const items = useMemo(
    () =>
      allItems.map((item): DiffItem => {
        const collapsed = item.path in viewed && item.path !== revealedPath
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
        return item.type === 'file'
          ? { ...item, collapsed, version, annotations: collapsed ? [] : [{ lineNumber: 0 }] }
          : { ...item, collapsed, version, annotations: annotations.byPath.get(item.path) }
      }),
    [allItems, viewed, annotations, revealedPath],
  )

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
        id: item.path,
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
  }, [allItems, data, viewed, commentCounts])

  // Revealing a comment opens the file for reading without clearing its Viewed tick.
  const canRevealComment = useCallback(
    (comment: ServedComment) => {
      const item = allItems.find((entry) => entry.path === comment.path)
      if (item?.type !== 'diff') return false
      return item.fileDiff.hunks.some((hunk) => {
        const start = comment.side === 'additions' ? hunk.additionStart : hunk.deletionStart
        const count = comment.side === 'additions' ? hunk.additionCount : hunk.deletionCount
        return comment.end >= start && comment.end < start + count
      })
    },
    [allItems],
  )

  const revealComment = useStableCallback((comment: ServedComment) => {
    if (!canRevealComment(comment)) return
    setSearchOpen(false)
    setRevealedPath(comment.path)
    setCommentTarget(comment)
  })

  useEffect(() => {
    if (!commentTarget) return
    const index = items.findIndex((item) => item.path === commentTarget.path)
    const item = items[index]
    if (!item || item.collapsed) return
    // The React wrapper has committed the expanded item before its next frame.
    const frame = requestAnimationFrame(() => {
      setActiveIndex(index)
      revealFile(item.path)
      viewRef.current?.setSelectedLines({
        id: item.id,
        range: {
          start: commentTarget.start,
          end: commentTarget.end,
          side: commentTarget.side,
          endSide: commentTarget.side,
        },
      })
      viewRef.current?.scrollTo({
        type: 'line',
        id: item.id,
        lineNumber: commentTarget.end,
        side: commentTarget.side,
        align: 'center',
      })
      paneRef.current?.focus({ preventScroll: true })
      setCommentTarget(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [commentTarget, items, revealFile])

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
    const next = { key: threadKey(path, side, end), path, side, start, end, editing: null }
    setComposer(next)
    saveComposer(next, draftsRef.current.get(`${next.key}:new`) ?? '')
  })

  const editComment = useStableCallback((comment: Comment) => {
    const key = threadKey(comment.path, comment.side, comment.end)
    const body = draftsRef.current.get(`${key}:${comment.id}`) ?? comment.body
    draftsRef.current.set(`${key}:${comment.id}`, body)
    const next = {
      key,
      path: comment.path,
      side: comment.side,
      start: comment.start,
      end: comment.end,
      editing: comment.id,
    }
    setComposer(next)
    saveComposer(next, body)
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
    if (composer) saveDraft(scope, `${composer.key}:${composer.editing ?? 'new'}`, null)
    setComposer(null)
    viewRef.current?.clearSelectedLines()
  })

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
      revealFile(item.path)
      viewRef.current?.scrollTo({ type: 'item', id: item.id, align: 'start' })
    },
    [items, revealFile],
  )

  /** Every file is in the list now, viewed or not, so a click always lands. */
  const selectByPath = useCallback(
    (path: string) => goTo(items.findIndex((item) => item.path === path)),
    [items, goTo],
  )

  const restored = useRef<string | null>(null)
  useEffect(() => {
    if (!data || !items.length) return
    const key = `${repoId}:reading:${data.query}`
    if (restored.current === key) return
    const saved = readSession(key)
    const item = items.find((candidate) => candidate.path === saved.path)
    if (!item) return
    const timer = setTimeout(() => {
      restored.current = key
      selectByPath(item.path)
      if (typeof saved.line === 'number')
        viewRef.current?.scrollTo({
          type: 'line',
          id: item.id,
          lineNumber: saved.line,
          side: saved.side === 'deletions' ? 'deletions' : 'additions',
          align: 'start',
        })
    }, 250)
    return () => clearTimeout(timer)
  }, [data, items, repoId, selectByPath])
  const saveReading = useStableCallback(() => {
    if (!data) return
    const pane = paneRef.current
    const top = pane?.getBoundingClientRect().top ?? 0
    let path = items[activeIndex]?.path
    let line: number | undefined
    let side = 'additions'
    for (const host of pane?.querySelectorAll('diffs-container') ?? []) {
      if (host.getBoundingClientRect().bottom <= top) continue
      const title = host.shadowRoot?.querySelector('[data-title]')?.textContent?.trim()
      if (title && items.some((item) => item.path === title)) path = title
      const row = [...(host.shadowRoot?.querySelectorAll('[data-line]') ?? [])].find(
        (candidate) => candidate.getBoundingClientRect().top >= top,
      )
      const number = Number(row?.getAttribute('data-line'))
      if (number > 0) line = number
      if (
        row?.getAttribute('data-line-type')?.includes('deletion') ||
        row?.closest('[data-code="deletions"]')
      )
        side = 'deletions'
      break
    }
    writeSession(`${repoId}:reading:${data.query}`, { path, line, side })
  })
  useEffect(() => sessionSaver(saveReading), [saveReading])

  /** Browser find cannot see CodeView rows that the virtual window has unmounted. */
  const searchMatches = useMemo(
    () =>
      searchDiff(
        searchItems.map((item) => ({ ...item, collapsed: item.path in viewed })),
        searchQuery,
      ),
    [searchItems, viewed, searchQuery],
  )
  const boundedSearchIndex = searchMatches.length > 0 ? searchIndex % searchMatches.length : 0
  const activeSearchMatch = searchMatches[boundedSearchIndex]

  const openSearch = useCallback(() => {
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
    revealFile(activeSearchMatch.path)

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
  }, [searchOpen, activeSearchMatch, items, revealFile])

  const submitComment = useStableCallback(async (body: string) => {
    if (!composer || !data) return
    const { path, side, start, end, editing } = composer
    const key = `${composer.key}:${editing ?? 'new'}`
    const savedScope = scope
    saveComposer(composer, body, true)
    submittedDrafts.current.add(`${scope}:${key}`)
    setComposer(null)
    viewRef.current?.clearSelectedLines()
    try {
      await onSubmit({ path, side, start, end, editing, body })
      saveDraft(savedScope, key, null)
      draftsRef.current.delete(key)
    } catch {
      /* The optimistic comment exposes retry; its draft also survives reload. */
    }
  })

  const commentSelection = useStableCallback(() => {
    const selection = viewRef.current?.getSelectedLines()
    if (!selection) return
    const path = items.find((item) => item.id === selection.id)?.path
    if (path) openComposer(path, selection.range)
  })

  const navigate = useCallback((offset: number) => goTo(activeIndex + offset), [goTo, activeIndex])

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
      loadDiffFiles,
      expansionLineCount: 20,
      hunkSeparators: 'line-info' as const,
      theme: syntaxTheme,
      layout: { paddingTop: 16, paddingBottom: 16, gap: 16 },
      stickyHeaders: true,
      // File items are image previews; only text diff items have source rows.
      unsafeCSS: `
        [data-file] [data-line], [data-file] [data-gutter] { display: none; }
        [data-diffs-header] { border-radius: 6px 6px 0 0; background: var(--bg-raised); }
      `,
      // Both gutter APIs are declared mutually exclusive and the library throws
      // on the pair, so this is the native "+" button, not a rendered one.
      // Setting the handler is also what enables dragging on the gutter.
      enableGutterUtility: true,
      onGutterUtilityClick,
      enableLineSelection: true,
      onLineSelectionEnd,
    }),
    [diffStyle, syntaxTheme, loadDiffFiles, onGutterUtilityClick, onLineSelectionEnd],
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
      if (item.type === 'file') {
        const image = (item as Extract<DiffItem, { type: 'file' }>).image
        return image ? <ImageDiff image={image} path={item.file.name} /> : null
      }
      if (item.type !== 'diff' || !isDiffAnnotation(annotation)) return null
      const key = threadKey(item.fileDiff.name, annotation.side, annotation.lineNumber)
      const thread = threads.get(key)
      const composing = composer?.key === key ? composer : null
      if (!thread && !composing) return null
      return (
        <CommentThread
          key={key}
          comments={thread ?? []}
          copied={copied}
          onCopy={onCopy}
          composing={composing}
          currentRange={data?.range ?? ''}
          saving={saving}
          drafts={draftsRef}
          onDraft={(body) => {
            if (composer) saveComposer(composer, body)
          }}
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
      copied,
      onCopy,
      composer,
      data?.range,
      saving,
      submitComment,
      closeComposer,
      editComment,
      deleteComment,
      save,
      saveComposer,
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
      const path = item.type === 'diff' ? item.fileDiff.name : item.file.name
      if (!path) return null
      const isViewed = path in viewed
      return (
        <label className="viewed-toggle" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={isViewed}
            onChange={() => {
              setRevealedPath(null)
              toggleViewed(path, !isViewed)
            }}
          />
          Viewed
        </label>
      )
    },
    [viewed, toggleViewed],
  )

  // CodeView measures its own scroller, which needs a real height and overflow.
  // Keep it first in .diff: a conditional sibling before it would remount the
  // renderer when appearing or disappearing, losing scroll and expanded context.
  const view = (
    <div className="diff" ref={paneRef} tabIndex={-1} role="region" aria-label="Code changes">
      <CodeView
        ref={viewRef}
        items={items}
        options={options}
        renderHeaderMetadata={renderHeaderMetadata}
        renderAnnotation={renderAnnotation}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
      />
      <div className="context-errors" aria-live="polite">
        {Object.entries(contextErrors).map(([path, failure]) => (
          <div className="context-error" key={path} role="alert">
            <span>
              {path}: {failure.message}
            </span>
            <button type="button" onClick={failure.retry}>
              Retry
            </button>
          </div>
        ))}
      </div>
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
  )

  return {
    view,
    entries,
    activePath: items[activeIndex]?.path,
    isComposing: composer !== null,
    searchOpen,
    selectFile: selectByPath,
    revealComment,
    canRevealComment,
    navigate,
    commentSelection,
    openSearch,
    stepSearch,
  }
}
