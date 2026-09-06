import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, extname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createRpcConnection, type RpcConnection } from './jsonrpc.ts'
import type { LspFound, LspSilence } from './types.ts'

/**
 * Language servers, started on demand and asked where a symbol comes from.
 *
 * Only hover and definition are implemented. Nothing here diagnoses, completes
 * or formats — a review pane has no use for any of it, and every capability
 * announced is a stream of notifications to drop.
 */

/** A cold gopls indexes a large module before it answers anything at all. */
const READY_TIMEOUT_MS = 20_000
/** Past this the reader has moved the mouse; a slower answer is a wrong one. */
const REQUEST_TIMEOUT_MS = 8_000
const SHUTDOWN_TIMEOUT_MS = 1_000
/** rust-analyzer holds a gigabyte or two. The daemon lives 30 min; this must not. */
const SESSION_IDLE_MS = 5 * 60_000
const IDLE_SWEEP_MS = 60_000
/**
 * How long a server that failed to start is left alone.
 *
 * Not forever: `typescript-language-server` refuses to start until a TypeScript
 * is resolvable from the workspace, so `pnpm install` in the repo under review
 * must be enough to make hovers work — without restarting ghl.
 */
const RETRY_AFTER_MS = 60_000
/** Beyond this, close the least recently touched: each open file costs the server memory. */
const MAX_OPEN_DOCUMENTS = 24
/** Enough of stderr to carry the one line that says why a server would not start. */
const STDERR_KEPT = 4096

export interface ServerSpec {
  command: string
  args: string[]
  /**
   * Extension (dot included) to LSP language id.
   *
   * The id is not decorative: `typescript-language-server` validates it and
   * drops a `didOpen` carrying one it does not know, without saying so.
   */
  languages: Record<string, string>
}

/**
 * Three entries rather than thirty.
 *
 * A short table that was run against a real server beats a long one copied from
 * documentation, and each language added is one line. Extending it per
 * repository is a `git config` away — deliberately not built until someone asks.
 */
const SERVERS: ServerSpec[] = [
  {
    command: 'typescript-language-server',
    args: ['--stdio'],
    languages: {
      '.ts': 'typescript',
      '.mts': 'typescript',
      '.cts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.jsx': 'javascriptreact',
    },
  },
  { command: 'gopls', args: [], languages: { '.go': 'go' } },
  { command: 'rust-analyzer', args: [], languages: { '.rs': 'rust' } },
]

const executables = new Map<string, boolean>()

/**
 * Is `command` runnable from the PATH.
 *
 * Not `which`: that is a process per lookup, and this is asked once per file of
 * a diff. Memoised for the life of the process — a language server installed
 * while ghl is running is not a case worth a syscall per hover.
 */
function runnable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function onPath(command: string): boolean {
  const known = executables.get(command)
  if (known !== undefined) return known

  // A command carrying a separator names a file, not something to look up —
  // joining it onto every PATH entry would build nonsense and find nothing.
  const found = command.includes('/')
    ? runnable(command)
    : (process.env.PATH ?? '')
        .split(delimiter)
        .some((dir) => dir !== '' && runnable(join(dir, command)))

  executables.set(command, found)
  return found
}

/** The server that speaks for this file, if one is installed. */
function serverFor(
  path: string,
  servers: ServerSpec[],
): { spec: ServerSpec; languageId: string } | null {
  const extension = extname(path)
  for (const spec of servers) {
    const languageId = spec.languages[extension]
    if (languageId !== undefined && onPath(spec.command)) return { spec, languageId }
  }
  return null
}

/**
 * Which of these files could be navigated, as extensions.
 *
 * Answers from the registry and the PATH alone — no process is started. The page
 * asks this on every load, and a diff is the wrong place to discover that gopls
 * takes eight seconds to index.
 */
export function extensionsAvailable(paths: string[], servers: ServerSpec[] = SERVERS): string[] {
  const found = new Set<string>()
  for (const path of paths) {
    if (serverFor(path, servers)) found.add(extname(path))
  }
  return [...found].toSorted()
}

/** Opening fence of a markdown code block, with whatever info string it carries. */
const FENCE = /^```([^\n`]*)\n([\s\S]*?)\n?```/

/**
 * A hover, cut into the signature and the prose around it.
 *
 * The browser has no markdown renderer, so the one construct that matters is
 * pulled apart here: the first fenced block is the type, and everything left is
 * documentation shown as plain text. Nothing else is interpreted — bold, links
 * and lists reach the reader as the characters they are, which is honest and
 * costs no dependency.
 */
export function splitHover(markdown: string | null): {
  signature: string | null
  language: string | null
  documentation: string | null
} {
  if (markdown === null) return { signature: null, language: null, documentation: null }

  const fenced = FENCE.exec(markdown.trim())
  if (!fenced) {
    const prose = markdown.trim()
    return { signature: null, language: null, documentation: prose === '' ? null : prose }
  }

  const rest = tidy(markdown.trim().slice(fenced[0].length))

  const language = (fenced[1] ?? '').trim()
  return {
    signature: (fenced[2] ?? '').trim() || null,
    language: language === '' ? null : language,
    documentation: rest === '' ? null : rest,
  }
}

/**
 * The two markdown constructs a card without a renderer must not show raw.
 *
 * A horizontal rule separated sections that are now separate fields, so it
 * divides nothing and reads as three stray dashes. A link's target cannot be
 * followed from a text node, and `[main.Doubled on pkg.go.dev](https://…)` —
 * which gopls appends to nearly every hover — costs two lines to say a name.
 * Both are dropped to what they meant. Everything else still reaches the reader
 * as the characters it is.
 */
function tidy(markdown: string): string {
  return markdown
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
    .replace(/\[([^\]]+)]\((?:[^)]*)\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Lines around `line`, for a definition the diff has no way to show. */
const PREVIEW_RADIUS = 2

export async function previewAround(
  absolute: string,
  line: number,
): Promise<{ preview: string[]; previewStart: number }> {
  try {
    const lines = (await readFile(absolute, 'utf8')).split('\n')
    const start = Math.max(1, line - PREVIEW_RADIUS)
    return { preview: lines.slice(start - 1, line + PREVIEW_RADIUS), previewStart: start }
  } catch {
    return { preview: [], previewStart: line } // unreadable is not worth a failure
  }
}

/**
 * One `MarkedString`, `MarkupContent` or bare string, as markdown.
 *
 * The tagged and array forms are deprecated in the protocol and still what
 * several servers answer with, so reading `MarkupContent` alone would show an
 * empty card against half the ecosystem.
 */
function asMarkdown(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return ''

  const part = value as { value?: unknown; language?: unknown; kind?: unknown }
  if (typeof part.value !== 'string') return ''

  // A MarkedString carries its language beside the text, and plaintext has
  // nothing to interpret. Fencing both is what makes every shape reach the
  // front end as one kind of thing.
  const fence =
    typeof part.language === 'string' && part.language !== ''
      ? part.language
      : part.kind === 'plaintext'
        ? ''
        : null

  return fence === null ? part.value : `\`\`\`${fence}\n${part.value}\n\`\`\``
}

function hoverMarkdown(result: unknown): string | null {
  const contents = (result as { contents?: unknown } | null)?.contents
  if (contents === undefined || contents === null) return null

  const parts = (Array.isArray(contents) ? contents : [contents])
    .map(asMarkdown)
    .filter((part) => part.trim() !== '')

  // `{ contents: [] }` is what tsserver answers about a document it does not
  // consider open — a valid reply that means nothing, and would otherwise paint
  // an empty bubble.
  return parts.length > 0 ? parts.join('\n\n---\n\n') : null
}

interface Position {
  line?: unknown
  character?: unknown
}

/** LSP counts lines and columns from zero; the diff counts both from one. */
function spanOf(
  range: { start?: Position; end?: Position } | undefined,
): { line: number; column: number; endLine: number; endColumn: number } | null {
  const start = range?.start
  const end = range?.end ?? start
  if (typeof start?.line !== 'number' || typeof start.character !== 'number') return null
  if (typeof end?.line !== 'number' || typeof end.character !== 'number') return null
  return {
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  }
}

const MAX_TARGETS = 20

/**
 * Every location a `definition` answer names, in whichever of its three shapes.
 *
 * `targetSelectionRange` wins over `targetRange` when both are there: the first
 * points at the name, the second at the whole declaration, and landing on line
 * one of a two-hundred-line class is not going anywhere.
 */
function definitionsIn(result: unknown, root: string): LspFound[] {
  const all = Array.isArray(result) ? result : result === null ? [] : [result]
  const found: LspFound[] = []

  for (const one of all.slice(0, MAX_TARGETS)) {
    if (typeof one !== 'object' || one === null) continue
    const location = one as {
      uri?: unknown
      targetUri?: unknown
      range?: { start?: Position; end?: Position }
      targetRange?: { start?: Position; end?: Position }
      targetSelectionRange?: { start?: Position; end?: Position }
    }

    const uri = typeof location.uri === 'string' ? location.uri : location.targetUri
    if (typeof uri !== 'string') continue

    const span = spanOf(location.targetSelectionRange ?? location.targetRange ?? location.range)
    if (!span) continue

    let absolute: string
    try {
      absolute = fileURLToPath(uri)
    } catch {
      continue // `jdt:`, `deno:`, `zipfile:` — a document, but not a file
    }

    // Both sides through realpath, or the comparison depends on which of the two
    // spellings the server chose to answer with. tsserver resolves symlinks and
    // gopls does not, and on macOS every checkout under the temp directory is
    // reached through one — a repository whose own files land outside itself.
    try {
      absolute = realpathSync(absolute)
    } catch {
      // Deleted since it was indexed; the path below is still worth naming.
    }

    const inside = relative(root, absolute)
    const inRepo = inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
    found.push({ ...span, path: inRepo ? inside : absolute, inRepo })
  }

  return found
}

interface OpenDocument {
  version: number
  digest: string
}

interface Session {
  child: ChildProcess
  rpc: RpcConnection
  /** Resolves false when the handshake failed, so the pool stops asking. */
  ready: Promise<boolean>
  open: Map<string, OpenDocument>
  stderr: string
  lastUsed: number
}

/**
 * Every child this process started, so it can be cleaned up from an exit hook.
 *
 * Module level rather than per pool: `process.on('exit')` takes a synchronous
 * function, and one that walks a single set is easier to trust than one
 * registered per pool and never removed.
 */
const running = new Set<ChildProcess>()
let hookInstalled = false

function installExitHook() {
  if (hookInstalled) return
  hookInstalled = true
  // `bin/ghl.ts` stops the daemon with `server.close(); process.exit(0)`, and
  // `process.exit` is synchronous: the server's `close` event never fires. This
  // is the only hook that covers `/api/shutdown` and the idle stop.
  process.on('exit', () => {
    for (const child of running) child.kill('SIGKILL')
  })
}

export interface LspPool {
  hover(
    repoPath: string,
    path: string,
    line: number,
    column: number,
  ): Promise<{ contents: string | null; reason: LspSilence | null }>
  definition(
    repoPath: string,
    path: string,
    line: number,
    column: number,
  ): Promise<{ targets: LspFound[]; reason: LspSilence | null }>
  /** Synchronous: it also runs from an exit hook, where nothing can be awaited. */
  dispose(): void
}

export function createLspPool(servers: ServerSpec[] = SERVERS): LspPool {
  const sessions = new Map<string, Session>()
  /** command -> when it may be tried again, after a handshake that failed. */
  const broken = new Map<string, number>()
  const roots = new Map<string, string>()

  /**
   * The repository as the language server will name it.
   *
   * tsserver answers with real paths, so a checkout reached through a symlink —
   * every `mkdtemp` under `/tmp` on macOS — would have all of its own files
   * classified as outside itself.
   */
  const rootOf = (repoPath: string): string => {
    const known = roots.get(repoPath)
    if (known !== undefined) return known
    let real = repoPath
    try {
      real = realpathSync(repoPath)
    } catch {
      // Gone since it was registered; the calls below will fail on their own.
    }
    roots.set(repoPath, real)
    return real
  }

  /**
   * A document's URI, spelled the way the workspace root was spelled.
   *
   * Both go through realpath or neither does. Announce a root of
   * `/private/var/…` and then open `/var/…` — the two spellings of every
   * checkout under the temp directory on macOS — and gopls places the document
   * outside its own workspace, belonging to no package, and answers nothing at
   * all rather than saying why.
   */
  const uriFor = (repoPath: string, path: string) =>
    pathToFileURL(join(rootOf(repoPath), path)).href

  const drop = (key: string, session: Session, why: string) => {
    session.rpc.fail(why)
    running.delete(session.child)
    session.child.kill()
    sessions.delete(key)
  }

  const start = (repoPath: string, spec: ServerSpec, key: string): Session => {
    installExitHook()
    const child = spawn(spec.command, spec.args, {
      // The only cwd in the project outside `bin/`, and it comes from an
      // explicit parameter rather than from the process — the discipline holds.
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    running.add(child)

    const session: Session = {
      child,
      rpc: createRpcConnection({
        send: (chunk) => {
          // A dead stdin throws EPIPE; the exit handler below is what reacts.
          if (child.stdin?.writable) child.stdin.write(chunk)
        },
      }),
      ready: Promise.resolve(false),
      open: new Map(),
      stderr: '',
      lastUsed: Date.now(),
    }

    child.stdout?.on('data', (chunk: Buffer) => session.rpc.receive(chunk))
    // Drained, not ignored: rust-analyzer fills a 64 KB pipe and then blocks on
    // it. Kept, because this is where "Could not find a valid TypeScript
    // installation" is written.
    child.stderr?.on('data', (chunk: Buffer) => {
      session.stderr = (session.stderr + chunk.toString('utf8')).slice(-STDERR_KEPT)
    })
    child.on('error', () => drop(key, session, `${spec.command} could not be started`))
    child.on('exit', () => {
      session.rpc.fail(`${spec.command} exited`)
      running.delete(child)
      sessions.delete(key)
    })

    session.ready = (async () => {
      const root = pathToFileURL(rootOf(repoPath)).href
      await session.rpc.request(
        'initialize',
        {
          // Not a courtesy: every server built on vscode-languageserver polls
          // this pid every three seconds and exits once it is gone. It is the
          // only thing that cleans up after a daemon killed with SIGKILL.
          processId: process.pid,
          clientInfo: { name: 'ghl' },
          rootUri: root,
          workspaceFolders: [{ uri: root, name: 'ghl' }],
          capabilities: {
            textDocument: {
              synchronization: { dynamicRegistration: false },
              hover: { contentFormat: ['markdown', 'plaintext'] },
              // Left unannounced on purpose: `positionEncoding` stays UTF-16,
              // which is what the column the browser computed already counts in.
              definition: {},
            },
            workspace: { workspaceFolders: true },
          },
        },
        READY_TIMEOUT_MS,
      )
      session.rpc.notify('initialized', {})
      return true
    })().catch(() => {
      // Remembered as broken rather than retried on the next pointer pause:
      // being on the PATH does not mean being able to run here, and respawning
      // a doomed process per hover is a fork bomb with a mouse for a trigger.
      broken.set(spec.command, Date.now() + RETRY_AFTER_MS)
      drop(key, session, `${spec.command} did not start: ${session.stderr.trim() || 'no output'}`)
      return false
    })

    sessions.set(key, session)
    return session
  }

  /**
   * Tell the server what the file says now, before asking about it.
   *
   * `didOpen` is not optional — tsserver answers `{ contents: [] }` about a
   * document it was never handed — and neither is `didChange`: the file under
   * review is the working tree, so it moves under us by construction, and a
   * hover on a stale copy answers confidently about the wrong lines.
   */
  const sync = async (session: Session, repoPath: string, path: string, languageId: string) => {
    const text = await readFile(join(repoPath, path), 'utf8')
    const digest = createHash('sha1').update(text).digest('hex')
    const uri = uriFor(repoPath, path)
    const already = session.open.get(path)

    if (!already) {
      if (session.open.size >= MAX_OPEN_DOCUMENTS) {
        // Insertion order is least-recently-touched order, because every read
        // below re-inserts.
        const oldest = session.open.keys().next().value
        if (oldest !== undefined) {
          session.open.delete(oldest)
          session.rpc.notify('textDocument/didClose', {
            textDocument: { uri: uriFor(repoPath, oldest) },
          })
        }
      }
      session.open.set(path, { version: 1, digest })
      session.rpc.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text },
      })
      return
    }

    session.open.delete(path)
    session.open.set(path, { version: already.version + 1, digest })
    if (already.digest === digest) return

    session.rpc.notify('textDocument/didChange', {
      textDocument: { uri, version: already.version + 1 },
      // A whole-document change is legal whatever sync mode the server declared.
      contentChanges: [{ text }],
    })
  }

  const ask = async (
    repoPath: string,
    path: string,
    line: number,
    column: number,
    method: string,
  ): Promise<{ result: unknown; reason: LspSilence | null }> => {
    const server = serverFor(path, servers)
    if (!server) return { result: null, reason: 'no-server-for-this-file' }

    const { spec, languageId } = server
    const until = broken.get(spec.command)
    if (until !== undefined && Date.now() < until) {
      return { result: null, reason: 'server-unavailable' }
    }

    const key = `${repoPath}\0${spec.command}`
    const session = sessions.get(key) ?? start(repoPath, spec, key)
    session.lastUsed = Date.now()

    if (!(await session.ready)) return { result: null, reason: 'server-unavailable' }

    try {
      await sync(session, repoPath, path, languageId)
      const result = await session.rpc.request(
        method,
        {
          textDocument: { uri: uriFor(repoPath, path) },
          // The one place the two coordinate systems meet.
          position: { line: line - 1, character: column - 1 },
        },
        REQUEST_TIMEOUT_MS,
      )
      return { result, reason: null }
    } catch (cause) {
      const why = cause instanceof Error ? cause.message : String(cause)
      return {
        result: null,
        reason: why.endsWith('timed out') ? 'timed-out' : 'server-unavailable',
      }
    }
  }

  const sweep = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS
    for (const [key, session] of sessions) {
      if (session.lastUsed < cutoff) drop(key, session, 'idle')
    }
  }, IDLE_SWEEP_MS)
  sweep.unref()

  return {
    async hover(repoPath, path, line, column) {
      const { result, reason } = await ask(repoPath, path, line, column, 'textDocument/hover')
      return { contents: reason === null ? hoverMarkdown(result) : null, reason }
    },

    async definition(repoPath, path, line, column) {
      const { result, reason } = await ask(repoPath, path, line, column, 'textDocument/definition')
      return { targets: reason === null ? definitionsIn(result, rootOf(repoPath)) : [], reason }
    },

    dispose() {
      clearInterval(sweep)
      for (const [key, session] of sessions) {
        // `shutdown` first, and only best-effort: typescript-language-server
        // runs a tsserver of its own, and a parent killed outright leaves it.
        session.rpc.request('shutdown', null, SHUTDOWN_TIMEOUT_MS).then(
          () => session.rpc.notify('exit', undefined),
          () => {},
        )
        drop(key, session, 'stopped')
      }
    },
  }
}

/** Exported so the transport and the normalisers can be tested without a server. */
export const forTests = { hoverMarkdown, definitionsIn }
