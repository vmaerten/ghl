import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { repoIdFor } from './checkoutId.ts'
import type { CatalogPayload, CatalogRepository, CatalogWorktree, WorktreeStatus } from './types.ts'

const exec = promisify(execFile)
const git = async (path: string, ...args: string[]) => {
  try {
    return (
      await exec('git', ['-C', path, ...args], {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout
  } catch (cause) {
    // Git can report only "not a git repository: (null)" for stale worktree pointers.
    // Inspect metadata only on failure, leaving ordinary discovery probes unchanged.
    let missing: string | undefined
    try {
      const pointer = await readFile(join(path, '.git'), 'utf8')
      if (pointer.startsWith('gitdir: ')) {
        const target = resolve(path, pointer.slice(8).trimEnd())
        try {
          await stat(target)
        } catch (error) {
          if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
            missing = target
        }
      }
    } catch {
      // Bare repositories and ordinary .git directories have no pointer file.
    }
    const stderr = (cause as { stderr?: string }).stderr?.trim().replace(/^fatal: /, '')
    throw new Error(
      missing
        ? `.git points to a missing Git directory: ${missing}. The checkout may have moved or its Git metadata was removed.`
        : stderr || message(cause),
      { cause },
    )
  }
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
export interface CatalogPaths {
  config: string
  cache: string
}
export function catalogPaths(): CatalogPaths {
  const configHome = process.env.XDG_CONFIG_HOME
  const cacheHome = process.env.XDG_CACHE_HOME
  return {
    config: join(
      configHome && isAbsolute(configHome) ? configHome : join(homedir(), '.config'),
      'ghl',
      'discovery.json',
    ),
    cache: join(
      cacheHome && isAbsolute(cacheHome) ? cacheHome : join(homedir(), '.cache'),
      'ghl',
      'catalog.json',
    ),
  }
}
const generatedCaches = ['.terraform', '.terragrunt-cache']
const defaults = ['.git', 'node_modules', '.venv', '.cache', 'dist', 'build', ...generatedCaches]

/** Linked checkouts are not discovery roots, including stale pointers left after a move. */
async function isLinkedCheckout(path: string) {
  const pointer = await readFile(join(path, '.git'), 'utf8')
  if (!pointer.startsWith('gitdir: ')) return false
  const gitDir = resolve(path, pointer.slice(8).trimEnd())
  try {
    await stat(join(gitDir, 'commondir'))
    return true
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    // Git stores linked checkout metadata in <common-dir>/worktrees/<name>.
    return /\/worktrees\/[^/]+$/.test(gitDir)
  }
}

/** Discovery never reads patches. Disk traversal and repository Git probes are serial. */
export class Catalog {
  readonly state: CatalogPayload = {
    repositories: [],
    favorites: [],
    roots: [],
    exclusions: [...defaults],
    scan: { active: false, finishedAt: null, visited: 0, errors: [] },
  }
  private loadErrors: CatalogPayload['scan']['errors'] = []
  private settingsVersion = 0
  private resetRequested = false
  private active: Promise<void> | null = null
  private writes = Promise.resolve()
  private favoriteWrites = Promise.resolve()
  private statuses = new Map<string, { at: number; result: Promise<WorktreeStatus> }>()
  private statusTail = Promise.resolve()
  private paths: CatalogPaths
  private initialPaths: string[]
  constructor(paths: CatalogPaths = catalogPaths(), initialPaths: string[] = []) {
    this.paths = paths
    this.initialPaths = initialPaths
    for (const kind of ['config', 'cache'] as const) {
      try {
        const data = JSON.parse(readFileSync(paths[kind], 'utf8'))
        if (data.version !== 1 && !(kind === 'config' && data.version === 2))
          throw new Error('Unsupported discovery file version')
        if (kind === 'config') {
          if (
            !Array.isArray(data.roots) ||
            !data.roots.every((p: unknown) => typeof p === 'string' && isAbsolute(p)) ||
            !Array.isArray(data.exclusions) ||
            !data.exclusions.every((p: unknown) => typeof p === 'string') ||
            (data.favorites !== undefined &&
              (!Array.isArray(data.favorites) ||
                !data.favorites.every((id: unknown) => typeof id === 'string')))
          )
            throw new Error('Invalid discovery settings')
          this.state.roots = data.roots
          this.state.favorites = [...new Set<string>(data.favorites ?? [])]
          this.state.exclusions = [
            ...new Set([
              '.git',
              ...data.exclusions,
              ...(data.version === 1 ? generatedCaches : []),
            ]),
          ] as string[]
        } else {
          if (
            !Array.isArray(data.repositories) ||
            !data.repositories.every(
              (r: CatalogRepository) =>
                typeof r.commonDir === 'string' &&
                typeof r.name === 'string' &&
                typeof r.id === 'string' &&
                Array.isArray(r.roots) &&
                Array.isArray(r.worktrees) &&
                r.worktrees.every((w) => typeof w.path === 'string' && w.id === repoIdFor(w.path)),
            )
          )
            throw new Error('Invalid discovery cache')
          this.state.repositories = data.repositories.map((repo: CatalogRepository) => ({
            ...repo,
            mainWorktreeId:
              repo.mainWorktreeId === undefined
                ? (repo.worktrees.find((w) => w.path === dirname(repo.commonDir))?.id ?? null)
                : repo.mainWorktreeId,
          }))
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          this.state.scan.errors.push({ path: paths[kind], message: message(error) })
      }
    }
    this.loadErrors = [...this.state.scan.errors]
  }
  private persist(kind: 'config' | 'cache') {
    const body = JSON.stringify(
      kind === 'config'
        ? {
            version: 2,
            roots: this.state.roots,
            exclusions: this.state.exclusions,
            favorites: this.state.favorites,
          }
        : { version: 1, repositories: this.state.repositories },
    )
    const path = this.paths[kind]
    const task = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(path), { recursive: true })
        const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
        await writeFile(temporary, body, { mode: 0o600 })
        await rename(temporary, path)
        return undefined
      })
    this.writes = task
    return task
  }
  async addRoot(input: string) {
    const path = await realpath(
      resolve(
        input === '~'
          ? homedir()
          : input.startsWith('~/')
            ? join(homedir(), input.slice(2))
            : input,
      ),
    )
    if (!(await stat(path)).isDirectory()) throw new Error('Root must be a directory')
    if (!this.state.roots.includes(path)) this.state.roots.push(path)
    this.settingsVersion++
    await this.persist('config')
    this.state.scan.finishedAt = null
    return path
  }
  setFavorite(id: string, favorite: boolean): Promise<void> {
    const task = this.favoriteWrites.then(async () => {
      if (!this.state.repositories.some((repo) => repo.id === id))
        throw new Error('Unknown repository')
      const previous = this.state.favorites
      this.state.favorites = favorite
        ? [...new Set([...previous, id])]
        : previous.filter((value) => value !== id)
      try {
        await this.persist('config')
      } catch (error) {
        this.state.favorites = previous
        throw error
      }
      return undefined
    })
    this.favoriteWrites = task.catch(() => {})
    return task
  }
  async removeRoot(path: string) {
    this.state.roots = this.state.roots.filter((root) => root !== path)
    for (const repo of this.state.repositories)
      repo.roots = repo.roots.filter((root) => root !== path)
    this.state.repositories = this.state.repositories.filter(
      (repo) => repo.explicit || repo.roots.length,
    )
    this.updateExternal()
    this.settingsVersion++
    await this.persist('config')
    await this.persist('cache')
  }
  async setExclusions(exclusions: string[]) {
    if (exclusions.some((name) => !name || name.includes('/') || name.includes('\\')))
      throw new Error('Exclusions must be directory names')
    this.state.exclusions = [...new Set(['.git', ...exclusions])]
    this.settingsVersion++
    await this.persist('config')
    this.state.scan.finishedAt = null
  }
  find(id: string) {
    return this.state.repositories.flatMap((repo) => repo.worktrees).find((w) => w.id === id)
  }
  private updateExternal() {
    for (const repo of this.state.repositories)
      for (const w of repo.worktrees)
        w.external = !this.state.roots.some((root) => inside(root, w.path))
  }
  async register(path: string, explicit = true, roots: string[] = []) {
    const commonDir = await realpath(
      (await git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim(),
    )
    const old = this.state.repositories.find((repo) => repo.commonDir === commonDir)
    const worktrees: CatalogWorktree[] = []
    let mainWorktreeId: string | null = null
    const output = await git(path, 'worktree', 'list', '--porcelain', '-z')
    for (const [index, record] of output.split('\0\0').entries()) {
      const fields = record.split('\0')
      const location = fields.find((f) => f.startsWith('worktree '))?.slice(9)
      if (!location || fields.includes('bare')) continue
      let canonical = location
      let error: string | undefined
      try {
        canonical = await realpath(location)
      } catch (cause) {
        error = message(cause)
      }
      if (index === 0) mainWorktreeId = repoIdFor(canonical)
      worktrees.push({
        id: repoIdFor(canonical),
        path: canonical,
        branch:
          fields
            .find((f) => f.startsWith('branch '))
            ?.slice(7)
            .replace(/^refs\/heads\//, '') ?? null,
        head: fields.find((f) => f.startsWith('HEAD '))?.slice(5) ?? '',
        locked: fields.some((f) => f === 'locked' || f.startsWith('locked ')),
        available: !error,
        error,
        external: false,
      })
    }
    for (const previous of old?.worktrees ?? [])
      if (!worktrees.some((w) => w.id === previous.id))
        worktrees.push({
          ...previous,
          available: false,
          error: 'Worktree is no longer registered with Git',
        })
    const repo: CatalogRepository = {
      mainWorktreeId,
      id: repoIdFor(commonDir),
      commonDir,
      name: basename(commonDir.endsWith('/.git') ? dirname(commonDir) : commonDir),
      roots: [...new Set([...(old?.roots ?? []), ...roots])],
      explicit: explicit || old?.explicit || false,
      worktrees,
    }
    this.state.repositories = [
      ...this.state.repositories.filter((r) => r.commonDir !== commonDir),
      repo,
    ]
    this.updateExternal()
    if (explicit) await this.persist('cache')
    return repo
  }
  async validate(id: string) {
    const worktree = this.find(id)
    if (!worktree) throw new Error('Unknown worktree')
    try {
      const path = await realpath((await git(worktree.path, 'rev-parse', '--show-toplevel')).trim())
      if (repoIdFor(path) !== id) throw new Error('Worktree has moved')
      const common = await realpath(
        (await git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim(),
      )
      if (
        !this.state.repositories.some(
          (r) => r.commonDir === common && r.worktrees.some((w) => w.id === id),
        )
      )
        throw new Error('Repository at this path has changed')
      worktree.available = true
      delete worktree.error
      return path
    } catch (error) {
      worktree.available = false
      worktree.error = message(error)
      throw new Error(`Worktree unavailable: ${worktree.path}. ${worktree.error}`, { cause: error })
    }
  }
  /** Forget discovery history while keeping roots, exclusions and review storage intact. */
  reset(): Promise<void> {
    this.resetRequested = true
    this.settingsVersion++
    return this.scan(true)
  }
  scan(force = false): Promise<void> {
    if (this.active) return this.active
    if (!force && this.state.scan.finishedAt && Date.now() - this.state.scan.finishedAt < 30_000)
      return Promise.resolve()
    this.state.scan = {
      active: true,
      finishedAt: this.state.scan.finishedAt,
      visited: 0,
      errors: [...this.loadErrors],
    }
    this.active = (async () => {
      let version: number
      do {
        version = this.settingsVersion
        if (this.resetRequested) {
          this.resetRequested = false
          this.initialPaths = []
          this.state.repositories = []
          this.statuses.clear()
          this.loadErrors = this.loadErrors.filter((error) => error.path !== this.paths.cache)
          this.state.scan.errors = [...this.loadErrors]
          this.state.scan.visited = 0
          await this.persist('cache')
        }
        await this.discover()
      } while (version !== this.settingsVersion)
    })()
      .catch((error) => {
        this.state.scan.errors.push({ path: this.paths.cache, message: message(error) })
      })
      .finally(() => {
        this.state.scan.active = false
        this.state.scan.finishedAt = Date.now()
        this.active = null
      })
    return this.active
  }
  private async discover() {
    const initialPaths = this.initialPaths
    this.initialPaths = []
    for (const path of initialPaths) {
      try {
        await this.register(path)
      } catch (error) {
        this.state.scan.errors.push({ path, message: message(error) })
      }
    }
    const visited = new Set<string>()
    const found = new Map<string, Set<string>>()
    const failed: string[] = []
    const walk = async (path: string): Promise<void> => {
      if (visited.has(path)) return
      visited.add(path)
      this.state.scan.visited++
      try {
        const entries = await readdir(path, { withFileTypes: true })
        if (
          entries.some((entry) => entry.name === '.git' && entry.isFile()) &&
          (await isLinkedCheckout(path))
        )
          return
        if (
          entries.some((e) => e.name === '.git') ||
          (entries.some((e) => e.name === 'HEAD') && entries.some((e) => e.name === 'objects'))
        ) {
          try {
            const repo = await this.register(
              path,
              false,
              this.state.roots.filter((root) => inside(root, path)),
            )
            const contributions = found.get(repo.id) ?? new Set<string>()
            for (const root of this.state.roots.filter((candidate) => inside(candidate, path)))
              contributions.add(root)
            found.set(repo.id, contributions)
            if ((await git(path, 'rev-parse', '--is-bare-repository')).trim() === 'true') return
          } catch (error) {
            this.state.scan.errors.push({ path, message: message(error) })
            failed.push(path)
            const known = this.find(repoIdFor(path))
            if (known) {
              known.available = false
              known.error = message(error)
            }
          }
        }
        for (const entry of entries)
          if (entry.isDirectory() && !this.state.exclusions.includes(entry.name))
            await walk(join(path, entry.name))
      } catch (error) {
        failed.push(path)
        this.state.scan.errors.push({ path, message: message(error) })
      }
    }
    for (const root of this.state.roots) await walk(root)
    const affected = (repo: CatalogRepository, root: string) =>
      failed.some(
        (path) =>
          inside(root, path) &&
          (inside(path, repo.commonDir) || repo.worktrees.some((w) => inside(path, w.path))),
      )
    for (const repo of this.state.repositories) {
      const observed = found.get(repo.id)
      if (observed)
        repo.roots = [
          ...new Set([
            ...observed,
            ...repo.roots.filter((root) => this.state.roots.includes(root) && affected(repo, root)),
          ]),
        ].filter((root) => this.state.roots.includes(root))
      if (!found.has(repo.id)) {
        const retained = repo.roots.some((root) => affected(repo, root))
        if (!retained) {
          repo.roots = []
          if (repo.explicit) {
            try {
              await this.register(
                repo.worktrees.find((w) => w.available)?.path ?? repo.commonDir,
                false,
              )
            } catch (error) {
              for (const w of repo.worktrees) {
                w.available = false
                w.error = message(error)
              }
            }
          }
        }
      }
    }
    this.state.repositories = this.state.repositories.filter(
      (repo) => repo.explicit || repo.roots.length,
    )
    this.updateExternal()
    await this.persist('cache')
  }
  async status(ids: string[]) {
    if (ids.length > 100 || ids.some((id) => !this.find(id)))
      throw new Error('Request up to 100 known worktrees')
    return Promise.all(
      [...new Set(ids)].map((id) => {
        const cached = this.statuses.get(id)
        if (cached && Date.now() - cached.at < 10_000) return cached.result
        // A single global queue also bounds concurrent requests from several tabs.
        const w = this.find(id)!
        const result = this.statusTail.then(async (): Promise<WorktreeStatus> => {
          try {
            const path = await this.validate(id)
            const output = await git(path, 'status', '--porcelain=v2', '--branch', '-z')
            const records = output.split('\0')
            w.branch = records.find((r) => r.startsWith('# branch.head '))?.slice(14) ?? null
            if (w.branch === '(detached)') w.branch = null
            w.head = records.find((r) => r.startsWith('# branch.oid '))?.slice(13) ?? w.head
            let tracked = 0,
              untracked = 0,
              conflicts = 0
            for (let i = 0; i < records.length; i++) {
              const row = records[i]!
              if (row.startsWith('1 ') || row.startsWith('2 ')) tracked++
              if (row.startsWith('2 ')) i++
              if (row.startsWith('? ')) untracked++
              if (row.startsWith('u ')) conflicts++
            }
            return { id, branch: w.branch, head: w.head, tracked, untracked, conflicts }
          } catch (error) {
            return {
              id,
              branch: w.branch,
              head: w.head,
              tracked: 0,
              untracked: 0,
              conflicts: 0,
              error: message(error),
            }
          }
        })
        this.statusTail = result.then(
          () => undefined,
          () => undefined,
        )
        this.statuses.set(id, { at: Date.now(), result })
        return result
      }),
    )
  }
}
