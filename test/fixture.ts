import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * A throwaway repository to run the suites against.
 *
 * They used to point at whatever real repository was handy, which made them
 * depend on which branch happened to be checked out — one of them broke
 * mid-run when that branch moved — and left `.git/ghl/` behind in it. This
 * builds the diff instead: known files, known counts, known statuses.
 */
export interface Fixture {
  path: string
  cleanup: () => void
}

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })

function write(root: string, path: string, body: string) {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body)
}

/** Deterministic content, so line counts in assertions are stable. */
const lines = (count: number, seed: string) =>
  `${Array.from({ length: count }, (_, i) => `const ${seed}_${i} = ${i}`).join('\n')}\n`

/**
 * Files on the base commit.
 *
 * Shaped to exercise what the UI does with a tree rather than to look like a
 * real project: several extensions so the icons differ, one chain of
 * single-child directories to fold, and enough rows that the tree has to
 * virtualise at a 1000px viewport.
 */
function baseTree(root: string) {
  write(root, 'README.md', '# fixture\n\nA repository that exists only for the tests.\n')
  write(root, 'package.json', '{\n  "name": "fixture",\n  "private": true\n}\n')
  write(root, 'src/index.ts', lines(30, 'index'))
  write(root, 'src/core/engine.ts', lines(60, 'engine'))
  write(root, 'src/core/parser.ts', lines(45, 'parser'))
  write(root, 'src/core/registry.ts', lines(25, 'registry'))
  // A single-child chain: util -> deep -> nested. The tree folds it into one row.
  write(root, 'src/util/deep/nested/tool.ts', lines(20, 'tool'))
  write(root, 'infra/terraform/main.tf', 'resource "null_resource" "a" {}\n')
  write(root, 'scripts/build.py', 'print("build")\n')
  write(root, 'web/styles.css', '.a {\n  color: red;\n}\n')
  write(root, 'doomed.ts', lines(15, 'doomed'))
  write(root, 'to-be-renamed.ts', lines(40, 'renamed'))
  // Generated files, and the two `.gitattributes` overrides that have to beat
  // the built-in rules in both directions: one file the rules know nothing
  // about, one they would wrongly claim.
  write(
    root,
    '.gitattributes',
    'src/api-types.ts linguist-generated\ndist/hand-written.ts -linguist-generated\n',
  )
  write(root, 'pnpm-lock.yaml', lines(200, 'lock'))
  write(root, 'dist/bundle.js', lines(80, 'bundle'))
  write(root, 'dist/hand-written.ts', lines(20, 'kept'))
  write(root, 'src/api-types.ts', lines(30, 'api'))
  write(root, 'web/components/__snapshots__/Widget0.test.tsx.snap', lines(40, 'snap'))
  // Enough of them that the tree has to virtualise at a 1000px viewport.
  for (let i = 0; i < 60; i++) {
    write(root, `web/components/Widget${i}.tsx`, lines(20, `widget${i}`))
  }
}

/** What the branch under review changes, one of each status git can report. */
function featureChanges(root: string) {
  // modified
  write(root, 'src/core/engine.ts', lines(70, 'engine'))
  write(root, 'src/core/parser.ts', lines(40, 'parser'))
  write(root, 'src/util/deep/nested/tool.ts', lines(26, 'tool'))
  for (let i = 0; i < 45; i++) {
    write(root, `web/components/Widget${i}.tsx`, lines(28, `widget${i}`))
  }
  // generated, hidden from the diff pane by default
  write(root, 'pnpm-lock.yaml', lines(260, 'lock'))
  write(root, 'dist/bundle.js', lines(95, 'bundle'))
  write(root, 'src/api-types.ts', lines(38, 'api'))
  write(root, 'web/components/__snapshots__/Widget0.test.tsx.snap', lines(52, 'snap'))
  // Matches the `dist/` rule, but `.gitattributes` unsets it: stays visible.
  write(root, 'dist/hand-written.ts', lines(26, 'kept'))
  // added
  write(root, 'src/core/cache.ts', lines(35, 'cache'))
  write(root, 'web/components/NewPanel.tsx', lines(50, 'panel'))
  write(root, 'infra/terraform/network.tf', 'resource "null_resource" "b" {}\n')
}

export function createFixture(): Fixture {
  const path = mkdtempSync(join(tmpdir(), 'ghl-fixture-'))

  git(path, ['init', '--initial-branch=main'])
  git(path, ['config', 'user.email', 'fixture@example.invalid'])
  git(path, ['config', 'user.name', 'ghl fixture'])
  // Signing would prompt, and a global hooks path could run anything.
  git(path, ['config', 'commit.gpgsign', 'false'])
  git(path, ['config', 'core.hooksPath', '/dev/null'])

  baseTree(path)
  git(path, ['add', '-A'])
  git(path, ['commit', '-m', 'base'])

  // An older ref, so choosing it as the base genuinely widens the diff. Without
  // one, every branch here forks from the same commit and swapping the base
  // changes nothing — which would let a broken base picker pass.
  git(path, ['branch', 'release'])
  write(path, 'CHANGELOG.md', '# changelog\n\n- something\n')
  write(
    path,
    'README.md',
    '# fixture\n\nA repository that exists only for the tests. Now with a line.\n',
  )
  git(path, ['add', '-A'])
  git(path, ['commit', '-m', 'after release'])

  // The branch under review: modified, added, deleted and renamed files.
  git(path, ['checkout', '-q', '-b', 'feature'])
  featureChanges(path)
  rmSync(join(path, 'doomed.ts'))
  git(path, ['mv', 'to-be-renamed.ts', 'src/core/moved.ts'])
  git(path, ['add', '-A'])
  git(path, ['commit', '-m', 'feature work'])

  // A second branch, so the pickers have something else to offer and switching
  // the reviewed revision actually changes the file list.
  git(path, ['checkout', '-q', 'main'])
  git(path, ['checkout', '-q', '-b', 'other'])
  write(path, 'src/index.ts', lines(34, 'index'))
  write(path, 'other-only.ts', lines(12, 'other'))
  git(path, ['add', '-A'])
  git(path, ['commit', '-m', 'other work'])

  // Left on main: reviewing `feature` must not need it checked out.
  git(path, ['checkout', '-q', 'main'])

  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}
