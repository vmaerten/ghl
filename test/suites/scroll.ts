import { DIFF_SCROLLER as SCROLLER, sleep, type Suite } from '../harness.ts'

/**
 * Which files are painted right now.
 *
 * Each file is a `diffs-container` with its own shadow root, and its name sits
 * on `[data-title]` inside it. Counting characters instead was not enough: when
 * the virtual window froze, the sticky header dragged the same block along and
 * the count came back identical at every scroll position.
 */
const ON_SCREEN = `(() => {
  const el = ${SCROLLER}
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

export default {
  name: 'scroll',
  async run({ page, load }, check) {
    await load()
    await page.waitForSelector('.viewed-toggle input', { timeout: 30_000 })
    await sleep(1500)

    const scrollable = (await page.evaluate(`Boolean(${SCROLLER})`)) as boolean
    check('the diff pane has a scroller of its own', scrollable)
    if (!scrollable) return

    const at = async (ratio: number) => {
      await page.evaluate(`(() => {
        const el = ${SCROLLER}
        el.scrollTop = (el.scrollHeight - el.clientHeight) * ${ratio}
      })()`)
      await sleep(900)
      return (await page.evaluate(ON_SCREEN)) as string[]
    }

    const top = await at(0)
    check('files are painted at the top', top.length > 0, top.slice(0, 2).join(' | '))

    const middle = await at(0.5)
    check(
      'scrolling changes which files are on screen',
      middle.length > 0 && middle.join() !== top.join(),
      `${top[0] ?? '?'} -> ${middle[0] ?? '?'}`,
    )

    const bottom = await at(0.98)
    check(
      'and the end differs from the middle',
      bottom.length > 0 && bottom.join() !== middle.join(),
      bottom.slice(0, 2).join(' | '),
    )

    // The window must not have grown into the whole diff along the way.
    const mounted = (await page.evaluate(
      `${SCROLLER}.querySelectorAll('diffs-container').length`,
    )) as number
    const claimed = (await page.evaluate(
      `parseInt(document.querySelector('.sidebar-head span').textContent, 10)`,
    )) as number
    check(
      'the diff stays virtualised to the end',
      mounted > 0 && mounted < claimed,
      `${mounted} files mounted of ${claimed}`,
    )
  },
} satisfies Suite
