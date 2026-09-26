import { Catalog, type CatalogPaths } from './catalog.ts'
import { repoIdFor } from './checkoutId.ts'
export { repoIdFor } from './checkoutId.ts'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import { currentBranch, listCommits, listRefDetails, repoState, resolveRepoRoot } from './git.ts'
import { comparisonReader, resolveComparison } from './comparison.ts'
import { imageType, readImage } from './images.ts'
import { detectTrunk, rememberBase } from './revision.ts'
import {
  clearViewed,
  pruneStale,
  putComment,
  readState,
  removeComment,
  setViewed,
  updateCommentBody,
} from './state.ts'
import type { Comment, CommitsPayload, DiffPayload, RefsPayload } from './types.ts'
import { runtimeRevision } from './version.ts'

/**
 * One repository the server is willing to serve, as the CLI registers it.
 *
 * A path, and nothing else. Everything that decides what a diff contains is the
 * page's choice, and it says so by leaving the parameter out at its default
 * value — which an entry answering in its place turns into "the CLI wins
 * forever" (#55). Those travel in the URL the CLI opens instead.
 */
export interface RepoEntry {
  repoPath: string
}

/** Why the server is being asked to stop. */
export type StopReason = 'idle' | 'requested'

export interface GhlServerOptions {
  repos: RepoEntry[]
  catalogPaths?: CatalogPaths
  /**
   * Milliseconds without a request before `onStop('idle')` fires; 0 disables it.
   * The front end sends a heartbeat while its tab is visible, so this measures
   * "nobody is watching", not "nobody has clicked".
   */
  idleMs?: number
  /**
   * What to do when the server should go. Left out, `/api/shutdown` and the idle
   * timer are inert — which is what the test harness wants, since it runs the
   * server inside the process doing the testing.
   */
  onStop?: (reason: StopReason) => void
}

/** How often the idle timer looks at the clock. */
const IDLE_TICK_MS = 60_000

/**
 * Read once, at import: what this process is *running*, not what is on disk now.
 *
 * Recomputing it per request would make every instance report the current
 * sources and therefore always look up to date — which is exactly the staleness
 * this is here to catch.
 */
const REVISION = runtimeRevision()

const UI_DIR = fileURLToPath(new URL('../web-dist', import.meta.url))

/**
 * Hostnames a browser may legitimately use to reach a server bound to the
 * loopback. A fixed port makes the address guessable, so a page that re-resolves
 * its own domain to 127.0.0.1 would otherwise end up same-origin with the source
 * code being served. The port is deliberately not part of the check: an attacker
 * chooses what its domain resolves to, never the Host header the browser sends.
 */
const ALLOWED_HOSTS = new Set(['ghl.localhost', 'localhost', '127.0.0.1', '[::1]'])

/** URL() lowercases the hostname and strips the port, brackets included. */
function isAllowedName(url: string): boolean {
  try {
    return ALLOWED_HOSTS.has(new URL(url).hostname)
  } catch {
    return false // an unparseable Host or an opaque `Origin: null`
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Serve a built asset. Returns false when the UI has not been built. */
function serveStatic(res: ServerResponse, relativePath: string): boolean {
  // normalize() collapses any ../ before it can escape the UI directory.
  const target = join(UI_DIR, normalize(relativePath).replace(/^(\.\.[/\\])+/, ''))
  if (!target.startsWith(UI_DIR) || !existsSync(target) || !statSync(target).isFile()) {
    return false
  }
  res.writeHead(200, {
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  })
  createReadStream(target).pipe(res)
  return true
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

/** Translate the page's scope once for every route that reads its comparison. */
function resolveRequest(repoPath: string, url: URL) {
  // The query string is the only source for all five. A registry fallback would
  // answer whenever the page left a parameter out at its default value, which is
  // indistinguishable from never having chosen — #55.
  return resolveComparison(repoPath, {
    override: url.searchParams.get('base'),
    target: url.searchParams.get('target'),
    commitRef: url.searchParams.get('commit'),
    // Bare ?committed and ?untracked count too: get() would return an empty string.
    committed: url.searchParams.has('committed'),
    includeUntracked: url.searchParams.has('untracked'),
  })
}

/**
 * HTTP server over one or more repositories.
 *
 * Routes are namespaced by repo (`/r/:repoId/...`), and the registry takes
 * repositories after the fact: one process serves every checkout the CLI is
 * pointed at, rather than one process per tab.
 */
export function createGhlServer({
  repos,
  idleMs = 0,
  onStop,
  catalogPaths,
}: GhlServerOptions): Server {
  const registry = new Map(repos.map((r) => [repoIdFor(r.repoPath), r] as const))
  const catalog = new Catalog(
    catalogPaths,
    repos.map((repo) => repo.repoPath),
  )
  let lastSeen = Date.now()

  const server = createServer(async (req, res) => {
    const host = req.headers.host
    if (host === undefined || !isAllowedName(`http://${host}`)) {
      return json(res, 403, { error: 'unexpected Host header' })
    }
    // CORS keeps a cross-site page from reading the response, not from firing
    // the request — so the routes that write are checked at the door too.
    const origin = req.headers.origin
    if (req.method !== 'GET' && origin !== undefined && !isAllowedName(origin)) {
      return json(res, 403, { error: 'unexpected Origin header' })
    }
    // Only past the door: a rejected request must not be able to keep the
    // process alive.
    lastSeen = Date.now()

    const url = new URL(req.url ?? '/', 'http://localhost')
    const segments = url.pathname.split('/').filter(Boolean)

    try {
      const served = () => [...registry.entries()].map(([id, r]) => ({ id, path: r.repoPath }))

      // The discovery probe, and the heartbeat the front end sends while its tab
      // is visible — which is what makes the idle timeout mean "nobody is here".
      if (url.pathname === '/api/health' && req.method === 'GET') {
        return json(res, 200, {
          ghl: true,
          revision: REVISION,
          pid: process.pid,
          repos: served(),
        })
      }

      if (url.pathname === '/api/repos' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (typeof body.repoPath !== 'string' || body.repoPath === '') {
          return json(res, 400, { error: 'missing "repoPath"' })
        }
        // Resolved here too, not only in the CLI: it rejects a path that is not
        // a repository, and registering a subdirectory registers its root.
        const known = catalog.state.repositories
          .flatMap((r) => r.worktrees)
          .find((w) => w.path === body.repoPath)
        const repoPath = known
          ? await catalog.validate(known.id)
          : await resolveRepoRoot(body.repoPath)
        await catalog.register(repoPath)
        const id = repoIdFor(repoPath)
        // set(), so registering the same repository twice keeps one entry.
        registry.set(id, { repoPath })
        return json(res, 200, { id, path: repoPath })
      }

      if (url.pathname === '/api/catalog' && req.method === 'GET')
        return json(res, 200, catalog.state)
      if (url.pathname === '/api/catalog/scan' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        void catalog.scan(body.force === true)
        return json(res, 200, catalog.state)
      }
      if (url.pathname === '/api/catalog/reset' && req.method === 'POST') {
        void catalog.reset()
        return json(res, 200, catalog.state)
      }
      if (url.pathname === '/api/catalog/favorite' && req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (
          typeof body.id !== 'string' ||
          typeof body.favorite !== 'boolean' ||
          !catalog.state.repositories.some((repo) => repo.id === body.id)
        )
          return json(res, 400, { error: 'Expected a known repository and a favorite boolean' })
        await catalog.setFavorite(body.id, body.favorite)
        return json(res, 200, catalog.state)
      }
      if (url.pathname === '/api/roots') {
        if (req.method === 'POST' || req.method === 'DELETE') {
          const body = JSON.parse((await readBody(req)) || '{}')
          if (typeof body.path !== 'string' || !body.path.trim())
            return json(res, 400, { error: 'A root path is required' })
          if (req.method === 'POST') await catalog.addRoot(body.path)
          else await catalog.removeRoot(body.path)
          void catalog.scan(true)
        } else if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' })
        return json(res, 200, { roots: catalog.state.roots, exclusions: catalog.state.exclusions })
      }
      if (url.pathname === '/api/discovery-settings' && req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (
          !Array.isArray(body.exclusions) ||
          !body.exclusions.every((name: unknown) => typeof name === 'string')
        )
          return json(res, 400, { error: 'Expected exclusions' })
        await catalog.setExclusions(body.exclusions)
        void catalog.scan(true)
        return json(res, 200, catalog.state)
      }
      if (url.pathname === '/api/catalog/status' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (
          !Array.isArray(body.ids) ||
          body.ids.length > 100 ||
          !body.ids.every((id: unknown) => typeof id === 'string' && catalog.find(id))
        )
          return json(res, 400, { error: 'Expected up to 100 known worktrees' })
        return json(res, 200, { statuses: await catalog.status(body.ids) })
      }

      if (url.pathname === '/api/shutdown' && req.method === 'POST') {
        json(res, 200, { ok: true })
        // After the response: the caller waits for the port to free up, and a
        // socket cut mid-reply would leave it guessing.
        onStop?.('requested')
        return
      }

      if (url.pathname === '/api/repos') {
        return json(res, 200, { repos: served() })
      }

      // Built assets are requested from the root, whatever repo is being viewed.
      if (segments[0] !== 'r') {
        if (
          req.method === 'GET' &&
          serveStatic(res, url.pathname === '/' ? 'index.html' : url.pathname)
        )
          return
        return json(res, 404, { error: 'not found' })
      }

      if (segments.length < 2) return json(res, 404, { error: 'not found' })

      const repoId = decodeURIComponent(segments[1] ?? '')
      let entry = registry.get(repoId)
      if (!entry && catalog.find(repoId)) {
        entry = { repoPath: await catalog.validate(repoId) }
        registry.set(repoId, entry)
      }
      if (!entry) return json(res, 404, { error: `unknown repo: ${repoId}` })

      const route = segments.slice(2).join('/')
      const { repoPath } = entry

      if (route === 'api/image' && req.method === 'GET') {
        const path = url.searchParams.get('path') ?? ''
        const revision = url.searchParams.get('revision') ?? ''
        try {
          const bytes = await readImage(repoPath, revision, path)
          res.writeHead(200, {
            'content-type': imageType(path)!,
            'content-length': bytes.length,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            // SVGs remain inert even when their URL is opened as a document.
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          })
          res.end(bytes)
        } catch {
          json(res, 404, { error: 'Image preview unavailable' })
        }
        return
      }

      if (route === 'api/diff-files' && req.method === 'GET') {
        const path = url.searchParams.get('path')
        const hash = url.searchParams.get('hash')
        if (!path || !hash) return json(res, 400, { error: 'Missing path or expected file hash' })
        const { patch } = await resolveRequest(repoPath, url)
        const result = await patch()
        const expected = url.searchParams.get('comparison')
        if (expected && expected !== JSON.stringify(result.comparison)) {
          return json(res, 409, {
            error: 'Comparison changed; refresh the diff before expanding context',
          })
        }
        try {
          const files = await comparisonReader(repoPath, result).files(path, hash)
          res.setHeader('cache-control', 'no-store')
          return json(res, 200, files)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return json(res, /refresh/.test(message) ? 409 : 422, { error: message })
        }
      }

      if (route === 'api/diff' && req.method === 'GET') {
        const comparison = await resolveRequest(repoPath, url)
        const [{ patchResult, hashes, payload: display }, state, stored] = await Promise.all([
          comparison.display(repoId),
          repoState(repoPath),
          readState(repoPath),
        ])

        const payload: DiffPayload = {
          ...display,
          repo: { id: repoId, path: repoPath },
          state,
          viewed: pruneStale(stored.state.viewed[display.range] ?? {}, hashes),
          comments: await comparisonReader(repoPath, patchResult).comments(stored.state.comments, {
            includeOutside: true,
          }),
          notice: [stored.notice, display.notice].filter(Boolean).join(' — ') || null,
        }
        return json(res, 200, payload)
      }

      if (route === 'api/refs' && req.method === 'GET') {
        const [refs, trunk, branch] = await Promise.all([
          listRefDetails(repoPath),
          detectTrunk(repoPath),
          currentBranch(repoPath),
        ])
        const payload: RefsPayload = { refs, trunk, branch }
        return json(res, 200, payload)
      }

      if (route === 'api/commits' && req.method === 'GET') {
        // Through `resolveRequest` for its base: a list built against another
        // one describes another range, and the picker would offer commits the
        // view cannot show.
        const { base, target } = await resolveRequest(repoPath, url)
        const reviewing = target ?? base.branch ?? 'HEAD'
        const payload: CommitsPayload = {
          commits: await listCommits(repoPath, base.ref, reviewing),
        }
        return json(res, 200, payload)
      }

      if (route === 'api/viewed' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (body.clear) return json(res, 200, { viewed: await clearViewed(repoPath, body.range) })
        if (!body.range || !body.path) return json(res, 400, { error: 'missing "range" or "path"' })
        const viewed = await setViewed(repoPath, body)
        return json(res, 200, { viewed })
      }

      if (route === 'api/comments' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const { id, path, side, start, end, range } = body
        if (!id || !path || !range)
          return json(res, 400, { error: 'missing "id", "path" or "range"' })
        if (side !== 'additions' && side !== 'deletions') {
          return json(res, 400, { error: '"side" must be "additions" or "deletions"' })
        }
        if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
          return json(res, 400, { error: '"start" and "end" must be a line range' })
        }

        // The anchor is read here, not sent. The front has the hunks parsed and
        // could cut the lines itself, but then two implementations of the same
        // cut decide whether a comment is stale, and they drift.
        //
        // Through the same resolution as `api/diff`, so the patch is the one on
        // screen: a remark written while reading a single commit anchors on the
        // lines that commit had, not on what the branch made of them since.
        const { patch } = await resolveRequest(repoPath, url)
        const result = await patch()
        const reader = comparisonReader(repoPath, result)
        const anchor = await reader.lines({ path, side, start, end })
        if (!anchor) return json(res, 400, { error: 'Lines are not available in this comparison' })

        const comment: Comment = {
          id: String(id),
          path: String(path),
          side,
          start,
          end,
          body: String(body.body ?? ''),
          anchor,
          range: String(range),
          // Ours, not the client's: it orders a thread, and a clock we do not
          // control orders it by whichever tab was wrong. An edit keeps the
          // original — see putComment.
          createdAt: new Date().toISOString(),
        }
        const comments = await putComment(repoPath, comment)
        // The UI replaces its optimistic entry with this response, so include
        // the code used by Copy, just as api/diff does. Read the stored entry
        // to preserve the original createdAt when this was an edit.
        const [saved] = await reader.comments(comments.filter((stored) => stored.id === comment.id))
        return json(res, 200, { comment: saved, comments })
      }

      if (route === 'api/comments' && req.method === 'PATCH') {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (typeof body.id !== 'string' || typeof body.body !== 'string' || !body.body.trim()) {
          return json(res, 400, { error: 'A comment ID and non-empty body are required' })
        }
        const saved = await updateCommentBody(repoPath, body.id, body.body.trim())
        if (!saved) return json(res, 404, { error: 'Comment no longer exists' })
        const { patch } = await resolveRequest(repoPath, url)
        const [comment] = await comparisonReader(repoPath, await patch()).comments([saved], {
          includeOutside: true,
        })
        return json(res, 200, { comment })
      }

      if (route === 'api/comments' && req.method === 'DELETE') {
        const id = url.searchParams.get('id')
        if (!id) return json(res, 400, { error: 'missing "id"' })
        return json(res, 200, { comments: await removeComment(repoPath, id) })
      }

      if (route === 'api/base' && req.method === 'POST') {
        const { base, target } = JSON.parse((await readBody(req)) || '{}')
        if (!base) return json(res, 400, { error: 'missing "base"' })
        // Remember against what is being reviewed, not against the checkout.
        const branch = target ?? (await currentBranch(repoPath))
        await rememberBase(repoPath, branch, base)
        return json(res, 200, { ok: true, branch, base })
      }

      // Anything else under /r/<repoId> is a UI route: hand back the app shell.
      if (req.method === 'GET' && !route.startsWith('api/')) {
        if (serveStatic(res, 'index.html')) return
        return json(res, 503, {
          error: 'UI not built — run `pnpm build` in the ghl checkout',
        })
      }

      return json(res, 404, { error: 'not found' })
    } catch (error) {
      return json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  if (idleMs > 0 && onStop) {
    // Never coarser than the threshold itself, or a short one would never fire.
    const tick = Math.max(250, Math.min(IDLE_TICK_MS, idleMs))
    const timer = setInterval(() => {
      if (Date.now() - lastSeen >= idleMs) onStop('idle')
    }, tick)
    // Never the reason the process stays up: the listening socket is.
    timer.unref()
    server.on('close', () => clearInterval(timer))
  }

  server.once('listening', () => {
    void catalog.scan()
  })
  return server
}

export function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('server is not listening on a TCP port'))
        return
      }
      resolve(address.port)
    })
  })
}

/**
 * Listen on `port`, or on the next free one after it.
 *
 * The point of a fixed port is a URL you can bookmark, so the first choice
 * matters; but a second `ghl` in another repository must still come up rather
 * than fail. Sliding keeps it near enough to recognise, and the ephemeral port
 * at the end means it always comes up.
 */
export async function listenNear(server: Server, port: number, span = 10): Promise<number> {
  if (port === 0) return listen(server, 0)

  for (let candidate = port; candidate < port + span; candidate++) {
    try {
      return await listen(server, candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  return listen(server, 0)
}
