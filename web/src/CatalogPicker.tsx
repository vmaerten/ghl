import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CatalogRepository,
  CatalogPayload,
  CatalogWorktree,
  WorktreeStatus,
} from '../../src/types.ts'
import { flushSession, readSession, reviewUrl, waitForWrites } from './reviewSession.ts'
import Icon from './Icon.tsx'

async function request<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    signal,
    headers: { 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
  return data
}

const recent = (repo: CatalogRepository) =>
  Math.max(0, ...repo.worktrees.map((w) => Number(readSession(w.id).openedAt) || 0))

export default function CatalogPicker({
  repoId,
  name = 'Local repositories',
  home = false,
  beforeNavigate,
}: {
  repoId: string | null
  name?: string
  home?: boolean
  beforeNavigate?: (retry: boolean) => Promise<void>
}) {
  const [open, setOpen] = useState(home)
  const [catalog, setCatalog] = useState<CatalogPayload | null>(null)
  const [query, setQuery] = useState('')
  const [manage, setManage] = useState(false)
  const [root, setRoot] = useState('')
  const [exclusions, setExclusions] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [destination, setDestination] = useState<CatalogWorktree | null>(null)
  const [statuses, setStatuses] = useState<Record<string, WorktreeStatus>>({})
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const order = useRef<string[]>([])
  const close = useCallback(() => {
    if (!home) {
      setOpen(false)
      trigger.current?.focus()
    }
  }, [home])
  const receive = useCallback((data: CatalogPayload) => setCatalog(data), [])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    order.current = []
    setStatuses({})
    request<CatalogPayload>('catalog/scan', 'POST', { force: false }, controller.signal)
      .then(receive)
      .catch((cause) => {
        if (!controller.signal.aborted) setError(String(cause))
      })
    search.current?.focus()
    return () => controller.abort()
  }, [open, receive])
  useEffect(() => {
    if (!open || !catalog?.scan.active) return
    const controller = new AbortController()
    const timer = setInterval(() => {
      request<CatalogPayload>('catalog', 'GET', undefined, controller.signal)
        .then(receive)
        .catch((cause) => {
          if (!controller.signal.aborted) setError(String(cause))
        })
    }, 1000)
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, [open, catalog?.scan.active, receive])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) {
        event.preventDefault()
        close()
        return
      }
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.composedPath()[0]
      if (
        target instanceof HTMLElement &&
        (target.matches('input, textarea, select') || target.isContentEditable)
      )
        return
      if (event.key === 'o') {
        event.preventDefault()
        setOpen((value) => !value || home)
      }
    }
    const outside = (event: PointerEvent) => {
      if (
        !home &&
        open &&
        !panel.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        close()
    }
    window.addEventListener('keydown', key)
    window.addEventListener('pointerdown', outside)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('pointerdown', outside)
    }
  }, [open, home, close])
  const repos = useMemo(() => {
    const list = [...(catalog?.repositories ?? [])]
    if (!order.current.length && list.length)
      order.current = list
        .toSorted((a, b) => {
          const current = (r: typeof a) => (r.worktrees.some((w) => w.id === repoId) ? 1 : 0)
          return current(b) - current(a) || recent(b) - recent(a) || a.name.localeCompare(b.name)
        })
        .map((r) => r.id)
    return list.toSorted((a, b) => {
      const index = (id: string) => {
        const i = order.current.indexOf(id)
        return i < 0 ? Infinity : i
      }
      const favorites = catalog?.favorites ?? []
      return (
        Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)) ||
        index(a.id) - index(b.id) ||
        a.name.localeCompare(b.name)
      )
    })
  }, [catalog, repoId])
  const destinations = useMemo(
    () =>
      repos
        .map((repo) => ({
          repo,
          worktree: repo.worktrees.find((w) => w.id === repo.mainWorktreeId),
        }))
        .filter(({ repo, worktree }) =>
          `${repo.name} ${worktree?.path ?? repo.commonDir}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
        )
        .slice(0, 100),
    [repos, query],
  )
  const ids = JSON.stringify(
    destinations.flatMap(({ worktree }) => (worktree ? [worktree.id] : [])),
  )
  useEffect(() => {
    if (!open || ids === '[]') return
    const controller = new AbortController()
    request<{ statuses: WorktreeStatus[] }>(
      'catalog/status',
      'POST',
      { ids: JSON.parse(ids) },
      controller.signal,
    )
      .then((data) => {
        setStatuses((previous) => ({
          ...previous,
          ...Object.fromEntries(data.statuses.map((status) => [status.id, status])),
        }))
        return undefined
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(String(cause))
      })
    return () => controller.abort()
  }, [open, ids, catalog?.scan.finishedAt])
  const act = async (operation: () => Promise<void>) => {
    setError('')
    setBusy(true)
    try {
      await operation()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const navigate = (worktree: CatalogWorktree, retry = false) => {
    setDestination(worktree)
    void act(async () => {
      await beforeNavigate?.(retry)
      await waitForWrites(retry)
      flushSession()
      const registered = await request<{ id: string }>('repos', 'POST', { repoPath: worktree.path })
      window.location.assign(reviewUrl(registered.id))
    })
  }
  const rescan = () =>
    act(async () => receive(await request<CatalogPayload>('catalog/scan', 'POST', { force: true })))
  const keyboard = (event: React.KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)) return
    const container = panel.current
    if (!container) return
    if (event.key === 'Tab' && !home) {
      const controls = [
        ...container.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input, textarea, summary',
        ),
      ].filter((el) => el.getClientRects().length)
      if (event.shiftKey && document.activeElement === controls[0]) {
        event.preventDefault()
        controls.at(-1)?.focus()
      } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
        event.preventDefault()
        controls[0]?.focus()
      }
      return
    }
    if (manage) return
    if (event.key === 'Enter' && event.target === search.current) {
      event.preventDefault()
      if (destinations[0]?.worktree) navigate(destinations[0].worktree)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.catalog-repo')].filter(
      (el) => !el.disabled && el.getClientRects().length,
    )
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    event.preventDefault()
    buttons[
      (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    ]?.focus()
  }
  return (
    <div className={home ? 'catalog-home' : 'catalog-anchor'}>
      {!home && (
        <button
          ref={trigger}
          className="repo-name catalog-trigger"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((value) => !value)}
        >
          {name} <span aria-hidden>▾</span>
        </button>
      )}
      {open && (
        <div
          ref={panel}
          className={`catalog-panel ${home ? 'catalog-inline' : ''}`}
          role={home ? 'region' : 'dialog'}
          aria-label="Local repositories"
          onKeyDown={keyboard}
        >
          <div className="catalog-heading">
            <strong>{manage ? 'Manage roots' : 'Open a repository'}</strong>
            {!home && (
              <button className="icon-button" aria-label="Close repository picker" onClick={close}>
                <Icon name="close" />
              </button>
            )}
          </div>
          {manage ? (
            <div className="catalog-settings">
              <p>
                Discover repositories under these folders. Each repository opens its main checkout.
              </p>
              {catalog?.roots.map((path) => (
                <div className="catalog-root" key={path}>
                  <span>{path}</span>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await request('roots', 'DELETE', { path })
                        receive(await request<CatalogPayload>('catalog'))
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  void act(async () => {
                    await request('roots', 'POST', { path: root })
                    setRoot('')
                    receive(await request<CatalogPayload>('catalog'))
                  })
                }}
              >
                <label>
                  Root folder
                  <input
                    aria-label="Root folder"
                    placeholder="~/dev"
                    value={root}
                    onChange={(event) => setRoot(event.target.value)}
                  />
                </label>
                <button className="button primary" disabled={busy || !root.trim()}>
                  Add root
                </button>
              </form>
              <label>
                Excluded directory names
                <textarea
                  aria-label="Excluded directory names"
                  value={exclusions}
                  onChange={(event) => setExclusions(event.target.value)}
                />
              </label>
              <p>
                One name per line. Ordinary hidden folders are included. Nested symlinks are
                skipped. .git is always excluded.
              </p>
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  void act(async () =>
                    receive(
                      await request<CatalogPayload>('discovery-settings', 'PUT', {
                        exclusions: exclusions
                          .split('\n')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      }),
                    ),
                  )
                }
              >
                Save exclusions
              </button>
              <button className="button" onClick={() => setManage(false)}>
                Back to repositories
              </button>
            </div>
          ) : (
            <>
              <input
                ref={search}
                className="catalog-search"
                aria-label="Search repositories"
                placeholder="Search repositories or paths…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {!catalog ? (
                <p className="catalog-empty">Loading local repositories…</p>
              ) : !repos.length ? (
                <div className="catalog-empty">
                  <strong>
                    {catalog.scan.active
                      ? 'Discovering repositories…'
                      : catalog.roots.length
                        ? 'No repositories found'
                        : 'Choose where your projects live'}
                  </strong>
                  <p>
                    {catalog.roots.length
                      ? 'Rescan or add another root folder.'
                      : 'Add a folder such as ~/dev to find repositories.'}
                  </p>
                </div>
              ) : (
                <div className="catalog-repos" aria-label="Repositories">
                  {destinations.length === 0 && (
                    <p className="catalog-empty">No matching repositories</p>
                  )}
                  {destinations.map(({ repo, worktree: w }) => {
                    const status = w ? statuses[w.id] : undefined
                    const current = repo.worktrees.some((checkout) => checkout.id === repoId)
                    const favorite = catalog.favorites.includes(repo.id)
                    return (
                      <div className="catalog-repo-row" key={repo.id}>
                        <button
                          className="catalog-repo"
                          disabled={busy || !w}
                          onClick={() => w && navigate(w)}
                          aria-current={current ? 'page' : undefined}
                        >
                          <span className="catalog-repo-title">
                            <Icon name="file" /> {repo.name}
                            {current && <small>Current</small>}
                          </span>
                          <span className="catalog-path">{w?.path ?? repo.commonDir}</span>
                          <span className="catalog-status">
                            {!w
                              ? 'No main checkout'
                              : !w.available
                                ? 'Unavailable — retry opening to check'
                                : status?.error
                                  ? 'Status unavailable'
                                  : !status
                                    ? 'Checking status…'
                                    : status.conflicts || status.tracked || status.untracked
                                      ? `${status.tracked} modified · ${status.untracked} untracked · ${status.conflicts} conflicts`
                                      : 'Clean'}
                          </span>
                        </button>
                        <button
                          className="catalog-favorite icon-button"
                          aria-label={`${favorite ? 'Remove' : 'Add'} ${repo.name} ${favorite ? 'from' : 'to'} favorites`}
                          aria-pressed={favorite}
                          title={favorite ? 'Remove from favorites' : 'Add to favorites'}
                          disabled={busy}
                          onClick={() =>
                            void act(async () =>
                              receive(
                                await request<CatalogPayload>('catalog/favorite', 'PUT', {
                                  id: repo.id,
                                  favorite: !favorite,
                                }),
                              ),
                            )
                          }
                        >
                          <svg
                            className="icon"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                            fill={favorite ? 'currentColor' : 'none'}
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinejoin="round"
                          >
                            <path d="m12 3 2.8 5.7 6.3.9-4.55 4.45 1.07 6.25L12 17.35l-5.62 2.95 1.07-6.25L2.9 9.6l6.3-.9Z" />
                          </svg>
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
          {error && (
            <div className="warning" role="alert">
              {error}
              {destination && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => navigate(destination, true)}
                >
                  Retry opening
                </button>
              )}
            </div>
          )}
          {!!catalog?.scan.errors.length && (
            <details className="warning catalog-scan-errors">
              <summary>
                {catalog.scan.errors.length} discovery{' '}
                {catalog.scan.errors.length === 1 ? 'warning' : 'warnings'} — show details
              </summary>
              <div className="catalog-scan-error-list">
                {catalog.scan.errors.map((failure, index) => (
                  <p className="catalog-scan-error" key={`${failure.path}-${index}`}>
                    <strong>{failure.path}</strong>
                    <span>{failure.message}</span>
                  </p>
                ))}
              </div>
            </details>
          )}
          <footer className="catalog-footer">
            <span>
              {catalog?.roots.length ?? 0} roots ·{' '}
              {catalog?.scan.active
                ? `Scanning… ${catalog.scan.visited} folders`
                : catalog?.scan.finishedAt
                  ? 'Scan complete'
                  : 'Ready'}
            </span>
            <button
              className="button"
              disabled={busy || catalog?.scan.active}
              onClick={() => void rescan()}
            >
              Rescan
            </button>
            <button
              className="button"
              disabled={busy || catalog?.scan.active}
              title="Clear the catalogue and rediscover repositories using your roots and exclusions. Files and reviews are kept."
              onClick={() =>
                void act(async () => {
                  setStatuses({})
                  receive(await request<CatalogPayload>('catalog/reset', 'POST'))
                })
              }
            >
              Clear &amp; rescan
            </button>
            <button
              className="button"
              onClick={() => {
                setExclusions(catalog?.exclusions.join('\n') ?? '')
                setManage(true)
              }}
            >
              Manage roots
            </button>
          </footer>
        </div>
      )}
    </div>
  )
}
