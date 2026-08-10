import {
  allDiffFiles,
  clickTreeRow,
  openPicker,
  sleep,
  waitForRows,
  TREE_ROWS,
  type Suite,
  type TreeRow,
} from '../harness.ts'

/** Files of the fixture holding this, and nothing else does. */
const QUERY = 'core'

interface Rows {
  rows: TreeRow[]
  dirs: TreeRow[]
  files: TreeRow[]
  selected: TreeRow[]
}

export default {
  name: 'filter',
  async run({ page, load }, check) {
    await load()

    const rows = () => page.evaluate(TREE_ROWS) as Promise<Rows>
    const filterState = () =>
      page.evaluate(`(() => ({
        focused: document.activeElement?.getAttribute('aria-label') ?? null,
        value: document.querySelector('.tree-filter input')?.value ?? null,
        count: document.querySelector('.tree-filter .count')?.textContent ?? null,
        empty: document.querySelector('.tree-empty')?.textContent ?? null,
      }))()`) as Promise<{
        focused: string | null
        value: string | null
        count: string | null
        empty: string | null
      }>

    const everything = await rows()

    // 1 — `/` reaches the field, and the field takes the text.
    await page.keyboard.press('/')
    await sleep(200)
    check('slash focuses the filter', (await filterState()).focused === 'Filter files')

    await page.keyboard.type(QUERY)
    await sleep(400)
    const filtered = await rows()
    check(
      'typing hides everything that does not match',
      filtered.files.length > 0 && filtered.files.every((row) => row.path.includes(QUERY)),
      filtered.files.map((row) => row.path).join(', '),
    )
    check(
      '  and the tree keeps its shape',
      filtered.dirs.some((row) => row.path === 'src/'),
      filtered.dirs.map((row) => row.path).join(', '),
    )
    // The denominator is every file in the diff, not the rows on screen: the tree
    // virtualises, so `everything.files` is a window and would undercount.
    const total = (await page.evaluate(
      `parseInt(document.querySelector('.sidebar-head span').textContent, 10)`,
    )) as number
    const state = await filterState()
    check(
      'the count says how much is left',
      state.count === `${filtered.files.length}/${total}`,
      `${state.count} for ${filtered.files.length} of ${total}`,
    )

    // 2 — the diff pane is untouched. Read before anything asserts on scroll
    // position: this walks the whole pane and comes back to the top.
    const mounted = await allDiffFiles(page)
    check(
      'the diff pane still holds the files the filter hides',
      mounted.some((file) => !file.name.includes(QUERY)),
      `${mounted.length} files, e.g. ${mounted.find((f) => !f.name.includes(QUERY))?.name}`,
    )

    // 3 — the keyboard comes back with Enter, and the cursor stays in the subset.
    await page.keyboard.press('Enter')
    await sleep(200)
    check('Enter hands the keyboard back', (await filterState()).focused === null)
    check('  and keeps the filter', (await filterState()).value === QUERY)

    const walked: string[] = []
    for (let i = 0; i < filtered.files.length + 3; i++) {
      await page.keyboard.press('j')
      await sleep(250)
      const selected = (await rows()).selected[0]?.path
      if (selected) walked.push(selected)
    }
    check(
      'j never leaves the filter',
      walked.length > 0 && walked.every((path) => path.includes(QUERY)),
      [...new Set(walked)].join(', '),
    )
    check(
      '  and stops at the last match instead of walking out',
      walked.at(-1) === walked.at(-2),
      walked.slice(-3).join(' -> '),
    )

    // 4 — nothing matches: said out loud, since an empty tree reads as an empty diff.
    await page.keyboard.press('/')
    await page.keyboard.type('zzz-nothing')
    await sleep(400)
    const none = await filterState()
    check('no match is spelled out', none.empty === 'No file matches.', none.empty ?? 'nothing')
    // Not the row count: a query nothing answers is no query at all to the
    // library, which puts every row back. Hiding them is ours, so this asks the
    // only thing that changed.
    const treeDisplay = await page.evaluate(
      `getComputedStyle(document.querySelector('.tree')).display`,
    )
    check('  and no tree is shown under it', treeDisplay === 'none', String(treeDisplay))

    // 5 — Escape gives everything back.
    await page.keyboard.press('Escape')
    await sleep(400)
    const cleared = await rows()
    check(
      'Escape clears the filter',
      cleared.files.length === everything.files.length,
      `${cleared.files.length} of ${everything.files.length}`,
    )
    check('  and lets go of the keyboard', (await filterState()).focused === null)

    // 6 — the folds are the reader's, not the filter's.
    //
    // A filter unfolds the ancestors of what it keeps and shuts everything else.
    // Recorded as the reader's own folding, that loses every fold nested inside
    // another one: the library puts its snapshot back when the filter clears, but
    // a fold inside a fold never returns to the visible rows, so it is never
    // recorded again — and the next `resetPaths` opens it. Reviewing another
    // revision and coming back is what reaches `resetPaths`; an identical file
    // list is reused as is.
    //
    // The selection is parked outside `src/` first: closing a filter also
    // reopens the ancestors of the selected file, on purpose, and with the
    // cursor left on `src/core/parser.ts` this would measure that rather than
    // the fold bookkeeping.
    await clickTreeRow(page, 'web/components/NewPanel.tsx')
    await sleep(300)
    await page.evaluate(
      `[...document.querySelectorAll('.sidebar-head button')]
         .find((b) => b.textContent.includes('Collapse')).click()`,
    )
    await sleep(400)
    await page.keyboard.press('/')
    await page.keyboard.type('tool')
    await sleep(400)
    await page.keyboard.press('Escape')
    await sleep(400)

    for (const revision of ['other', 'feature']) {
      await openPicker(page, 't')
      await page.keyboard.type(revision)
      await sleep(600)
      await page.keyboard.press('Enter')
      await waitForRows(page)
      await sleep(500)
    }

    // The fold under test is invisible until its parent is opened by hand — which
    // is the whole point: what cannot be seen is what stops being recorded.
    await clickTreeRow(page, 'src/')
    await sleep(400)
    const nested = (await rows()).dirs.find((row) => row.path === 'src/util/deep/nested/')
    check(
      'a fold nested in a fold survives a filter',
      nested !== undefined && !nested.open,
      nested ? `${nested.open ? 'reopened' : 'still folded'}` : 'src/util/deep/nested/ not found',
    )
  },
} satisfies Suite
