import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'

import {
  askDefinition,
  askHover,
  CACHE_LIMIT,
  HIDE_DELAY_MS,
  HOVER_DELAY_MS,
  inlineCode,
  isEmpty,
  isIdentifier,
  positionKey,
  type TokenAt,
} from './codeNav.ts'
import type { LspHoverPayload, LspLocation } from '../../src/types.ts'

/**
 * The hover card, and everything that decides whether it is on screen.
 *
 * A leaf of its own, driven imperatively, because this state changes on every
 * token the pointer crosses: held in `App` it would rebuild the `CodeView`
 * options on each move, and the pane re-reads its items when they change. `App`
 * only ever calls the handle below, with callbacks whose identity never moves.
 *
 * It paints into a portal on `document.body`. The diff's DOM lives in shadow
 * roots whose hosts `CodeView` recycles as it scrolls, so nothing drawn into it
 * would survive — and an annotation, the one supported way in, anchors to a line
 * rather than to a column and would push the code down under the pointer.
 */

export interface CodeNavHandle {
  enter(at: TokenAt, rect: DOMRect): void
  leave(): void
  /** ⌘/Ctrl-click: ask where this is defined, and hold the card open for the answer. */
  jump(at: TokenAt, rect: DOMRect): void
  /** The anchor is gone or has moved under us — a scroll, a refresh, a new revision. */
  hide(): void
}

type Card =
  | { kind: 'loading' }
  | { kind: 'hover'; hover: LspHoverPayload }
  | { kind: 'target'; at: TokenAt; target: LspLocation | null; note: string | null }

interface Props {
  ref: Ref<CodeNavHandle>
  /** Null before the URL has been read, which is also before anything can answer. */
  repoId: string | null
  /** The same query the diff was fetched with, so both describe one comparison. */
  query: string
  /** True while a language server can answer for this view; false switches everything off. */
  enabled: boolean
  /** Take the reader to a definition. Returns why it could not, or null on success. */
  onGoTo: (target: LspLocation) => string | null
}

export default function CodeNav({ ref, repoId, query, enabled, onGoTo }: Props) {
  const [card, setCard] = useState<Card | null>(null)
  const [pinned, setPinned] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  /** Everything that must not repaint the card when it changes. */
  const live = useRef({
    seq: 0,
    key: null as string | null,
    controller: null as AbortController | null,
    show: null as ReturnType<typeof setTimeout> | null,
    hide: null as ReturnType<typeof setTimeout> | null,
    cache: new Map<string, LspHoverPayload>(),
    rect: null as DOMRect | null,
  })

  const clearTimers = () => {
    const state = live.current
    if (state.show) clearTimeout(state.show)
    if (state.hide) clearTimeout(state.hide)
    state.show = null
    state.hide = null
  }

  const close = useCallback(() => {
    clearTimers()
    live.current.controller?.abort()
    live.current.controller = null
    live.current.key = null
    live.current.seq += 1
    setPinned(false)
    setCard(null)
  }, [])

  /**
   * Position written straight to the node, never through state.
   *
   * Same reason as the sidebar handle: this moves with the pointer, and a render
   * per move is a render of everything this component could ever hold.
   */
  const placeAt = (rect: DOMRect) => {
    live.current.rect = rect
    const box = boxRef.current
    if (!box) return
    box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 460))}px`
    box.style.top = `${rect.bottom + 6}px`
  }

  useEffect(() => {
    if (card && live.current.rect) placeAt(live.current.rect)
  }, [card])

  const remember = (key: string, hover: LspHoverPayload) => {
    const { cache } = live.current
    // Oldest first, and one at a time: the map is a queue that happens to be
    // keyed. A session reading a large diff would otherwise hold every hover it
    // ever provoked.
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, hover)
  }

  useImperativeHandle(
    ref,
    () => ({
      enter(at, rect) {
        if (!enabled || repoId === null || pinned || !isIdentifier(at.text)) return

        const key = positionKey(at.path, at.line, at.column)
        clearTimers()
        const state = live.current
        if (key === state.key && card) return

        state.controller?.abort()
        state.controller = null
        state.key = key
        const mine = ++state.seq

        const cached = state.cache.get(key)
        if (cached) {
          // No delay for an answer already in hand: a token revisited has to
          // feel like it was never gone.
          placeAt(rect)
          setCard(isEmpty(cached) ? null : { kind: 'hover', hover: cached })
          return
        }

        state.show = setTimeout(async () => {
          const controller = new AbortController()
          state.controller = controller
          try {
            const hover = await askHover(repoId, query, at, controller.signal)
            // Both guards: aborting a request whose body is already on the wire
            // still resolves, and the pointer may have come back to a third
            // token in between.
            if (mine !== state.seq || key !== state.key) return
            remember(key, hover)
            placeAt(rect)
            setCard(isEmpty(hover) ? null : { kind: 'hover', hover })
          } catch {
            // An abort, or a server that has nothing to say. Neither is news.
          }
        }, HOVER_DELAY_MS)
      },

      leave() {
        const state = live.current
        clearTimers()
        state.controller?.abort()
        state.controller = null
        state.key = null
        if (pinned) return
        state.hide = setTimeout(() => setCard(null), HIDE_DELAY_MS)
      },

      async jump(at, rect) {
        if (!enabled || repoId === null || !isIdentifier(at.text)) return
        clearTimers()
        const state = live.current
        state.controller?.abort()
        const controller = new AbortController()
        state.controller = controller
        const mine = ++state.seq
        state.key = positionKey(at.path, at.line, at.column)

        // Pinned before the answer arrives: it comes back after the pointer has
        // moved on, and an unpinned card would have nowhere left to appear.
        setPinned(true)
        placeAt(rect)
        setCard({ kind: 'loading' })

        try {
          const answer = await askDefinition(repoId, query, at, controller.signal)
          if (mine !== state.seq) return

          const target = answer.targets[0] ?? null
          if (!target) {
            setCard({ kind: 'target', at, target: null, note: 'no definition found' })
          } else if (target.path === at.path && target.line === at.line) {
            setCard({ kind: 'target', at, target, note: 'this is the definition' })
          } else {
            const refused = target.inDiff ? onGoTo(target) : 'this file is not in the diff'
            if (refused === null) close()
            else setCard({ kind: 'target', at, target, note: refused })
          }
        } catch {
          if (mine === state.seq) close()
        }
      },

      hide: close,
    }),
    [enabled, pinned, card, repoId, query, onGoTo, close],
  )

  /**
   * The pointer, shown only while the gesture that would act is held.
   *
   * A custom property on the root, because custom properties inherit across the
   * shadow boundary — so one DOM write reaches the rule the library injected
   * into every `diffs-container`, with no re-render and no cache to rebuild.
   */
  useEffect(() => {
    if (!enabled) return
    const root = document.documentElement
    const set = (on: boolean) =>
      on
        ? root.style.setProperty('--ghl-nav-cursor', 'pointer')
        : root.style.removeProperty('--ghl-nav-cursor')

    const onKey = (event: KeyboardEvent) => set(event.metaKey || event.ctrlKey)
    // Blur and visibility too: holding ⌘ while switching application never
    // sends the keyup, and the pointer would stay changed for good.
    const drop = () => set(false)

    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', drop)
    document.addEventListener('visibilitychange', drop)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', drop)
      document.removeEventListener('visibilitychange', drop)
      drop()
    }
  }, [enabled])

  useEffect(() => {
    if (!pinned) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pinned, close])

  if (!card) return null

  return createPortal(
    <div
      className="code-nav"
      ref={boxRef}
      onPointerEnter={clearTimers}
      onPointerLeave={() => {
        if (!pinned) live.current.hide = setTimeout(() => setCard(null), HIDE_DELAY_MS)
      }}
    >
      {card.kind === 'loading' && <p className="code-nav-note">looking…</p>}

      {card.kind === 'hover' && (
        <>
          {card.hover.signature !== null && (
            <pre className="code-nav-signature">{card.hover.signature}</pre>
          )}
          {card.hover.documentation !== null && (
            <p className="code-nav-doc">
              {inlineCode(card.hover.documentation).map((part, index) =>
                part.code ? (
                  <code key={index}>{part.text}</code>
                ) : (
                  <span key={index}>{part.text}</span>
                ),
              )}
            </p>
          )}
        </>
      )}

      {card.kind === 'target' && (
        <>
          <p className="code-nav-note">
            {card.target
              ? `${card.target.path}:${card.target.line} — ${card.note ?? ''}`
              : (card.note ?? '')}
          </p>
          {card.target && card.target.preview.length > 0 && (
            <pre className="code-nav-preview">
              {card.target.preview.map((text, index) => (
                <span
                  key={index}
                  className={
                    card.target!.previewStart + index === card.target!.line
                      ? 'code-nav-preview-line is-target'
                      : 'code-nav-preview-line'
                  }
                >
                  <span className="code-nav-preview-number">
                    {card.target!.previewStart + index}
                  </span>
                  {text}
                </span>
              ))}
            </pre>
          )}
          <button type="button" className="code-nav-close" onClick={close}>
            Close
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}
