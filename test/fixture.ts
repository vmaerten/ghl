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
  // Renamed across languages on the branch: .jsx -> .tsx. A rename that keeps
  // its extension is not enough — only a change of language reaches the bug.
  write(root, 'legacy.jsx', lines(40, 'legacy'))
  // Enough of them that the tree has to virtualise at a 1000px viewport.
  for (let i = 0; i < 60; i++) {
    write(root, `web/components/Widget${i}.tsx`, lines(20, `widget${i}`))
  }
}

/**
 * What the branch under review changes, one of each status git can report,
 * written as three commits.
 *
 * Three rather than one so the commit picker has something to list. The split
 * is free to the other suites by construction: the tree at the tip is the same,
 * so `base..feature` is the same diff, down to the section hashes `viewed`
 * asserts on. Adding a branch instead would enter the world the pickers see.
 */
function featureChanges(root: string) {
  // modified
  write(root, 'src/core/engine.ts', lines(70, 'engine'))
  write(root, 'src/core/parser.ts', lines(40, 'parser'))
  write(root, 'src/util/deep/nested/tool.ts', lines(26, 'tool'))
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'widen the core'])

  for (let i = 0; i < 45; i++) {
    write(root, `web/components/Widget${i}.tsx`, lines(28, `widget${i}`))
  }
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'grow the widgets'])

  // added
  write(root, 'src/core/cache.ts', lines(35, 'cache'))
  write(root, 'web/components/NewPanel.tsx', lines(50, 'panel'))
  write(root, 'infra/terraform/network.tf', 'resource "null_resource" "b" {}\n')
  // Names where a hand-written comparator parts company with the tree's: the
  // tree ranks `.` `-` `_` and digits by code unit, where ICU collation does
  // not. Without a pair like these the order suite is green whatever it runs.
  write(root, 'src/core/engine_pool.ts', lines(20, 'pool'))
  write(root, 'src/core/v.ts', lines(10, 'v'))
  write(root, 'src/core/v1.ts', lines(12, 'v1'))
  write(root, 'web/components/Widget-panel.tsx', lines(18, 'dashpanel'))
  write(root, 'web/components/Widget_panel.tsx', lines(18, 'underpanel'))
}

/**
 * Two branches stacked one on the other, plus the file `gh stack` would write.
 *
 * The file is written by hand rather than by invoking `gh`: the suites have to
 * run offline and unauthenticated, and the extension is not a dependency of this
 * project. The layers are deliberately unequal — 2 files then 1 — so a suite can
 * tell "the layer alone" from "everything since the trunk" by counting.
 *
 * `stack/a` carries no pull request and `stack/b` does, which is the state of
 * any stack whose bottom has not been submitted yet, and covers both branches of
 * the rendering.
 *
 * A second stack covers the state every stack ends up in: `stack/gone` is
 * recorded, merged and pruned, so it exists only in the file. `stack/c` has to
 * fall through it to the trunk — diffing against a branch that resolves to
 * nothing is the failure this shape is here to catch.
 */
function stackedChain(root: string) {
  git(root, ['checkout', '-q', 'main'])
  git(root, ['checkout', '-q', '-b', 'stack/a'])
  write(root, 'src/core/queue.ts', lines(18, 'queue'))
  write(root, 'src/core/pool.ts', lines(22, 'pool'))
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'bottom layer'])

  git(root, ['checkout', '-q', '-b', 'stack/b'])
  write(root, 'src/core/worker.ts', lines(24, 'worker'))
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'top layer'])

  git(root, ['checkout', '-q', 'main'])
  git(root, ['checkout', '-q', '-b', 'stack/c'])
  write(root, 'src/core/timer.ts', lines(12, 'timer'))
  write(root, 'src/core/clock.ts', lines(14, 'clock'))
  write(root, 'src/core/tick.ts', lines(16, 'tick'))
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'layer above a merged one'])

  write(
    root,
    '.git/gh-stack',
    JSON.stringify(
      {
        schemaVersion: 1,
        repository: 'github.com:fixture/fixture',
        stacks: [
          {
            id: '1',
            number: 1,
            trunk: { branch: 'main' },
            branches: [
              { branch: 'stack/a' },
              {
                branch: 'stack/b',
                pullRequest: {
                  number: 42,
                  url: 'https://github.com/fixture/fixture/pull/42',
                  merged: false,
                },
              },
            ],
          },
          {
            id: '2',
            number: 2,
            trunk: { branch: 'main' },
            branches: [
              {
                branch: 'stack/gone',
                pullRequest: {
                  number: 7,
                  url: 'https://github.com/fixture/fixture/pull/7',
                  merged: true,
                },
              },
              { branch: 'stack/c' },
            ],
          },
        ],
      },
      null,
      2,
    ),
  )
}

/**
 * A mixed diff and an all-generated one for the generated-file review mode.
 *
 * Both are branches rather than changes on `feature`: every other browser suite
 * keeps its established file counts, and reading either while main is checked
 * out proves attributes come from the target rather than the working tree.
 */
function generatedBranches(root: string) {
  git(root, ['checkout', '-q', 'main'])
  git(root, ['checkout', '-q', '-b', 'generated'])
  write(
    root,
    '.gitattributes',
    ['generated/custom.ts linguist-generated', 'dist/kept.js -linguist-generated', ''].join('\n'),
  )
  write(root, 'src/review.ts', 'export const review = true\n')
  write(root, 'package-lock.json', '{\n  "lockfileVersion": 3\n}\n')
  write(root, 'src/__snapshots__/card.snap', 'exports[`card`] = `<article />`\n')
  write(root, 'dist/bundle.js', 'var generated=true;\n')
  write(root, 'generated/custom.ts', 'export const generated = true\n')
  write(root, 'dist/kept.js', 'export const maintainedByHand = true\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'mixed generated files'])

  git(root, ['checkout', '-q', 'main'])
  git(root, ['checkout', '-q', '-b', 'generated-only'])
  write(root, 'package-lock.json', '{\n  "lockfileVersion": 3\n}\n')
  write(root, 'dist/bundle.js', 'var generated=true;\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'generated files only'])
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
  // Edited as well as renamed: a pure rename carries no content, so it never
  // asks for a grammar and cannot go wrong.
  git(path, ['mv', 'legacy.jsx', 'src/legacy.tsx'])
  write(path, 'src/legacy.tsx', lines(46, 'legacy'))
  git(path, ['add', '-A'])
  git(path, ['commit', '-m', 'move things around'])

  // A second branch, so the pickers have something else to offer and switching
  // the reviewed revision actually changes the file list.
  git(path, ['checkout', '-q', 'main'])
  git(path, ['checkout', '-q', '-b', 'other'])
  write(path, 'src/index.ts', lines(34, 'index'))
  write(path, 'other-only.ts', lines(12, 'other'))
  git(path, ['add', '-A'])
  git(path, ['commit', '-m', 'other work'])

  stackedChain(path)
  generatedBranches(path)

  // Left on main: reviewing `feature` must not need it checked out.
  git(path, ['checkout', '-q', 'main'])

  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}
