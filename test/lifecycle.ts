import { execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, get as httpGet } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveRepoRoot } from '../src/git.ts'
import { putComment } from '../src/state.ts'
import { listen, repoIdFor } from '../src/server.ts'
import { createFixture, type Fixture } from './fixture.ts'
import { sleep, type Check } from './harness.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Long enough for a cold Node start, short enough to fail rather than hang. */
const DEADLINE_MS = 15_000

/** `--idle` is in minutes; this is three seconds. */
const SHORT_IDLE = '0.05'

interface Health {
  ghl: true
  revision: string
  pid: number
  repos: { id: string; path: string }[]
}

interface Runtime {
  /** Where the copied bin/ and src/ live. */
  path: string
  /** Rewrite INSTALLED, which is what a new install looks like from outside. */
  stamp: (revision: string) => void
}

/**
 * A copy of the runtime, with an INSTALLED file of our choosing.
 *
 * Never the checkout itself: the tests would then fight over port 7777 with the
 * `ghl` the developer is running, and faking a version change would mean
 * touching source files under their feet.
 */
function createRuntime(): Runtime & { cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'ghl-runtime-'))
  for (const part of ['bin', 'src']) cpSync(join(ROOT, part), join(path, part), { recursive: true })

  const stamp = (revision: string) =>
    writeFileSync(join(path, 'INSTALLED'), `${revision} from ${ROOT}\n`)
  stamp('rev-one')

  return { path, stamp, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

function cli(runtime: Runtime, cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(runtime.path, 'bin', 'ghl.ts'), ...args], {
      cwd,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(runtime.path, 'config'),
        XDG_CACHE_HOME: join(runtime.path, 'cache'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk))
    child.stderr.on('data', (chunk: Buffer) => (err += chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`ghl exited ${code}: ${err.trim()}`)),
    )
  })
}

/** A port nobody holds, so a stray daemon of the developer's is never involved. */
async function freePort(): Promise<number> {
  const probe = createServer()
  const port = await listen(probe, 0)
  await new Promise((resolve) => probe.close(resolve))
  return port
}

async function health(port: number): Promise<Health | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(300),
    })
    return response.ok ? ((await response.json()) as Health) : null
  } catch {
    return null
  }
}

/**
 * Status of a GET with a chosen Host header.
 *
 * Not `fetch`: undici treats Host as forbidden and silently sends its own, so
 * the request would arrive looking perfectly legitimate and the check would pass
 * without ever reaching the code it is about.
 */
function statusWithHost(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpGet(
      { host: '127.0.0.1', port, path: '/api/repos', headers: { host } },
      (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      },
    )
    request.on('error', reject)
  })
}

async function servedIds(port: number): Promise<string[]> {
  const response = await fetch(`http://127.0.0.1:${port}/api/repos`)
  const body = (await response.json()) as { repos: { id: string }[] }
  return body.repos.map((repo) => repo.id).toSorted()
}

/** Wait until the port stops answering, or give up. */
async function waitGone(port: number): Promise<boolean> {
  const deadline = Date.now() + DEADLINE_MS
  while (Date.now() < deadline) {
    if ((await health(port)) === null) return true
    await sleep(200)
  }
  return false
}

/**
 * Wait for the process itself to go, without ever asking it anything.
 *
 * Polling /api/health here would be self-defeating: every request counts as
 * activity, so the watching would be exactly what keeps it alive.
 */
async function waitProcessGone(runtime: Runtime): Promise<boolean> {
  const deadline = Date.now() + DEADLINE_MS
  while (Date.now() < deadline) {
    if (daemonCount(runtime) === 0) return true
    await sleep(200)
  }
  return false
}

/** Background processes running this runtime — a loser of a race must leave none. */
function daemonCount(runtime: Runtime): number {
  try {
    const out = execFileSync('pgrep', ['-f', join(runtime.path, 'bin', 'ghl.ts')], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.toString().trim().split('\n').filter(Boolean).length
  } catch {
    return 0 // pgrep exits 1 when nothing matches
  }
}

async function stop(port: number): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST' }).catch(() => {})
  await waitGone(port)
}

export async function runLifecycle(check: Check): Promise<void> {
  const runtime = createRuntime()
  const repos: Fixture[] = []
  const ports: number[] = []

  try {
    const one = createFixture()
    const two = createFixture()
    repos.push(one, two)

    // 1 — cold start
    const port = await freePort()
    ports.push(port)
    const first = await cli(runtime, one.path, ['--no-open', '--port', String(port)])
    const up = await health(port)
    check('a cold start leaves an instance behind', up !== null, `port ${port}`)
    check('and the command returns instead of serving', first.includes(`:${port}/r/`))
    check(
      'which reports the revision it was installed as',
      up?.revision === 'rev-one',
      up?.revision,
    )

    // 2 — a second repository joins the same process
    await cli(runtime, two.path, ['--no-open', '--port', String(port)])
    const both = await servedIds(port)
    check('a second repository joins it', both.length === 2, both.join(', '))
    check('in the same process', (await health(port))?.pid === up?.pid)
    check('and no second one was started', daemonCount(runtime) === 1)

    // 3 — re-registering does not duplicate, and an entry has nothing else to say
    writeFileSync(join(two.path, 'stray.txt'), 'untracked\n')
    // Through git, as the server does: on macOS mkdtemp hands back /var/folders
    // while `rev-parse --show-toplevel` resolves it to /private/var/folders, and
    // the two spell different repo ids.
    const twoId = repoIdFor(await resolveRepoRoot(two.path))
    await cli(runtime, two.path, ['--no-open', '--port', String(port)])
    check(
      're-running the same repository does not duplicate it',
      (await servedIds(port)).length === 2,
    )

    // An entry holds a path and nothing else now, so what a diff contains is
    // only ever asked for in the address — the whole of #55, checked on the flag
    // that was the last to move there. Bare, as the page writes it and as it is
    // typed by hand: `get` would return the empty string, which is falsy, and
    // the flag would be inert without saying so.
    const untrackedFlag = async (query: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/r/${twoId}/api/diff${query}`)
      return ((await response.json()) as { untrackedIncluded?: boolean }).untrackedIncluded
    }
    check(
      'the untracked files are reachable from the address',
      (await untrackedFlag('?untracked')) === true,
    )
    check('  and from nowhere else', (await untrackedFlag('')) === false)

    // 3b — what the command line asks for rides in the address, not in the entry
    const opened = await cli(runtime, two.path, [
      '--no-open',
      '--port',
      String(port),
      'feature',
      '--base',
      'release',
    ])
    check(
      'the revision asked for is carried by the URL',
      opened.includes('target=feature') && opened.includes('base=release'),
      opened.trim().split('\n').at(-1) ?? '',
    )
    // The address a bookmark holds, which must still review the checkout: an
    // entry answering for it is what made the UI's own choices unreachable (#55).
    const bare = (await (await fetch(`http://127.0.0.1:${port}/r/${twoId}/api/diff`)).json()) as {
      base: { ref: string }
      target: { workingTree: boolean }
    }
    check(
      '  while the bare address reviews the checkout',
      bare.target.workingTree === true,
      `workingTree=${bare.target.workingTree}`,
    )
    check('  against a base of its own', bare.base.ref !== 'release', bare.base.ref)

    // 4 — a different build takes the port over, and hands the tabs across
    runtime.stamp('rev-two')
    await cli(runtime, one.path, ['--no-open', '--port', String(port)])
    const replaced = await health(port)
    check(
      'a newer build replaces the instance',
      replaced?.pid !== up?.pid,
      `${up?.pid} -> ${replaced?.pid}`,
    )
    check('and reports the new revision', replaced?.revision === 'rev-two', replaced?.revision)
    check('the repositories it served come across', (await servedIds(port)).length === 2)
    check('and still only one process runs', daemonCount(runtime) === 1)
    await stop(port)

    // 5 — two cold starts at once converge on one instance
    const racePort = await freePort()
    ports.push(racePort)
    await Promise.all([
      cli(runtime, one.path, ['--no-open', '--port', String(racePort)]),
      cli(runtime, two.path, ['--no-open', '--port', String(racePort)]),
    ])
    check('two simultaneous starts leave one instance', daemonCount(runtime) === 1)
    check('serving both repositories', (await servedIds(racePort)).length === 2)
    await stop(racePort)

    // 6 — nothing watching, so it goes
    const idlePort = await freePort()
    ports.push(idlePort)
    await cli(runtime, one.path, ['--no-open', '--port', String(idlePort), '--idle', SHORT_IDLE])
    check('an idle instance is still up right after starting', (await health(idlePort)) !== null)
    check('and stops on its own once nothing asks for anything', await waitProcessGone(runtime))

    // 7 — the Host allowlist, against a real server rather than a unit
    const hostPort = await freePort()
    ports.push(hostPort)
    await cli(runtime, one.path, ['--no-open', '--port', String(hostPort)])
    const hostile = await statusWithHost(hostPort, 'attacker.example')
    check('an unexpected Host is refused', hostile === 403, `HTTP ${hostile}`)
    const legitimate = await statusWithHost(hostPort, `ghl.localhost:${hostPort}`)
    check('while ghl.localhost is served', legitimate === 200, `HTTP ${legitimate}`)
    await stop(hostPort)

    // 8 — `ghl comments`, which needs no server at all
    //
    // Here rather than in a browser suite because the subcommand is the thing
    // being tested: `parseArgs` claims the first non-flag argument as the revision
    // to review, so `comments` has to be taken off before it ever gets there.
    const empty = await cli(runtime, one.path, ['comments', 'feature'])
    check(
      'ghl comments runs without an instance',
      empty.includes('No comments on'),
      empty.trim().split('\n')[0],
    )
    check('  and names what it looked at', empty.includes('..feature'), empty.trim())

    const asJson = await cli(runtime, one.path, ['comments', 'feature', '--json'])
    const parsed = JSON.parse(asJson) as { repo: string; range: string; comments: unknown[] }
    check('--json is parseable', Array.isArray(parsed.comments), asJson.trim().slice(0, 60))
    // The resolved root, not the fixture's own path: see the note above about
    // /var/folders and /private/var/folders.
    check(
      '  carrying the repository and the range',
      parsed.repo === (await resolveRepoRoot(one.path)) && parsed.range === 'main..feature',
      `${parsed.repo} ${parsed.range}`,
    )

    // A written comment comes back out. Posted through the state layer rather
    // than a server, since the point is that the CLI reads the file itself.
    const target = 'infra/terraform/network.tf'
    await putComment(one.path, {
      id: 'from-a-test',
      path: target,
      side: 'additions',
      start: 1,
      end: 1,
      body: 'give this resource a real name',
      anchor: ['resource "null_resource" "b" {}'],
      range: 'main..feature',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const withOne = await cli(runtime, one.path, ['comments', 'feature'])
    check('a stored comment reaches stdout', withOne.includes('give this resource a real name'))
    check('  under its file', withOne.includes(`## ${target}`), withOne.trim().split('\n')[2])
    // Quoted from the patch the CLI built itself, which is what makes the export
    // usable without the reader having to go and look the line up.
    check('  with the line it points at', withOne.includes('null_resource'))

    // A remark on a file git does not track yet. The page has a button to leave
    // those out and a reader who chose; the export has neither, and one written
    // here would be dropped by the comparison reader — stored, and invisible.
    // Reviewed without a target: with one there is no working tree, so no
    // untracked file at all.
    writeFileSync(join(one.path, 'sketch.ts'), 'export const sketch = 1\n')
    await putComment(one.path, {
      id: 'on-an-untracked-file',
      path: 'sketch.ts',
      side: 'additions',
      start: 1,
      end: 1,
      body: 'this one is not tracked yet',
      anchor: ['export const sketch = 1'],
      range: 'main..main',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const onUntracked = await cli(runtime, one.path, ['comments'])
    check(
      'a remark on an untracked file reaches stdout too',
      onUntracked.includes('this one is not tracked yet'),
      onUntracked.trim().split('\n')[0],
    )
    check(
      '  quoting the line, so the file was really in the patch',
      onUntracked.includes('export const sketch = 1'),
    )
    const browsePort = await freePort()
    ports.push(browsePort)
    const browse = await cli(runtime, runtime.path, ['--no-open', '--port', String(browsePort)])
    check(
      'ghl outside Git opens the catalogue',
      browse.includes(`:${browsePort}/`) && !browse.includes('/r/'),
    )
    await cli(runtime, runtime.path, [
      '--root',
      one.path,
      '--browse',
      '--no-open',
      '--port',
      String(browsePort),
    ])
    const rootList = await (await fetch(`http://127.0.0.1:${browsePort}/api/roots`)).json()
    check(
      'CLI adds roots to a running daemon',
      rootList.roots.includes(await resolveRepoRoot(one.path)),
    )
    runtime.stamp('rev-three')
    await cli(runtime, runtime.path, ['--browse', '--no-open', '--port', String(browsePort)])
    check(
      'roots survive daemon replacement',
      (await (await fetch(`http://127.0.0.1:${browsePort}/api/roots`)).json()).roots.length === 1,
    )
    await stop(browsePort)
    const cachePath = join(runtime.path, 'cache', 'ghl', 'catalog.json')
    const previousCache = readFileSync(cachePath, 'utf8')
    await cli(runtime, one.path, ['--print'])
    await cli(runtime, one.path, ['comments'])
    check(
      'print and comments do not start discovery',
      readFileSync(cachePath, 'utf8') === previousCache && daemonCount(runtime) === 0,
    )
    let incompatible = false
    try {
      await cli(runtime, runtime.path, [
        '--browse',
        '--base',
        'main',
        '--no-open',
        '--port',
        String(browsePort),
      ])
    } catch (error) {
      incompatible = String(error).includes('--browse cannot be combined')
    }
    check(
      'incompatible browse flags fail before starting a daemon',
      incompatible && (await health(browsePort)) === null,
    )
  } finally {
    for (const port of ports) await stop(port)
    for (const repo of repos) repo.cleanup()
    runtime.cleanup()
  }
}
