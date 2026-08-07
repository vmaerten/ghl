import { allDiffFiles, allTreeRows, sleep, type Suite } from '../harness.ts'

/** What the fixture puts in the diff that no one wrote by hand. */
const GENERATED = [
  'pnpm-lock.yaml',
  'dist/bundle.js',
  'src/api-types.ts',
  'web/components/__snapshots__/Widget0.test.tsx.snap',
]

/** Matches the `dist/` rule and is rescued by `-linguist-generated`. */
const KEPT = 'dist/hand-written.ts'

const basename = (path: string) => path.split('/').at(-1) ?? path

export default {
  name: 'generated',
  async run({ page, load }, check) {
    await load()

    const notice = () =>
      page.evaluate(`(() => {
        const el = [...document.querySelectorAll('.viewed-bar .notice')]
          .find((n) => n.textContent.includes('generated'))
        return el?.textContent?.trim() ?? null
      })()`) as Promise<string | null>

    const toggle = () =>
      page.evaluate(`(() => {
        const el = [...document.querySelectorAll('.viewed-bar .notice')]
          .find((n) => n.textContent.includes('generated'))
        el?.querySelector('button')?.click()
      })()`)

    const banner = await notice()
    check(
      'a bar reports how many generated files are hidden',
      banner?.startsWith(`${GENERATED.length} generated`) === true,
      banner ?? 'no bar',
    )

    // The pane virtualises, so absence has to be established across the whole
    // scroll — missing from the DOM here means nothing on its own.
    const rendered = await allDiffFiles(page)
    const leaked = GENERATED.filter((path) => rendered.some((n) => n.includes(basename(path))))
    check('none of them reaches the diff pane', leaked.length === 0, leaked.join(', '))
    check(
      '  and the rest of the diff is still there',
      rendered.length > 5,
      `${rendered.length} files rendered`,
    )

    // `.gitattributes` has the last word in both directions, and this is the
    // direction a hardcoded rule list can never get right on its own.
    check(
      '-linguist-generated rescues a file the rules claim',
      rendered.some((n) => n.includes(basename(KEPT))),
      KEPT,
    )

    const rows = await allTreeRows(page)
    const listed = GENERATED.filter((path) => rows.some((r) => r.path === path))
    check(
      'the tree still lists them all',
      listed.length === GENERATED.length,
      `${listed.length} of ${GENERATED.length}`,
    )
    const marked = rows.filter((r) => GENERATED.includes(r.path) && r.decoration.includes('gen'))
    check(
      '  and marks them, so a row that leads nowhere says why',
      marked.length === GENERATED.length,
      marked.map((r) => r.decoration.trim()).join(' | '),
    )

    // Hidden, not dropped: the counter and the totals still describe the diff
    // git produced, or the numbers would disagree with `git diff --stat`.
    const counted = (await page.evaluate(
      `parseInt(document.querySelector('.sidebar-head span').textContent, 10)`,
    )) as number
    const treeFiles = rows.filter((r) => r.kind === 'file').length
    check('they are still counted', counted === treeFiles, `${counted} counted, ${treeFiles} rows`)

    // `dist/` sorts first, so its row is in the tree's mounted window.
    const clicked = (await page.evaluate(`(() => {
      const root = document.querySelector('file-tree-container').shadowRoot
      const row = root.querySelector('[data-item-path="dist/bundle.js"]')
      row?.click()
      return Boolean(row)
    })()`)) as boolean
    await sleep(1200)
    check(
      'clicking a generated row brings them back',
      clicked && (await notice())?.includes('Hide them') === true,
      (await notice()) ?? '',
    )

    const shown = await allDiffFiles(page)
    const missing = GENERATED.filter((path) => !shown.some((n) => n.includes(basename(path))))
    check('  and then the pane renders them', missing.length === 0, missing.join(', '))

    await toggle()
    await sleep(1200)
    check(
      'hiding them again works',
      (await notice())?.includes('Show them') === true,
      (await notice()) ?? '',
    )
  },
} satisfies Suite
