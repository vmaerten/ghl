import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DIFF_SCROLLER, sleep, type Suite } from '../harness.ts'

/**
 * Code navigation, driven through the real routes and the scripted server.
 *
 * The assertions lean on two things that do not virtualise and do not live in a
 * shadow root: the presence of `data-char`, which exists only while the token
 * layer is on, and the network log, which says what was actually asked of the
 * server rather than what the DOM happens to look like.
 */

/** Every token the pane has mounted, with where it is on screen. */
const TOKENS = `(() => {
  const host = document.querySelector('diffs-container')
  if (!host?.shadowRoot) return []
  return [...host.shadowRoot.querySelectorAll('[data-char]')].map((el) => {
    const r = el.getBoundingClientRect()
    return {
      text: el.textContent,
      line: el.closest('[data-line]')?.getAttribute('data-line') ?? null,
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
    }
  })
})()`

/** What the page has asked of the language server so far. */
const CALLS = `performance.getEntriesByType('resource')
  .filter((e) => e.name.includes('/api/lsp/')).length`

const CARD = `document.querySelector('.code-nav')?.textContent ?? null`

interface Token {
  text: string
  line: string | null
  x: number
  y: number
}

export default {
  name: 'codenav',
  async run({ page, load, repoPath }, check) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath })
    const file = join(repoPath, 'Navigable.tsx')
    const tokens = () => page.evaluate(TOKENS) as Promise<Token[]>
    const calls = () => page.evaluate(CALLS) as Promise<number>
    const card = () => page.evaluate(CARD) as Promise<string | null>

    try {
      // The fixture sits on `main`, its own trunk, so a change to the working
      // tree is the whole of the bare URL's diff — and the working tree is the
      // one view whose line numbers a server reading the disk would agree with.
      //
      // Staged rather than left untracked: untracked files are kept out of the
      // diff by default, and the pane would have nothing to mount.
      // Long enough that the pane actually scrolls: the scroll assertion below
      // needs a scroller, and a two-line diff does not overflow anything.
      const filler = Array.from({ length: 200 }, (_, i) => `export const spare${i} = ${i}`)
      writeFileSync(
        file,
        ['export const answer = 42', 'export const doubled = answer * 2', ...filler, ''].join('\n'),
      )
      git('add', 'Navigable.tsx')

      // --- off wherever the disk is not what is on screen ---

      await load('?target=feature')
      const onARef = await tokens()
      check('reviewing a ref mounts no token layer at all', onARef.length === 0)
      check('  so nothing was asked of any language server', (await calls()) === 0)

      // --- on for the working tree ---

      await load('')
      const onTree = await tokens()
      check('the working tree mounts it', onTree.length > 0, `${onTree.length} tokens`)

      const identifier = onTree.find((token) => token.text === 'doubled')
      check('  and an identifier is among them', identifier !== undefined)
      if (!identifier) return

      // --- the hover, and what it costs ---

      await page.mouse.move(identifier.x, identifier.y)
      await sleep(1200)
      const shown = await card()
      check('hovering an identifier opens the card', shown !== null)
      check(
        '  carrying what the server said',
        shown?.includes('const answer: 42') === true,
        shown ?? '',
      )
      check('  after exactly one request', (await calls()) === 1, `${await calls()}`)

      // Sweeping the line fires `onTokenEnter` per token crossed; the debounce
      // is the only thing between that and a request per token.
      const before = await calls()
      for (const token of onTree.slice(0, 12)) await page.mouse.move(token.x, token.y)
      await sleep(1200)
      const swept = (await calls()) - before
      check('sweeping a line does not ask once per token', swept <= 2, `${swept} requests`)

      // --- what is never asked ---

      const punctuation = onTree.find(
        (token) => token.text !== null && /^[^\w$]+$/.test(token.text),
      )
      if (punctuation) {
        const quiet = await calls()
        await page.mouse.move(punctuation.x, punctuation.y)
        await sleep(900)
        check('punctuation is never worth a round trip', (await calls()) === quiet)
      }

      // --- scrolling drops it, because the host it was pinned to gets recycled ---

      const spent = await calls()
      await page.mouse.move(identifier.x, identifier.y)
      await sleep(900)
      check('the card is back for a second look', (await card()) !== null)
      check('  out of the cache, costing no request', (await calls()) === spent, `${await calls()}`)

      await page.evaluate(`(() => {
        const el = ${DIFF_SCROLLER}
        if (el) el.scrollTop += 200
      })()`)
      await sleep(500)
      check('scrolling drops it rather than trailing a recycled host', (await card()) === null)
    } finally {
      git('reset', '-q', '--', 'Navigable.tsx')
      rmSync(file, { force: true })
    }
  },
} satisfies Suite
