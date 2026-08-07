import { git } from './git.ts'

/**
 * Which files in a diff were generated rather than written.
 *
 * Measured across 323 real branches: the largest diffs are not large in code but
 * in generated files — on one of them a `package-lock.json` is 99.9% of the
 * whole thing. Hiding them by default is also the cheapest possible rendering:
 * an item that is not in the array costs nothing, where `collapsed: true` costs
 * 4-5x (decision 7 in PLAN.md).
 */

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'Pipfile.lock',
  'poetry.lock',
  'uv.lock',
  'go.sum',
  'flake.lock',
  'mix.lock',
  'pubspec.lock',
  'Podfile.lock',
  'packages.lock.json',
  'gradle.lockfile',
])

/** Matched on a whole segment, so `dist` never matches `redistribute/`. */
const DIRECTORIES = new Set(['__snapshots__', 'dist', 'vendor', 'node_modules'])

const SUFFIXES = [
  '.snap',
  '.min.js',
  '.min.css',
  '.js.map',
  '.css.map',
  '.pb.go',
  '.pb.cc',
  '.pb.h',
  '_pb2.py',
  '_pb2.pyi',
]

/**
 * The built-in rules, deliberately narrow.
 *
 * A file wrongly hidden is a file the reader never learns to look for, so the
 * list only holds names that mean one thing everywhere. Everything else is what
 * `.gitattributes` is for.
 */
export function looksGenerated(path: string): boolean {
  const segments = path.split('/')
  const name = segments.at(-1) ?? ''
  if (LOCKFILES.has(name)) return true
  if (segments.slice(0, -1).some((segment) => DIRECTORIES.has(segment))) return true
  return SUFFIXES.some((suffix) => name.endsWith(suffix))
}

// A few hundred paths is the measured worst case, but argv is finite.
const CHUNK = 500

/**
 * The rules above, then `.gitattributes` over them.
 *
 * The attribute has the last word in both directions: `linguist-generated`
 * marks a file the rules know nothing about, `-linguist-generated` rescues one
 * they claim wrongly. It is the escape hatch that lets a repository correct us,
 * and it is the one GitHub already reads — nothing new to learn.
 */
export async function detectGenerated(repoPath: string, paths: string[]): Promise<Set<string>> {
  const generated = new Set(paths.filter(looksGenerated))
  if (paths.length === 0) return generated

  for (let i = 0; i < paths.length; i += CHUNK) {
    const out = await git(
      repoPath,
      ['check-attr', '-z', 'linguist-generated', '--', ...paths.slice(i, i + CHUNK)],
      { allowFailure: true },
    )
    // NUL-separated triples: path, attribute, value.
    const fields = out.split('\0')
    for (let j = 0; j + 2 < fields.length; j += 3) {
      const path = fields[j]
      if (!path) continue
      const value = fields[j + 2]
      if (value === 'set') generated.add(path)
      else if (value === 'unset') generated.delete(path)
    }
  }
  return generated
}
