import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifyGeneratedFiles, generatedReasonForPath } from '../src/generated.ts'
import type { Check } from './harness.ts'

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })

function attributeRepo(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'ghl-generated-'))
  git(path, ['init', '-q', '--initial-branch=main'])
  git(path, ['config', 'user.email', 'generated@example.invalid'])
  git(path, ['config', 'user.name', 'ghl generated fixture'])
  git(path, ['config', 'commit.gpgsign', 'false'])
  git(path, ['config', 'core.hooksPath', '/dev/null'])

  writeFileSync(
    join(path, '.gitattributes'),
    [
      'custom.txt linguist-generated',
      'dist/kept.js -linguist-generated',
      '"with space.txt" linguist-generated',
      '',
    ].join('\n'),
  )
  writeFileSync(join(path, 'custom.txt'), 'generated on main\n')
  writeFileSync(join(path, 'with space.txt'), 'also generated\n')
  git(path, ['add', '-A'])
  git(path, ['commit', '-q', '-m', 'main attributes'])

  git(path, ['checkout', '-q', '-b', 'feature'])
  writeFileSync(
    join(path, '.gitattributes'),
    [
      'custom.txt -linguist-generated',
      'feature.txt linguist-generated',
      'dist/kept.js -linguist-generated',
      '',
    ].join('\n'),
  )
  writeFileSync(join(path, 'feature.txt'), 'generated on feature\n')
  git(path, ['add', '-A'])
  git(path, ['commit', '-q', '-m', 'feature attributes'])
  git(path, ['checkout', '-q', 'main'])

  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

export async function runGenerated(check: Check): Promise<void> {
  const examples = new Map([
    ['package-lock.json', 'lockfile'],
    ['packages/app/pnpm-lock.yaml', 'lockfile'],
    ['src/__snapshots__/card.ts.snap', 'snapshot'],
    ['fixtures/result.snap', 'snapshot'],
    ['web/dist/bundle.js', 'distribution'],
    ['web/distribution/bundle.js', null],
    ['src/locksmith.ts', null],
  ])
  for (const [path, expected] of examples) {
    const actual = generatedReasonForPath(path)
    check(`generated path: ${path}`, actual === expected, actual ?? 'ordinary source')
  }

  const repo = attributeRepo()
  try {
    const onMain = await classifyGeneratedFiles(repo.path, [
      'custom.txt',
      'with space.txt',
      'dist/kept.js',
      'dist/bundle.js',
    ])
    check(
      'working-tree attributes mark ordinary paths as generated',
      onMain.get('custom.txt') === 'gitattributes' &&
        onMain.get('with space.txt') === 'gitattributes',
      JSON.stringify(Object.fromEntries(onMain)),
    )
    check(
      'an unset attribute overrides the path heuristic',
      !onMain.has('dist/kept.js') && onMain.get('dist/bundle.js') === 'distribution',
      JSON.stringify(Object.fromEntries(onMain)),
    )

    const onFeature = await classifyGeneratedFiles(
      repo.path,
      ['custom.txt', 'feature.txt', 'dist/kept.js'],
      { source: 'feature' },
    )
    check(
      'attributes come from the revision under review, not the checkout',
      !onFeature.has('custom.txt') && onFeature.get('feature.txt') === 'gitattributes',
      JSON.stringify(Object.fromEntries(onFeature)),
    )
    check(
      'the reviewed revision can opt a generated-looking path back in',
      !onFeature.has('dist/kept.js'),
      JSON.stringify(Object.fromEntries(onFeature)),
    )
  } finally {
    repo.cleanup()
  }
}
