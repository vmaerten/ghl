import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from 'react'
import { useStableCallback } from '@pierre/diffs/react'
import { useReviewDiff, type LoadedReviewDiff } from './useReviewDiff.tsx'
import { useReviewSelection } from './reviewSelection.ts'
import { useCommentPersistence, type CommentSubmission } from './commentPersistence.ts'

import { useTheme } from './theme.ts'
import ThemePicker from './ThemePicker.tsx'
import CommentsPanel from './CommentsPanel.tsx'
import Icon from './Icon.tsx'
import RefSelector from './RefSelector.tsx'
import CommitSelector from './CommitSelector.tsx'
import FileTree, { type FileTreeHandle } from './FileTree.tsx'
import Resizer, { storedWidth } from './Resizer.tsx'
import { GO_POC } from './capabilities.ts'
import { asMarkdown } from '../../src/export.ts'
import type { BaseSource, DiffPayload, ServedComment, ViewedMap } from '../../src/types.ts'
import type { ReviewSession, ReviewSessionHandle } from './reviewSession.ts'

/** The repo id lives in the path: /r/<repoId>. */
function repoIdFromLocation() {
  const match = window.location.pathname.match(/^\/r\/([^/]+)/)
  return match?.[1] ?? null
}

/** Well under the server's idle threshold, and cheap enough to be invisible. */
const HEARTBEAT_MS = 5 * 60_000

/** A fetch that never reached anything rejects with a TypeError, not an HTTP status. */
const NOT_LISTENING = GO_POC
  ? 'ghl-go-poc is no longer listening — restart it in that repository'
  : 'ghl is no longer listening — run `ghl` again in that repository'

/** Shorter than the CLI's wording: this is a badge in a topbar, not a report. */
const BASE_SOURCES: Record<BaseSource, string> = {
  override: 'given on the command line',
  remembered: 'remembered',
  stack: 'from the stack',
  guessed: 'guessed',
  trunk: 'trunk',
}

export default function App({
  session,
  sessionHandle,
}: { session?: ReviewSession; sessionHandle?: Ref<ReviewSessionHandle> } = {}) {
  const { theme, syntaxTheme, chooseTheme } = useTheme()
  const repoId = useMemo(repoIdFromLocation, [])
  const [data, setData] = useState<LoadedReviewDiff | null>(null)
  const loadRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>(session?.diffStyle ?? 'unified')
  const [refreshing, setRefreshing] = useState(false)
  /** path -> hash of the diff section that was marked as read. */
  const [viewed, setViewedState] = useState<ViewedMap>({})
  const [picking, setPicking] = useState<'base' | 'target' | 'commit' | null>(null)
  const [selection, select] = useReviewSelection(repoId)
  const { target, commit, committed, withUntracked, query } = selection
  const [{ comments, saving }, commentPersistence] = useCommentPersistence(repoId)
  /** Momentary, so the button can say the clipboard actually took it. */
  const [copied, setCopied] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [commentsOpen, setCommentsOpen] = useState(session?.commentsOpen ?? false)
  const panelSession = useRef(session?.panelEditor ?? { editing: null, draft: '' })
  const [filesOpen, setFilesOpen] = useState(false)
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const update = () => setMobile(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    },
    [],
  )
  /** Folding and revealing live inside the tree, which owns that state. */
  const treeRef = useRef<FileTreeHandle>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [sidebarWidth, setSidebarWidth] = useState(storedWidth)

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
    const loadId = ++loadRef.current
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setRefreshing(true)
    const receiveComments = commentPersistence.refresh()
    try {
      const response = await fetch(`/r/${repoId}/api/diff${selection.query}`, {
        signal: controller.signal,
      })
      const body: DiffPayload & { error?: string } = await response.json()
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      if (controller.signal.aborted) return
      setData({ ...body, loadId, query: selection.query, signal: controller.signal })
      // The server already dropped ticks whose file changed since.
      setViewedState(body.viewed ?? {})
      receiveComments(body.comments ?? [])
      setError(null)
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof TypeError) setError(NOT_LISTENING)
      else setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!controller.signal.aborted) setRefreshing(false)
    }
  }, [repoId, selection, commentPersistence])

  useEffect(() => {
    refresh()
    return () => controllerRef.current?.abort()
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
    if (GO_POC) return
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

  const pickTarget = useCallback(
    (ref: string | null) => {
      setPicking(null)
      select.pickTarget(ref)
    },
    [select],
  )
  const pickCommit = useCallback(
    (sha: string | null) => {
      setPicking(null)
      select.pickCommit(sha)
    },
    [select],
  )
  const { toggleCommitted, toggleUntracked } = select

  const stats = data?.totals ?? { files: 0, additions: 0, deletions: 0 }
  const viewedCount = Object.keys(viewed).length

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

  const submitComment = useStableCallback((draft: CommentSubmission) => {
    if (data) void commentPersistence.submit(draft, data)
  })

  const deleteComment = useStableCallback(async (id: string) => {
    try {
      await commentPersistence.remove(id)
    } catch (cause) {
      setError(`could not delete the comment: ${cause instanceof Error ? cause.message : cause}`)
    }
  })

  /**
   * Put the whole review on the clipboard, as markdown.
   *
   * `asMarkdown` is the CLI's too, so the button and `ghl comments` cannot
   * produce different text for the same review. Failing to reach the clipboard is
   * said out loud: the point of the gesture is that the text left the page.
   */
  const copyComments = useStableCallback(async (comment?: ServedComment) => {
    if (!data) return
    setCopyError(null)
    setCopied(null)
    try {
      await navigator.clipboard.writeText(
        asMarkdown(comment ? [comment] : comments, { range: data.range }),
      )
      setCopied(comment?.id ?? 'all')
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(null), 2000)
    } catch (cause) {
      setCopyError(
        `Could not copy. Try again or check your browser's clipboard permissions. ${cause instanceof Error ? cause.message : ''}`,
      )
    }
  })

  const pickBase = useStableCallback(async (base: string | null) => {
    setPicking(null)
    try {
      await select.pickBase(base, data?.base.ref)
    } catch (cause) {
      setError(`could not save the base: ${cause instanceof Error ? cause.message : cause}`)
    }
  })

  const revealFile = useCallback((path: string) => treeRef.current?.reveal(path), [])
  const {
    view,
    entries,
    activePath,
    isComposing,
    searchOpen,
    selectFile,
    revealComment,
    canRevealComment,
    navigate,
    commentSelection,
    openSearch,
    stepSearch,
    captureSession,
  } = useReviewDiff({
    session,
    repoId,
    data,
    diffStyle: mobile ? 'unified' : diffStyle,
    syntaxTheme,
    viewed,
    comments,
    copied,
    onCopy: copyComments,
    saving,
    onViewedChange: toggleViewed,
    onSubmit: submitComment,
    onDelete: deleteComment,
    onRetry: (comment) => {
      void commentPersistence.retry(comment.id)
    },
    onRevealFile: revealFile,
  })
  useImperativeHandle(
    sessionHandle,
    () => ({
      capture: () => ({
        version: 1,
        diffStyle,
        commentsOpen,
        panelEditor: { ...panelSession.current },
        ...captureSession(),
      }),
    }),
    [diffStyle, commentsOpen, captureSession],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (commentsOpen) return
      if (event.key === 'Escape' && filesOpen) {
        setFilesOpen(false)
        return
      }
      const key = event.key.toLocaleLowerCase()
      const command = event.metaKey || event.ctrlKey

      if (entries.length > 0 && command && !event.altKey && key === 'f') {
        event.preventDefault()
        setPicking(null)
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
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (focused instanceof HTMLElement && focused.isContentEditable) return
      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (picking) return // the picker owns the keyboard while open
      // And so does the composer. The guard above only covers a focused field,
      // and the pane hands focus back to its own root whenever it re-renders an
      // item — so a composer can be open with the focus nowhere near it.
      if (isComposing) return

      if (!GO_POC && event.key === 'b') setPicking('base')
      else if (!GO_POC && event.key === 't') setPicking('target')
      // `l` for log, which is what the list is. `c` is the comment key.
      else if (!GO_POC && event.key === 'l') setPicking('commit')
      else if (event.key === 'j') navigate(1)
      else if (event.key === 'k') navigate(-1)
      else if (event.key === 'r' || event.key === 'R') refresh()
      else if (event.key === 'c') commentSelection()
      else if (event.key === 'v') {
        if (activePath) toggleViewed(activePath, !(activePath in viewed))
      } else return

      event.preventDefault()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    commentsOpen,
    filesOpen,
    activePath,
    navigate,
    refresh,
    entries.length,
    viewed,
    toggleViewed,
    picking,
    isComposing,
    commentSelection,
    searchOpen,
    openSearch,
    stepSearch,
  ])

  const resizeSidebar = useCallback((width: number) => {
    setSidebarWidth(width)
    localStorage.setItem('ghl.sidebarWidth', String(width))
  }, [])

  const baseSource = data ? BASE_SOURCES[data.base.source] : null

  const stack = GO_POC ? null : (data?.base.stack ?? null)
  const repoName = data?.repo.path.split('/').filter(Boolean).at(-1) ?? 'Repository'

  return (
    <div className="app">
      <header className="topbar">
        <div className="appbar">
          <div className="repo-context">
            <span className="brand-mark" aria-hidden="true">
              <Icon name="file" />
            </span>
            <span className="product-name">{GO_POC ? 'ghl Go PoC' : 'ghl'}</span>
            <span className="repo-divider">/</span>
            <strong className="repo-name" title={data?.repo.path}>
              {repoName}
            </strong>
            <span className="review-badge">Review</span>
          </div>

          <div className="app-actions">
            <ThemePicker theme={theme} onChange={chooseTheme} />
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
                  {!GO_POC && (
                    <div>
                      <dt>
                        <kbd>b</kbd>
                      </dt>
                      <dd>Choose base</dd>
                    </div>
                  )}
                  {!GO_POC && (
                    <div>
                      <dt>
                        <kbd>t</kbd>
                      </dt>
                      <dd>Choose target</dd>
                    </div>
                  )}
                  {!GO_POC && (
                    <div>
                      <dt>
                        <kbd>l</kbd>
                      </dt>
                      <dd>Choose commit</dd>
                    </div>
                  )}
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
                  {GO_POC ? (
                    <span className="ref base">{data?.base?.ref ?? '…'}</span>
                  ) : (
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
                  )}

                  {!GO_POC && picking === 'base' && data && (
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
                  {GO_POC ? (
                    <span className="ref target">{data?.target?.ref ?? 'HEAD'}</span>
                  ) : (
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
                  )}

                  {!GO_POC && picking === 'target' && data && (
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
            {!GO_POC && (
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
                      query={query}
                      current={data.commit}
                      onPick={pickCommit}
                      onClose={() => setPicking(null)}
                    />
                  )}
                </span>
              </div>
            )}

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

                {!GO_POC && (
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
                )}
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

      <div className="review-tools">
        <div className="review-tools-title">
          <button
            className="button files-toggle"
            type="button"
            aria-expanded={filesOpen}
            aria-controls="changed-files"
            onClick={() => setFilesOpen((value) => !value)}
          >
            <Icon name="file" />
            Files
          </button>
          <strong>Files changed</strong>
          <span className="counter">{stats.files}</span>
          {viewedCount > 0 && (
            <span className="review-progress">
              {viewedCount}/{stats.files} viewed
            </span>
          )}
        </div>
        <div className="review-tools-actions">
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

          <button
            type="button"
            className="button comments-trigger"
            disabled={!data}
            aria-haspopup="dialog"
            aria-expanded={commentsOpen}
            aria-controls="comments-panel"
            onClick={() => setCommentsOpen(true)}
          >
            <Icon name="comment" />
            Comments <span className="counter">{comments.length}</span>
          </button>
          <button
            type="button"
            className="button primary copy-all"
            disabled={comments.length === 0}
            onClick={() => copyComments()}
          >
            <Icon name="copy" />
            {copied === 'all' ? 'Copied' : 'Copy all'}
          </button>
        </div>
      </div>
      <span className="visually-hidden" role="status">
        {copied ? 'Comments copied to clipboard' : ''}
      </span>
      <CommentsPanel
        session={panelSession}
        open={commentsOpen}
        comments={comments}
        currentRange={data?.range ?? ''}
        saving={saving}
        copied={copied}
        copyError={copyError}
        onClose={() => setCommentsOpen(false)}
        onCopy={copyComments}
        canView={canRevealComment}
        onView={(comment) => {
          setCommentsOpen(false)
          setFilesOpen(false)
          revealComment(comment)
        }}
        onUpdate={(comment, body) =>
          submitComment({
            path: comment.path,
            side: comment.side,
            start: comment.start,
            end: comment.end,
            editing: comment.id,
            body,
          })
        }
        onDelete={deleteComment}
        onRetry={(comment) => {
          void commentPersistence.retry(comment.id)
        }}
      />

      {copyError && !commentsOpen && (
        <div className="warning" role="alert">
          {copyError}
        </div>
      )}
      {data?.notice && <div className="warning">{data.notice}</div>}

      {data?.state?.operation && (
        <div className="warning">
          {data.state.operation} in progress — {data.state.conflicted.length} conflicted file(s).
          This diff may not mean what you expect.
        </div>
      )}

      {error && <p className="message">{error}</p>}

      {!error && data && entries.length === 0 && (
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

      {entries.length > 0 && (
        <div
          className={`body${filesOpen ? ' files-open' : ''}`}
          ref={bodyRef}
          style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
        >
          <aside className="sidebar" id="changed-files" aria-label="Changed files">
            <div className="sidebar-head">
              <span>
                {viewedCount > 0
                  ? `${viewedCount}/${entries.length} viewed`
                  : `${entries.length} files`}
              </span>
              <span className="spacer" />
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
            <FileTree
              ref={treeRef}
              syntaxTheme={syntaxTheme}
              entries={entries}
              activePath={activePath}
              onSelect={(path) => {
                selectFile(path)
                setFilesOpen(false)
              }}
            />
          </aside>

          {filesOpen && (
            <button
              type="button"
              className="files-backdrop"
              aria-label="Close files"
              onClick={() => setFilesOpen(false)}
            />
          )}
          <Resizer containerRef={bodyRef} onCommit={resizeSidebar} />

          {view}
        </div>
      )}
    </div>
  )
}
