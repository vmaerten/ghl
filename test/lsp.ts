import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { decodeFrames, encodeMessage } from '../src/jsonrpc.ts'
import { createLspPool, extensionsAvailable, splitHover, type ServerSpec } from '../src/lsp.ts'
import type { Check } from './harness.ts'

/**
 * The transport and the pool, against a server that only pretends.
 *
 * A real language server cannot be made to tear a message in half or to go
 * quiet, and asking one to would make these checks depend on what is installed
 * and how long it takes to index. `test/fake-lsp.ts` does both on request.
 */

const FAKE = fileURLToPath(new URL('./fake-lsp.ts', import.meta.url))

const speaking = (mode: string): ServerSpec[] => [
  { command: process.execPath, args: [FAKE, mode], languages: { '.ts': 'typescript' } },
]

/** A repository with one file, which is all a position needs to point into. */
function scratchRepo(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'ghl-lsp-'))
  execFileSync('git', ['init', '-q'], { cwd: path })
  writeFileSync(join(path, 'one.ts'), 'export const answer = 42\nexport const near = answer\n')
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function runLsp(check: Check): Promise<void> {
  // --- framing, with no process anywhere ---

  const one = encodeMessage({ jsonrpc: '2.0', id: 1, result: 'hello' })
  const two = encodeMessage({ jsonrpc: '2.0', id: 2, result: 'world' })

  const packed = decodeFrames(Buffer.concat([one, two]))
  check('two messages in one chunk are both read', packed.frames.length === 2)
  check('  and nothing is left over', packed.rest.length === 0)

  let carried: Buffer = Buffer.alloc(0)
  const collected: string[] = []
  for (const byte of Buffer.concat([one, two])) {
    carried = Buffer.concat([carried, Buffer.from([byte])])
    const { frames, rest } = decodeFrames(carried)
    carried = rest
    collected.push(...frames)
  }
  check('a message split byte by byte still arrives whole', collected.length === 2)

  const accented = encodeMessage({ jsonrpc: '2.0', id: 3, result: 'où ça — déjà' })
  const decoded = decodeFrames(accented).frames[0]
  check(
    'a multi-byte body is cut on bytes, not characters',
    JSON.parse(decoded ?? '{}').result === 'où ça — déjà',
    decoded,
  )

  const headerOnly = decodeFrames(one.subarray(0, 12))
  check('half a header is held for the next chunk', headerOnly.frames.length === 0)
  check('  and the bytes are kept', headerOnly.rest.length === 12)

  // --- the hover normalisers, which is where servers disagree ---

  const split = splitHover('```typescript\nconst answer: 42\n```\n\nThe answer.')
  check('a fenced hover splits into signature and prose', split.signature === 'const answer: 42')
  check('  and keeps the language', split.language === 'typescript')
  check('  and the prose', split.documentation === 'The answer.')

  const proseOnly = splitHover('Just a sentence.')
  check('an unfenced hover is all documentation', proseOnly.documentation === 'Just a sentence.')
  check('  with no signature', proseOnly.signature === null)

  check('nothing in, nothing out', splitHover(null).signature === null)

  // What gopls actually answers, rules and trailing link included.
  const gopls = splitHover(
    '```go\nfunc Doubled() int\n```\n\n---\n\nDoubled returns twice the Answer.\n\n\n---\n\n[`main.Doubled` on pkg.go.dev](https://pkg.go.dev/example.com/probe#Doubled)',
  )
  check('a rule that divides nothing is dropped', !gopls.documentation?.includes('---'))
  check(
    '  and a link nobody can follow keeps only its name',
    !gopls.documentation?.includes('http'),
  )
  check(
    '  while the sentence and the code span survive',
    gopls.documentation === 'Doubled returns twice the Answer.\n\n`main.Doubled` on pkg.go.dev',
    JSON.stringify(gopls.documentation),
  )

  // --- the pool, against the fake ---

  const repo = scratchRepo()
  try {
    const normal = createLspPool(speaking('normal'))
    try {
      const hover = await normal.hover(repo.path, 'one.ts', 1, 14)
      check('a hover comes back', hover.reason === null, hover.reason ?? '')
      check(
        '  and it says something, which only an opened document does',
        splitHover(hover.contents).signature === 'const answer: 42',
        hover.contents ?? 'nothing — the fake answers an unopened document with []',
      )

      const definition = await normal.definition(repo.path, 'one.ts', 2, 14)
      check('a definition comes back', definition.reason === null)
      const target = definition.targets[0]
      check('  pointing inside the repository', target?.inRepo === true)
      check('  at a path relative to it', target?.path === 'one.ts', target?.path)
      check('  1-based, where LSP counted from zero', target?.line === 2, String(target?.line))

      const elsewhere = await normal.hover(repo.path, 'one.go', 1, 1)
      check(
        'a file no server speaks for is refused',
        elsewhere.reason === 'no-server-for-this-file',
      )
    } finally {
      normal.dispose()
    }

    const legacy = createLspPool(speaking('legacy-marked-string'))
    try {
      const hover = await legacy.hover(repo.path, 'one.ts', 1, 14)
      check(
        'the deprecated MarkedString[] shape is read too',
        splitHover(hover.contents).signature === 'const answer: 42',
        hover.contents ?? '',
      )
    } finally {
      legacy.dispose()
    }

    const empty = createLspPool(speaking('empty-contents'))
    try {
      const hover = await empty.hover(repo.path, 'one.ts', 1, 14)
      check('an empty answer is nothing, not an empty card', hover.contents === null)
      check('  and not an error either', hover.reason === null)
    } finally {
      empty.dispose()
    }

    const multibyte = createLspPool(speaking('multibyte'))
    try {
      const hover = await multibyte.hover(repo.path, 'one.ts', 1, 14)
      check(
        'an accented hover survives the wire',
        splitHover(hover.contents).signature === 'const café: "où ça"',
        hover.contents ?? '',
      )
    } finally {
      multibyte.dispose()
    }

    const blocked = createLspPool(speaking('needs-a-reply'))
    try {
      const hover = await blocked.hover(repo.path, 'one.ts', 1, 14)
      check(
        'a server waiting on its own request is answered, so it answers back',
        hover.reason === null,
        hover.reason ?? '',
      )
    } finally {
      blocked.dispose()
    }

    const dead = createLspPool(speaking('dies-after-initialize'))
    try {
      const hover = await dead.hover(repo.path, 'one.ts', 1, 14)
      check('a server that dies gives an answer, not a hang', hover.reason !== null)
      const again = await dead.hover(repo.path, 'one.ts', 1, 14)
      check('  and the pool is still usable after it', again.reason !== null)
    } finally {
      dead.dispose()
    }

    // --- nothing left running ---

    const counted = createLspPool(speaking('normal'))
    await counted.hover(repo.path, 'one.ts', 1, 14)
    const children = execFileSync('pgrep', ['-f', 'fake-lsp.ts'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number)
    counted.dispose()
    await new Promise((resolve) => setTimeout(resolve, 300))
    check(
      'dispose leaves no language server behind',
      children.length > 0 && children.every((pid) => !alive(pid)),
      `${children.length} started`,
    )
  } finally {
    repo.cleanup()
  }

  // --- what the page is told, without starting anything ---

  const none = extensionsAvailable(['a.ts', 'b.md'], [])
  check('no server installed means nothing announced', none.length === 0)

  const some = extensionsAvailable(['a.ts', 'b.md', 'c.ts'], speaking('normal'))
  check(
    'an installed server announces its extension once',
    some.join(',') === '.ts',
    some.join(','),
  )
}
