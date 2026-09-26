import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runReviewSession } from './reviewSession.ts'
import { runCatalog } from './catalog.ts'
import { createFixture } from './fixture.ts'
import { withHarness, type Check, type Suite } from './harness.ts'
import { runCommits } from './commits.ts'
import { runLifecycle } from './lifecycle.ts'
import { runRefs } from './refs.ts'
import { runWorktree } from './worktree.ts'
import { runState } from './state.ts'
import { runExport } from './export.ts'
import { runContext } from './context.ts'
import { runImages } from './images.ts'
import { runComparison } from './comparison.ts'
import { runRepositoryFile } from './repositoryFile.ts'
import { runReviewSelection } from './reviewSelection.ts'
import { runCommentPersistence } from './commentPersistence.ts'

import catalogUi from './suites/catalog.ts'
import reviewPanel from './suites/reviewPanel.ts'
import themes from './suites/themes.ts'
import tree from './suites/tree.ts'
import resize from './suites/resize.ts'
import viewed from './suites/viewed.ts'
import comments from './suites/comments.ts'
import pickers from './suites/pickers.ts'
import scroll from './suites/scroll.ts'
import rename from './suites/rename.ts'
import order from './suites/order.ts'
import stack from './suites/stack.ts'
import commits from './suites/commits.ts'
import worktree from './suites/worktree.ts'
import untracked from './suites/untracked.ts'
import search from './suites/search.ts'

const discoveryHome = mkdtempSync(join(tmpdir(), 'ghl-test-discovery-'))
process.env.XDG_CONFIG_HOME = join(discoveryHome, 'config')
process.env.XDG_CACHE_HOME = join(discoveryHome, 'cache')

const SUITES: Suite[] = [
  themes,
  reviewPanel,
  tree,
  resize,
  viewed,
  comments,
  pickers,
  scroll,
  rename,
  order,
  stack,
  commits,
  worktree,
  untracked,
  search,
  catalogUi,
]

/**
 * Suites with their own repositories. Most need no browser; images also checks
 * its dedicated fixture in Chrome after validating the API.
 */
const PLAIN: { name: string; run: (check: Check) => Promise<void> }[] = [
  { name: 'catalog', run: runCatalog },
  { name: 'review-session', run: runReviewSession },
  { name: 'review-selection', run: runReviewSelection },
  { name: 'comment-persistence', run: runCommentPersistence },
  { name: 'repository-file', run: runRepositoryFile },
  { name: 'comparison', run: runComparison },
  { name: 'state', run: runState },
  { name: 'export', run: runExport },
  { name: 'refs', run: runRefs },
  { name: 'commits', run: runCommits },
  { name: 'worktree', run: runWorktree },
  { name: 'lifecycle', run: runLifecycle },
  { name: 'images', run: runImages },
  { name: 'context', run: runContext },
]

const only = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const selected = only.length > 0 ? SUITES.filter((s) => only.includes(s.name)) : SUITES
const plain = only.length > 0 ? PLAIN.filter((s) => only.includes(s.name)) : PLAIN

if (selected.length === 0 && plain.length === 0) {
  const names = [...PLAIN.map((s) => s.name), ...SUITES.map((s) => s.name)].join(', ')
  process.stderr.write(`no such suite. available: ${names}\n`)
  process.exit(1)
}

let failures = 0
let total = 0

const check: Check = (name, ok, detail) => {
  total += 1
  if (!ok) failures += 1
  const mark = ok ? '  ok  ' : '  FAIL'
  process.stdout.write(`${mark} ${name}${detail ? `  — ${detail}` : ''}\n`)
}

for (const suite of plain) {
  process.stdout.write(`\n${suite.name}\n`)
  try {
    await suite.run(check)
  } catch (error) {
    failures += 1
    total += 1
    const detail = error instanceof Error ? error.message : String(error)
    process.stdout.write(`  FAIL ${suite.name} threw  — ${detail}\n`)
  }
}

// Skipped entirely when only a browser-free suite was asked for: no fixture to
// build, and no browser to start.
if (selected.length > 0) {
  const fixture = createFixture()

  try {
    await withHarness(fixture.path, async (make) => {
      for (const suite of selected) {
        process.stdout.write(`\n${suite.name}\n`)
        const harness = await make('feature')

        try {
          await suite.run(harness, check)
          check(
            'no page errors',
            harness.errors.length === 0,
            harness.errors.slice(0, 2).join(' | '),
          )
        } catch (error) {
          failures += 1
          total += 1
          const detail = error instanceof Error ? error.message : String(error)
          process.stdout.write(`  FAIL ${suite.name} threw  — ${detail}\n`)
        } finally {
          await harness.page.close()
        }
      }
    })
  } finally {
    fixture.cleanup()
  }
}

process.stdout.write(
  failures === 0 ? `\n${total} checks passed\n` : `\n${failures} of ${total} checks FAILED\n`,
)
rmSync(discoveryHome, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
