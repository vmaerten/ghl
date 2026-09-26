import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:process'

import { launch, type Browser, type Page } from 'puppeteer-core'

import { resolveRepoRoot } from '../src/git.ts'
import { createGhlServer, listen, repoIdFor } from '../src/server.ts'

/** Where Chrome usually lives, unless CHROME_PATH says otherwise. */
const CHROME_CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
}

export function findChrome(): string {
  const fromEnv = process.env.CHROME_PATH
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`CHROME_PATH does not exist: ${fromEnv}`)
    return fromEnv
  }
  const found = (CHROME_CANDIDATES[platform] ?? []).find((path) => existsSync(path))
  if (!found) throw new Error(`no Chrome found on ${platform}; set CHROME_PATH`)
  return found
}

export interface Harness {
  page: Page
  /**
   * The fixture being served.
   *
   * Exposed so a suite can change the repository under the UI — the only way to
   * exercise anything that reacts to the code moving. A suite that dirties it
   * owes the next one a clean tree, since the fixture is built once per run.
   */
  repoPath: string
  /** URL of the served repository, with an optional query string. */
  url: (query?: string) => string
  /** Everything the page logged as an error or threw. */
  errors: string[]
  /** Load the UI and wait for the tree, which is the last thing to appear. */
  load: (query?: string) => Promise<void>
}

export interface Suite {
  name: string
  run: (harness: Harness, check: Check) => Promise<void>
}

export type Check = (name: string, ok: boolean, detail?: string) => void

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export { sleep }

/**
 * Serve `repoPath` and drive it with one browser, reused across suites.
 *
 * The server runs in this process rather than as a child: the suites are about
 * the UI, and a spawned CLI only adds a port to guess and a signal to forward.
 */
export async function withHarness<T>(
  repoPath: string,
  body: (make: (target?: string) => Promise<Harness>, browser: Browser) => Promise<T>,
): Promise<T> {
  repoPath = await resolveRepoRoot(repoPath)
  const discoveryDir = mkdtempSync(join(tmpdir(), 'ghl-browser-catalog-'))
  const server = createGhlServer({
    repos: [{ repoPath }],
    catalogPaths: {
      config: join(discoveryDir, 'config.json'),
      cache: join(discoveryDir, 'cache.json'),
    },
  })
  const port = await listen(server, 0)
  const base = `http://127.0.0.1:${port}/r/${repoIdFor(repoPath)}`

  const browser = await launch({
    executablePath: findChrome(),
    headless: 'shell',
    args: ['--no-sandbox'],
    defaultViewport: { width: 1600, height: 1000 },
  })

  try {
    const make = async (target?: string): Promise<Harness> => {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', (error) => {
        errors.push(error instanceof Error ? error.message : String(error))
      })
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`console: ${message.text()}`)
      })

      const url = (query?: string) => {
        const suffix = query ?? (target ? `?target=${encodeURIComponent(target)}` : '')
        return `${base}${suffix}`
      }

      const load = async (query?: string) => {
        // Fixture navigation must wait for writes triggered by the preceding UI action.
        // The page correctly guards unload while those writes are still pending.
        await page.waitForNetworkIdle({ idleTime: 100 })
        await page.goto(url(query), { waitUntil: 'networkidle0' })
        await page.waitForSelector('file-tree-container', { timeout: 30_000 })
        // The tree mounts before Shiki has finished with the diff pane.
        await sleep(2500)
      }

      return { page, repoPath, url, errors, load }
    }

    return await body(make, browser)
  } finally {
    await browser.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(discoveryDir, { recursive: true, force: true })
  }
}

/**
 * Rows currently mounted in the tree, which lives in a shadow DOM.
 *
 * `name` is read from `aria-label` rather than `textContent`: the row renders
 * its name twice for overflow measurement, so the text is doubled.
 */
export const TREE_ROWS = `(() => {
  const root = document.querySelector('file-tree-container')?.shadowRoot
  if (!root) return { rows: [], dirs: [], files: [], selected: [], icons: 0 }
  const items = [...root.querySelectorAll('[role="treeitem"]')]
  const rows = items.map((el) => ({
    name: el.getAttribute('aria-label') ?? '',
    path: el.getAttribute('data-item-path') ?? '',
    kind: el.getAttribute('data-item-type') ?? '',
    status: el.getAttribute('data-item-git-status'),
    open: el.getAttribute('aria-expanded') === 'true',
    selected: el.getAttribute('aria-selected') === 'true',
    decoration: el.textContent ?? '',
  }))
  return {
    rows,
    dirs: rows.filter((r) => r.kind === 'folder'),
    files: rows.filter((r) => r.kind === 'file'),
    selected: rows.filter((r) => r.selected),
    icons: root.querySelectorAll('svg').length,
  }
})()`

/** What the topbar says about the review, as several suites need to read it. */
export interface TopbarState {
  base: string | null
  target: string | null
  files: string | null
  notes: string[]
  /** The stack chain: its trunk, then one entry per layer. Empty without one. */
  trunk: string | null
  layers: { name: string; pr: string | null; current: boolean; merged: boolean; gone: boolean }[]
  /** The revision group's scope checkboxes, in order. */
  toggles: { label: string; pressed: boolean; off: boolean }[]
  search: string
}

/**
 * Read the topbar.
 *
 * Shared rather than repeated per suite: the selectors and the caret stripping
 * are markup details, and a change to the header would otherwise have to be
 * chased through every suite that reads a revision back.
 */
export function topbar(page: Page): Promise<TopbarState> {
  return page.evaluate(`(() => ({
    base: document.querySelector('.ref.base')?.textContent?.replace('▾', '').trim() ?? null,
    target: document.querySelector('.ref.target')?.textContent?.replace('▾', '').trim() ?? null,
    files: document.querySelector('.sidebar-head span')?.textContent?.trim() ?? null,
    notes: [...document.querySelectorAll('.source')].map((e) => e.textContent.trim()),
    trunk: document.querySelector('.stack > span')?.textContent?.trim() ?? null,
    layers: [...document.querySelectorAll('.stack-layer')].map((e) => ({
      name: e.querySelector('.stack-name')?.textContent?.trim() ?? '',
      pr: e.querySelector('.stack-pr')?.textContent?.trim() ?? null,
      current: e.classList.contains('current'),
      merged: e.classList.contains('merged'),
      gone: e.querySelector('.stack-name')?.disabled === true,
    })),
    toggles: [...document.querySelectorAll('.revision .scope-check input')].map((e) => ({
      label: e.closest('label')?.textContent?.trim() ?? '',
      pressed: e.checked === true,
      off: e.disabled,
    })),
    search: location.search,
  }))()`) as Promise<TopbarState>
}

/**
 * Open a picker and wait for what it is listing, not merely for a row.
 *
 * Waiting on `.picker-item` is not enough: both pickers render one entry
 * immediately — "this checkout", "All commits" — while the list itself is still
 * being fetched. A suite that typed into that gap selected the standing entry
 * whatever it typed, and then asserted against the wrong revision.
 */
export async function openPicker(page: Page, key: 'b' | 't' | 'l'): Promise<void> {
  await page.keyboard.press(key)
  await page.waitForSelector('.picker-input', { timeout: 15_000 })
  await page.waitForFunction(
    `!/Loading (refs|commits)/.test(document.querySelector('.picker-list')?.textContent ?? '')`,
    { timeout: 15_000 },
  )
  await page.waitForSelector('.picker-item', { timeout: 15_000 })
}

/**
 * Wait until the tree has rows again.
 *
 * Switching the reviewed revision tears the tree down and rebuilds it, and a
 * fixed delay reads it mid-flight — as an empty list, which then looks like a
 * lost fold rather than a race.
 */
export async function waitForRows(page: Page, timeoutMs = 20_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { rows } = (await page.evaluate(TREE_ROWS)) as { rows: TreeRow[] }
    if (rows.length > 0) return rows.length
    if (Date.now() > deadline) return 0
    await sleep(250)
  }
}

/**
 * Every row in the tree, not only the mounted window.
 *
 * The tree virtualises, so a row can be absent from the DOM simply for sitting
 * below the fold — which is how an assertion on "the file I just marked" fails
 * for the wrong reason.
 */
export async function allTreeRows(page: Page): Promise<TreeRow[]> {
  const height = (await page.evaluate(`${TREE_SCROLLER}.scrollHeight`)) as number
  const seen = new Map<string, TreeRow>()
  for (let top = 0; top <= height; top += 400) {
    await page.evaluate(`${TREE_SCROLLER}.scrollTop = ${top}`)
    await sleep(150)
    const { rows } = (await page.evaluate(TREE_ROWS)) as { rows: TreeRow[] }
    for (const row of rows) seen.set(row.path, row)
  }
  await page.evaluate(`${TREE_SCROLLER}.scrollTop = 0`)
  await sleep(200)
  return [...seen.values()]
}

export interface TreeRow {
  name: string
  path: string
  kind: string
  status: string | null
  open: boolean
  selected: boolean
  decoration: string
}

/** The tree's own scroller, the element that proves it virtualises. */
export const TREE_SCROLLER = `document.querySelector('file-tree-container').shadowRoot
  .querySelector('[data-file-tree-virtualized-scroll]')`

/**
 * Click a file's row in the tree, wherever it is.
 *
 * The tree virtualises, so a row below the fold is not in the DOM at all and
 * `querySelector(...)?.click()` silently does nothing — a test written that way
 * asserts against a click that never happened. Returns false when the path is
 * genuinely absent, which is a different failure and should read differently.
 */
export async function clickTreeRow(page: Page, path: string): Promise<boolean> {
  const attempt = () =>
    page.evaluate(`(() => {
      const root = document.querySelector('file-tree-container')?.shadowRoot
      const row = root?.querySelector('[data-item-path="' + ${JSON.stringify(path)} + '"]')
      if (!row) return false
      row.click()
      return true
    })()`) as Promise<boolean>

  if (await attempt()) return true

  const box = (await page.evaluate(`(() => {
    const el = ${TREE_SCROLLER}
    return el ? { height: el.scrollHeight, viewport: el.clientHeight } : null
  })()`)) as { height: number; viewport: number } | null
  if (!box) return false

  const step = Math.max(100, Math.round(box.viewport * 0.8))
  for (let top = 0; top <= box.height; top += step) {
    await page.evaluate(`(() => { ${TREE_SCROLLER}.scrollTop = ${top} })()`)
    await sleep(120)
    if (await attempt()) return true
  }
  return false
}

/**
 * The diff pane's own scroller, the element CodeView computes its window from.
 *
 * Scoped to `.diff` on purpose: the sidebar scrolls too, and searching the whole
 * document silently returned the file tree instead.
 */
export const DIFF_SCROLLER = `(() => {
  const pane = document.querySelector('.diff')
  if (!pane) return null
  return [pane, ...pane.querySelectorAll('*')].find((el) => {
    const cs = getComputedStyle(el)
    return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
           el.scrollHeight > el.clientHeight + 20
  }) ?? null
})()`

/** Each mounted file, read from its own shadow root, with its coloured spans. */
const DIFF_FILES = `(() => {
  const pane = document.querySelector('.diff')
  if (!pane) return []
  return [...pane.querySelectorAll('diffs-container')].map((host) => ({
    name: (host.shadowRoot?.querySelector('[data-title]')?.textContent ?? '').trim(),
    spans: host.shadowRoot?.querySelectorAll('span[style]').length ?? 0,
  }))
})()`

export interface DiffFile {
  name: string
  /** Coloured tokens. Zero means the file rendered, but empty. */
  spans: number
}

/**
 * The files actually intersecting the viewport right now.
 *
 * Distinct from `allDiffFiles`, which walks the whole scroll: this one answers
 * "did the pane move to it", not "does it exist somewhere". Counting characters
 * instead was not enough — when the virtual window froze, the sticky header
 * dragged the same block along and the count came back identical at every
 * scroll position.
 */
export const DIFF_ON_SCREEN = `(() => {
  const el = ${DIFF_SCROLLER}
  if (!el) return []
  const box = el.getBoundingClientRect()
  const names = []
  for (const host of el.querySelectorAll('diffs-container')) {
    const r = host.getBoundingClientRect()
    if (r.bottom <= box.top || r.top >= box.bottom || r.height === 0) continue
    const title = host.shadowRoot?.querySelector('[data-title]')
    names.push((title?.textContent ?? '').trim())
  }
  return names
})()`

/**
 * Every file the diff pane renders, not only the mounted window.
 *
 * Asserting a file is *there* needs the whole scroll just as much as asserting
 * it is absent: the pane virtualises, so at rest it holds four files out of
 * fifty. The step stays under one viewport so nothing slips between samples.
 *
 * It moves the pane and leaves it back at the top, so anything asserting *where
 * the reader is* has to be read before this runs, never after — otherwise it
 * measures this helper rather than the application.
 */
export async function allDiffFiles(page: Page): Promise<DiffFile[]> {
  const seen = new Map<string, DiffFile>()
  const collect = async () => {
    for (const file of (await page.evaluate(DIFF_FILES)) as DiffFile[]) {
      if (!file.name) continue
      // Keep the richest reading: a file caught mid-render reports no spans yet.
      const previous = seen.get(file.name)
      if (!previous || file.spans > previous.spans) seen.set(file.name, file)
    }
  }

  const box = (await page.evaluate(`(() => {
    const el = ${DIFF_SCROLLER}
    return el ? { height: el.scrollHeight, viewport: el.clientHeight } : null
  })()`)) as { height: number; viewport: number } | null

  await collect()
  if (!box) return [...seen.values()]

  const step = Math.max(200, Math.round(box.viewport * 0.8))
  for (let top = 0; top <= box.height; top += step) {
    await page.evaluate(`(() => { const el = ${DIFF_SCROLLER}; if (el) el.scrollTop = ${top} })()`)
    await sleep(200)
    await collect()
  }
  await page.evaluate(`(() => { const el = ${DIFF_SCROLLER}; if (el) el.scrollTop = 0 })()`)
  await sleep(200)
  return [...seen.values()]
}
