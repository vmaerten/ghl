import { allDiffFiles, allTreeRows, clickTreeRow, sleep, type Suite } from '../harness.ts'

const COMMENT_ID = 'generated-file-comment'

interface GeneratedButton {
  text: string
  expanded: boolean
}

export default {
  name: 'generated',
  async run({ page, load }, check) {
    const button = () =>
      page.evaluate(`(() => {
        const button = document.querySelector('.generated-files')
        return button ? {
          text: button.textContent.trim().replace(/\\s+/g, ' '),
          expanded: button.getAttribute('aria-expanded') === 'true',
        } : null
      })()`) as Promise<GeneratedButton | null>
    const paths = async () =>
      (await allTreeRows(page)).map((row) => row.path).filter((path) => !path.endsWith('/'))
    const diffNames = async () => (await allDiffFiles(page)).map((file) => file.name)

    try {
      await load('?target=generated')
      await page.waitForSelector('.generated-files', { timeout: 15_000 })

      const payload = (await page.evaluate(`(async () => {
        const id = location.pathname.match(/^\\/r\\/([^/]+)/)[1]
        const body = await (await fetch('/r/' + id + '/api/diff' + location.search)).json()
        return {
          files: body.files.map((file) => [file.path, file.generated]),
          total: body.totals.files,
          range: body.range,
        }
      })()`)) as { files: [string, string | null][]; total: number; range: string }
      const generated = new Map(payload.files)
      check(
        'the server classifies path heuristics and target attributes',
        generated.get('package-lock.json') === 'lockfile' &&
          generated.get('src/__snapshots__/card.snap') === 'snapshot' &&
          generated.get('dist/bundle.js') === 'distribution' &&
          generated.get('generated/custom.ts') === 'gitattributes',
        JSON.stringify(Object.fromEntries(generated)),
      )
      check(
        'an attribute on the target opts a generated-looking path back in',
        generated.get('dist/kept.js') === null,
        JSON.stringify(Object.fromEntries(generated)),
      )

      const hiddenButton = await button()
      check(
        'generated files start behind one explicit row',
        hiddenButton?.text.includes('4 generated files') === true &&
          hiddenButton.text.includes('Show') &&
          !hiddenButton.expanded,
        JSON.stringify(hiddenButton),
      )
      const hiddenPaths = await paths()
      const hiddenDiff = await diffNames()
      check(
        'only ordinary files enter the tree by default',
        hiddenPaths.length === 3 &&
          hiddenPaths.includes('src/review.ts') &&
          hiddenPaths.includes('dist/kept.js'),
        hiddenPaths.join(', '),
      )
      check(
        'and the diff renders the same three files',
        hiddenDiff.length === hiddenPaths.length &&
          hiddenPaths.every((path) =>
            hiddenDiff.some((name) => name.includes(path.split('/').at(-1) ?? path)),
          ),
        hiddenDiff.join(', '),
      )
      const counts = (await page.evaluate(`({
        total: document.querySelector('.stats .file-count')?.textContent?.trim(),
        visible: document.querySelector('.sidebar-head > span')?.textContent?.trim(),
      })`)) as { total?: string; visible?: string }
      check(
        'global statistics still describe the complete diff',
        counts.total === '7 files' && counts.visible === '3 files' && payload.total === 7,
        JSON.stringify(counts),
      )

      await page.evaluate(`document.querySelector('.generated-files').click()`)
      await sleep(1600)
      const shownPaths = await paths()
      const shownDiff = await diffNames()
      check(
        'Show restores every file to both panes',
        shownPaths.length === 7 && shownDiff.length === 7,
        `${shownPaths.length} tree, ${shownDiff.length} diff`,
      )
      check(
        'the choice lives in the URL',
        new URLSearchParams((await page.evaluate('location.search')) as string).has('generated'),
        (await page.evaluate('location.search')) as string,
      )

      // A hidden comment must remain discoverable and exportable. Write it
      // through the public route, then reload once: the reload also proves the
      // generated flag is reconstructed from the URL rather than memory.
      const status = (await page.evaluate(`(async () => {
        const id = location.pathname.match(/^\\/r\\/([^/]+)/)[1]
        const response = await fetch('/r/' + id + '/api/comments' + location.search, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: ${JSON.stringify(COMMENT_ID)},
            path: 'package-lock.json',
            side: 'additions',
            start: 1,
            end: 1,
            body: 'check the dependency update',
            range: ${JSON.stringify(payload.range)},
          }),
        })
        return response.status
      })()`)) as number
      check('a generated file remains commentable when shown', status === 200, String(status))

      await page.reload({ waitUntil: 'networkidle0' })
      await page.waitForSelector('.generated-files', { timeout: 15_000 })
      await sleep(1800)
      const reloaded = await button()
      check(
        'the shown state survives a reload',
        reloaded?.expanded === true && reloaded.text.includes('✎1'),
        JSON.stringify(reloaded),
      )

      await clickTreeRow(page, 'package-lock.json')
      await page.evaluate(`document.querySelector('.generated-files').click()`)
      await sleep(1200)
      const hiddenAgain = await button()
      const selected = (await allTreeRows(page)).filter((row) => row.selected)
      check(
        'Hide removes generated files but keeps their comment visible on the group',
        (await paths()).length === 3 &&
          hiddenAgain?.text.includes('✎1') === true &&
          !hiddenAgain.expanded,
        JSON.stringify(hiddenAgain),
      )
      check(
        'hiding the active generated file leaves a visible selection',
        selected.length === 1 && selected[0]?.path !== 'package-lock.json',
        selected.map((row) => row.path).join(', ') || 'no selection',
      )

      await load('?target=generated-only')
      await page.waitForSelector('.generated-empty', { timeout: 15_000 })
      const empty = (await page.evaluate(
        `document.querySelector('.generated-empty')?.textContent?.trim().replace(/\\s+/g, ' ')`,
      )) as string
      check(
        'an all-generated diff explains why the pane is empty',
        empty.includes('All 2 changed files are generated') && empty.includes('Show files'),
        empty,
      )
      await page.evaluate(`document.querySelector('.generated-empty button').click()`)
      await sleep(1400)
      check(
        'the empty state can reveal the complete diff',
        (await paths()).length === 2 && (await diffNames()).length === 2,
      )
    } finally {
      await page.evaluate(`(async () => {
        const match = location.pathname.match(/^\\/r\\/([^/]+)/)
        if (match) await fetch('/r/' + match[1] + '/api/comments?id=' + ${JSON.stringify(COMMENT_ID)}, {
          method: 'DELETE',
        })
      })()`)
    }
  },
} satisfies Suite
