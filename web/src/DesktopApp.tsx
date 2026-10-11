import { memo, useEffect, useRef, useState } from 'react'
import App from './App.tsx'
import Icon from './Icon.tsx'
import './desktop.css'
import type { ReviewSession, ReviewSessionHandle } from './reviewSession.ts'

interface ReviewTab {
  id: string
  name: string
  route: string
  view?: ReviewSession
}
interface Tabs {
  revision: number
  active: string
  tabs: ReviewTab[]
}
interface DesktopAPI {
  Tabs(): Promise<Tabs>
  ActivateTab(id: string): Promise<Tabs>
  CloseTab(id: string): Promise<Tabs>
  UpdateTabURL(id: string, route: string): Promise<Tabs>
  OpenRepository(): Promise<void>
  SaveTabView(id: string, raw: string): Promise<void>
}
declare global {
  interface Window {
    go?: { main: { desktopApp: DesktopAPI } }
    runtime?: {
      EventsOn(name: string, callback: (state: Tabs) => void): () => void
      WindowSetTitle(title: string): void
    }
  }
}
const EMPTY: Tabs = { revision: 0, active: '', tabs: [] }
const Review = memo(App)

export default function DesktopApp() {
  const [state, setState] = useState(EMPTY)
  const latest = useRef(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const accept = useRef<(state: Tabs) => void>(() => {})
  const sessions = useRef(new Map<string, ReviewSession>())
  const sessionHandle = useRef<ReviewSessionHandle>(null)
  useEffect(() => {
    const api = window.go?.main.desktopApp
    const runtime = window.runtime
    if (!api || !runtime) {
      setError('Desktop runtime is unavailable')
      return
    }
    let disposed = false
    const save = async () => {
      const id = latest.current.active
      if (
        !id ||
        document.querySelector('.desktop-review')?.getAttribute('data-active-tab') !== id ||
        !sessionHandle.current
      )
        return
      const view = sessionHandle.current.capture()
      sessions.current.set(id, view)
      await api.SaveTabView(id, JSON.stringify(view))
    }
    const update = (next: Tabs) => {
      if (disposed || next.revision < latest.current.revision) return
      const previous = latest.current
      if (
        previous.active &&
        previous.active !== next.active &&
        next.tabs.some((tab) => tab.id === previous.active)
      )
        void save().catch((cause) => setError(String(cause)))
      for (const id of sessions.current.keys())
        if (!next.tabs.some((tab) => tab.id === id)) sessions.current.delete(id)
      latest.current = next
      const active = next.tabs.find((tab) => tab.id === next.active)
      if (active && !sessions.current.has(active.id))
        sessions.current.set(
          active.id,
          active.view?.version === 1
            ? active.view
            : {
                version: 1,
                diffStyle: 'unified',
                commentsOpen: false,
                panelEditor: { editing: null, draft: '' },
                scrollTop: 0,
                composer: null,
                drafts: [],
                expansions: [],
              },
        )
      runtime.WindowSetTitle(
        active ? `ghl — ${active.name} (prototype)` : 'ghl — desktop prototype',
      )
      // Update the URL before mounting App; its selection is seeded at mount.
      if (previous.active !== next.active) history.replaceState(null, '', active?.route ?? '/')
      setState(next)
    }
    accept.current = update
    const unsubscribe = runtime.EventsOn('desktop:tabs', update)
    void api
      .Tabs()
      .then(update)
      .catch((cause) => setError(String(cause)))
    const selectionChanged = () => {
      const active = latest.current.tabs.find((tab) => tab.id === latest.current.active)
      const route = location.pathname + location.search
      if (active && active.route !== route)
        void api
          .UpdateTabURL(active.id, route)
          .then(update)
          .catch((cause) => setError(String(cause)))
    }
    window.addEventListener('desktop:selection', selectionChanged)
    const reload = () => {
      void save()
        .then(() => location.reload())
        .catch((cause) => setError(String(cause)))
    }
    const closeActive = () => {
      void api
        .CloseTab(latest.current.active)
        .then(update)
        .catch((cause) => setError(String(cause)))
    }
    const cycle = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.key !== 'Tab' || latest.current.tabs.length < 2) return
      event.preventDefault()
      const tabs = latest.current.tabs
      const index = tabs.findIndex((tab) => tab.id === latest.current.active)
      const next = tabs[(index + tabs.length + (event.shiftKey ? -1 : 1)) % tabs.length]
      if (next)
        void api
          .ActivateTab(next.id)
          .then(update)
          .catch((cause) => setError(String(cause)))
    }
    window.addEventListener('desktop:reload', reload)
    window.addEventListener('desktop:close-active', closeActive)
    window.addEventListener('keydown', cycle)
    return () => {
      disposed = true
      unsubscribe()
      window.removeEventListener('desktop:selection', selectionChanged)
      window.removeEventListener('desktop:reload', reload)
      window.removeEventListener('desktop:close-active', closeActive)
      window.removeEventListener('keydown', cycle)
    }
  }, [])
  const activate = (id: string) => {
    void window.go?.main.desktopApp
      .ActivateTab(id)
      .then(accept.current)
      .catch((cause) => setError(String(cause)))
  }
  const close = (id: string) => {
    void window.go?.main.desktopApp
      .CloseTab(id)
      .then(accept.current)
      .catch((cause) => setError(String(cause)))
  }
  const open = () => {
    void window.go?.main.desktopApp.OpenRepository().catch((cause) => setError(String(cause)))
  }
  const active = state.tabs.find((tab) => tab.id === state.active)
  return (
    <div className="desktop-shell">
      <div className="desktop-tabbar">
        <div role="tablist" aria-label="Open reviews" className="desktop-tabs">
          {state.tabs.map((tab, index) => {
            const query = new URL(tab.route, location.href).searchParams
            const comparison = `${query.get('base') ?? 'Auto base'} → ${query.get('target') ?? 'Working tree'}`
            return (
              <div
                className={`desktop-tab ${tab.id === state.active ? 'active' : ''}`}
                key={tab.id}
              >
                <button
                  role="tab"
                  id={`review-tab-${tab.id}`}
                  aria-selected={tab.id === state.active}
                  aria-controls="desktop-review"
                  tabIndex={tab.id === state.active ? 0 : -1}
                  title={`${tab.name} · ${comparison}`}
                  onClick={() => activate(tab.id)}
                  onKeyDown={(event) => {
                    let next: number | undefined
                    if (event.key === 'ArrowRight') next = (index + 1) % state.tabs.length
                    if (event.key === 'ArrowLeft')
                      next = (index + state.tabs.length - 1) % state.tabs.length
                    if (event.key === 'Home') next = 0
                    if (event.key === 'End') next = state.tabs.length - 1
                    if (next === undefined) return
                    event.preventDefault()
                    event.stopPropagation()
                    const nextTab = state.tabs[next]
                    if (!nextTab) return
                    activate(nextTab.id)
                    document.getElementById(`review-tab-${nextTab.id}`)?.focus()
                  }}
                >
                  <span>{tab.name}</span>
                  <small>{comparison}</small>
                </button>
                <button
                  className="desktop-tab-close"
                  aria-label={`Close ${tab.name}`}
                  title="Close review"
                  onClick={() => close(tab.id)}
                >
                  <Icon name="close" />
                </button>
              </div>
            )
          })}
        </div>
        <button
          className="desktop-open"
          aria-label="Open repository"
          title="Open repository (⌘O)"
          onClick={open}
        >
          +
        </button>
      </div>
      {error ? (
        <p role="alert" className="desktop-error">
          {error}
          <button onClick={() => setError(null)}>Dismiss</button>
        </p>
      ) : null}
      {active ? (
        <div
          role="tabpanel"
          id="desktop-review"
          className="desktop-review"
          aria-labelledby={`review-tab-${active.id}`}
          data-active-tab={active.id}
        >
          <Review
            key={active.id}
            session={sessions.current.get(active.id)}
            sessionHandle={sessionHandle}
          />
        </div>
      ) : (
        <div className="desktop-empty">
          <h1>ghl</h1>
          <p>Open a repository to start a review.</p>
          <button className="button primary" onClick={open}>
            Open repository…
          </button>
        </div>
      )}
    </div>
  )
}
