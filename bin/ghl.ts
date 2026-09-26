#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { lookup } from 'node:dns/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { asExport, asMarkdown } from '../src/export.ts'
import { currentBranch, repoState, resolveRepoRoot } from '../src/git.ts'
import { buildPatch, rangeKey, resolveBase } from '../src/revision.ts'
import { createGhlServer, listen, listenNear, repoIdFor, type RepoEntry } from '../src/server.ts'
import { comparisonReader } from '../src/comparison.ts'
import { readState } from '../src/state.ts'
import type { BaseResolution, BaseSource } from '../src/types.ts'
import { runtimeRevision } from '../src/version.ts'

/** Also the target of the Vite dev proxy, so `pnpm dev` needs no flag. */
const DEFAULT_PORT = 7777

/** Resolves to the loopback with no /etc/hosts entry and no dnsmasq (RFC 6761). */
const HOSTNAME = 'ghl.localhost'

const DEFAULT_IDLE_MINUTES = 30

/** A daemon that is up answers at once; one that is absent refuses at once. */
const PROBE_TIMEOUT_MS = 300

/** Long enough for a cold Node start on a loaded machine. */
const STARTUP_TIMEOUT_MS = 5_000

interface Options {
  roots: string[]
  browse: boolean
  open: boolean
  print: boolean
  json: boolean
  help: boolean
  port: number
  base: string | null
  target: string | null
  daemon: boolean
  useDaemon: boolean
  idleMinutes: number
}

interface Health {
  ghl: true
  revision: string
  pid: number
  repos: { id: string; path: string }[]
}

const USAGE = `ghl — review the PR you are about to open, without opening it

Usage:
  ghl [target] [options]
  ghl comments [target] [options]

  target         Branch or revision to review. Defaults to the working tree,
                 i.e. the PR you would open from this checkout right now.

Commands:
  comments       Print the comments on that review and exit, as markdown or, with
                 --json, as something to parse. A branch actually named
                 "comments" is still reachable as refs/heads/comments.

Options:
  --root <path>  Add a discovery root permanently (repeatable)
  --browse       Open the local repository catalogue
  --json         With \`comments\`: machine-readable output instead of markdown
  --base <rev>   Compare against <rev> instead of the guessed base
  --port <n>     Listen on <n>, or on the next free port after it
                 (default: ${DEFAULT_PORT}, or $GHL_PORT; 0 picks any free port)
  --no-open      Do not open the browser
  --print        Print a summary to stdout and exit, without serving
  --no-daemon    Serve from this process and stay in the foreground, instead of
                 handing the repository to the shared one
  --idle <min>   Stop the shared instance after <min> minutes with no tab
                 watching (default: ${DEFAULT_IDLE_MINUTES}; 0 never stops)
  -h, --help     Show this help
`

/** `Number.parseInt` would take `abc` as NaN and hand it straight to listen(). */
function parsePort(value: string, source: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${source} expects a port between 0 and 65535, got: ${value}`)
  }
  return port
}

function parseMinutes(value: string): number {
  const minutes = Number(value)
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`--idle expects a number of minutes, got: ${value}`)
  }
  return minutes
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Options {
  const options: Options = {
    roots: [],
    browse: false,
    open: true,
    print: false,
    json: false,
    help: false,
    port: env.GHL_PORT ? parsePort(env.GHL_PORT, 'GHL_PORT') : DEFAULT_PORT,
    base: null,
    target: null,
    daemon: false,
    useDaemon: true,
    idleMinutes: DEFAULT_IDLE_MINUTES,
  }
  const next = (i: number, flag: string): string => {
    const value = argv[i]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (!arg.startsWith('-') && options.target === null) options.target = arg
    else if (arg === '-h' || arg === '--help') options.help = true
    else if (arg === '--root') options.roots.push(resolve(next(++i, '--root')))
    else if (arg === '--browse') options.browse = true
    else if (arg === '--no-open') options.open = false
    else if (arg === '--print') options.print = true
    else if (arg === '--json') options.json = true
    else if (arg === '--base') options.base = next(++i, '--base')
    else if (arg === '--port') options.port = parsePort(next(++i, '--port'), '--port')
    else if (arg === '--no-daemon') options.useDaemon = false
    // Not in the usage: it is how the CLI starts its own background copy.
    else if (arg === '--daemon') options.daemon = true
    else if (arg === '--idle') options.idleMinutes = parseMinutes(next(++i, '--idle'))
    else throw new Error(`unknown option: ${arg}`)
  }
  return options
}

/** Count files and lines straight from the patch, to sanity-check the git layer. */
function summarise(patch: string): { files: number; additions: number; deletions: number } {
  let files = 0
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) files++
    else if (line.startsWith('+') && !line.startsWith('+++')) additions++
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { files, additions, deletions }
}

const openBrowser = (url: string) => execFile('open', [url])

/**
 * The hostname to print, checked rather than assumed.
 *
 * `*.localhost` is loopback by spec, but a corporate search domain can still
 * answer for it, and the server only ever binds 127.0.0.1 — so a URL that would
 * not connect must never be the one printed.
 */
async function displayHost(): Promise<string> {
  try {
    const addresses = await lookup(HOSTNAME, { all: true })
    if (addresses.some(({ address }) => address === '127.0.0.1')) return HOSTNAME
  } catch {
    // Unresolvable is one more reason to fall back, not an error to report.
  }
  return '127.0.0.1'
}

const api = (port: number, route: string) => `http://127.0.0.1:${port}/api/${route}`

/** The instance listening on `port`, or null when there is none of ours. */
async function probe(port: number): Promise<Health | null> {
  try {
    const response = await fetch(api(port, 'health'), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const health = (await response.json()) as Health
    return health.ghl === true ? health : null // something else owns the port
  } catch {
    return null
  }
}

async function post(port: number, route: string, body?: unknown): Promise<Response> {
  return fetch(api(port, route), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 10),
  })
}

/** Poll until something of ours answers, whoever ends up winning the port. */
async function waitForDaemon(port: number): Promise<Health> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const health = await probe(port)
    if (health) return health
    await delay(50)
  }
  throw new Error(`nothing answered on port ${port}`)
}

/** Ask the instance on `port` to go, and wait for the port to come free. */
async function stopDaemon(port: number): Promise<void> {
  try {
    await post(port, 'shutdown')
  } catch {
    // It may well die before answering. That is the outcome we asked for.
  }
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if ((await probe(port)) === null) return
    await delay(50)
  }
  throw new Error(`the instance on port ${port} did not stop`)
}

function spawnDaemon(options: Options): void {
  const self = fileURLToPath(import.meta.url)
  const args = [
    self,
    '--daemon',
    '--port',
    String(options.port),
    '--idle',
    String(options.idleMinutes),
  ]
  spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref()
}

/**
 * The background process itself: serves nothing at first and takes repositories
 * over HTTP, so registering the first one goes through the same path as the
 * hundredth.
 */
async function runDaemon(options: Options): Promise<void> {
  const server = createGhlServer({
    repos: [],
    idleMs: options.idleMinutes * 60_000,
    onStop: () => {
      server.close()
      process.exit(0)
    },
  })

  try {
    // listen(), not listenNear(): a daemon on another port is a daemon nobody
    // would ever find.
    await listen(server, options.port)
  } catch (error) {
    // Two `ghl` started in the same second both spawn one of these. The loser
    // has nothing to say: the winner is about to serve this repository too.
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return
    throw error
  }
}

/** Hand `entry` to the shared instance, starting or replacing it as needed. */
async function serveViaDaemon(options: Options, entry: RepoEntry | null): Promise<string | null> {
  const ours = runtimeRevision()
  let health = await probe(options.port)
  let inherited: string[] = []

  // Another build owns the port: it runs an older `src/`, so it has to go — but
  // the repositories it was serving have tabs open on them.
  if (health && health.revision !== ours) {
    inherited = health.repos.map((repo) => repo.path)
    await stopDaemon(options.port)
    health = null
  }

  if (!health) {
    spawnDaemon(options)
    await waitForDaemon(options.port)
  }

  // Handed over as bare paths, which is all an entry holds.
  for (const repoPath of inherited) {
    if (repoPath !== entry?.repoPath) await post(options.port, 'repos', { repoPath })
  }

  for (const path of options.roots) {
    const response = await post(options.port, 'roots', { path })
    if (!response.ok) throw new Error((await response.json()).error)
  }
  if (!entry) return null
  const response = await post(options.port, 'repos', entry)
  if (!response.ok) {
    throw new Error(`the instance on port ${options.port} refused the repository`)
  }
  return ((await response.json()) as { id: string }).id
}

/**
 * Print the comments on a review and exit.
 *
 * No daemon and no server: the state file and the patch are both read straight
 * from the repository, as `--print` does. Which is why `src/state.ts` imports
 * nothing outside `node:`.
 */
async function runComments(
  repoPath: string,
  base: BaseResolution,
  options: Options,
): Promise<void> {
  const [result, branch, { state }] = await Promise.all([
    // Untracked files in, always. The page has a button to leave them out and a
    // reader who chose; this has neither. The comparison reader filters on files,
    // so a remark written on a file git does not track yet would be dropped
    // here with nothing left to ask for it back. The exclusion exists to keep
    // 446 files out of a diff, not one sentence out of a review.
    buildPatch(repoPath, base.ref, { target: options.target, includeUntracked: true }),
    // Without a target, resolveBase has already asked — that is `base.branch`.
    options.target ? currentBranch(repoPath) : base.branch,
    readState(repoPath),
  ])
  // The same key the server files them under, from the same function: computing
  // it here by hand is how the two would come to disagree about the same review.
  const range = rangeKey(base.ref, options.target ?? branch ?? 'HEAD')
  const comments = await comparisonReader(repoPath, result).comments(state.comments)

  process.stdout.write(
    options.json
      ? `${JSON.stringify(asExport(comments, { repo: repoPath, range }), null, 2)}\n`
      : asMarkdown(comments, { range }),
  )
}

async function main() {
  const argv = process.argv.slice(2)
  // Taken off before parseArgs, which claims the first non-flag argument as the
  // revision to review — `ghl comments` would go looking for a ref by that name
  // and fail with git's words rather than ours. It does reserve the word: a branch
  // actually called `comments` is still reachable as `refs/heads/comments`.
  const command = argv[0] === 'comments' ? argv.shift() : null
  const options = parseArgs(argv, process.env)
  if (options.daemon) return runDaemon(options)
  if (options.help) {
    process.stdout.write(USAGE)
    return
  }

  // The only place where the current directory is read: everything downstream
  // takes repoPath as a parameter.
  const requiresRepo =
    command === 'comments' || options.print || options.base !== null || options.target !== null
  if (options.browse && requiresRepo)
    throw new Error('--browse cannot be combined with comments, --print, a revision or --base')
  if (options.roots.length && (command === 'comments' || options.print))
    throw new Error('--root cannot be combined with comments or --print')
  let repoPath: string | null = null
  try {
    repoPath = await resolveRepoRoot(process.cwd())
  } catch (error) {
    if (requiresRepo) throw error
  }
  if (options.browse) repoPath = null
  const base = repoPath
    ? await resolveBase(repoPath, { override: options.base, target: options.target })
    : null

  if (command === 'comments' && repoPath && base) return runComments(repoPath, base, options)

  if (options.print && repoPath && base) {
    const { patch, untracked } = await buildPatch(repoPath, base.ref, { target: options.target })
    const { files, additions, deletions } = summarise(patch)
    const state = await repoState(repoPath)
    const origin: Record<BaseSource, string> = {
      override: 'given on the command line',
      remembered: 'remembered in .git/config',
      stack: 'what the gh stack chain says this sits on',
      guessed: `guessed (stacked branch, ${base.distance} commit(s))`,
      trunk: 'repository trunk',
    }

    const lines = [
      `repo      ${repoPath}`,
      `reviewing ${options.target ?? `${base.branch ?? 'HEAD'} + working tree`}`,
      `base      ${base.ref}  — ${origin[base.source]}`,
      `changes   ${files} file(s), +${additions} -${deletions}`,
      `untracked ${untracked.length} file(s) (excluded)`,
    ]
    const chain = base.stack
    if (chain) {
      const layers = chain.layers.map((layer, index) => {
        const pr = layer.pr ? ` #${layer.pr.number}` : ''
        const label = `${layer.branch}${pr}${layer.merged ? ' (merged)' : ''}`
        return index === chain.current ? `[${label}]` : label
      })
      lines.push(`stack     ${[chain.trunk, ...layers].join(' → ')}`)
    }
    if (state.operation) {
      lines.push(
        `WARNING   ${state.operation} in progress, ${state.conflicted.length} conflicted file(s)`,
      )
    }
    process.stdout.write(lines.join('\n') + '\n')
    return
  }

  const entry: RepoEntry | null = repoPath ? { repoPath } : null

  let port = options.port
  let repoId = repoPath ? repoIdFor(repoPath) : null

  if (options.useDaemon) {
    repoId = await serveViaDaemon(options, entry)
  } else {
    // Foreground: this process is the server, and dies with the terminal.
    port = await listenNear(createGhlServer({ repos: entry ? [entry] : [] }), options.port)
    for (const path of options.roots) {
      const response = await post(port, 'roots', { path })
      if (!response.ok) throw new Error((await response.json()).error)
    }
  }

  // What was asked for on the command line travels in the address, not in the
  // registry: the page can then drop a parameter to mean "I chose the default",
  // and nothing answers in its place afterwards (#55). With no arguments the
  // address stays bare, which is the one you bookmark.
  const opening = new URLSearchParams()
  if (options.base) opening.set('base', options.base)
  if (options.target) opening.set('target', options.target)
  const query = opening.size > 0 ? `?${opening}` : ''

  const url = `http://${await displayHost()}:${port}${repoId ? `/r/${repoId}${query}` : '/'}`
  process.stdout.write(
    `ghl serving ${repoPath ?? 'local repositories'}\n${base ? `  base ${base.ref} (${base.source})\n` : ''}  ${url}\n`,
  )
  if (options.open) openBrowser(url)
}

main().catch((error: unknown) => {
  process.stderr.write(`ghl: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
