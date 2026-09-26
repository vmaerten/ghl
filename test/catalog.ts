import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Catalog } from '../src/catalog.ts'
import { createGhlServer, listen, repoIdFor } from '../src/server.ts'
import type { Check } from './harness.ts'

const git = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
function repository(path: string) {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '--initial-branch=main')
  git(path, 'config', 'user.name', 'Discovery test')
  git(path, 'config', 'user.email', 'discovery@example.invalid')
  git(path, 'config', 'commit.gpgsign', 'false')
  git(path, 'config', 'core.hooksPath', '/dev/null')
  writeFileSync(join(path, 'file.txt'), 'base\n')
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'initial')
}
export async function runCatalog(check: Check) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ghl-catalog-')))
  const roots = join(dir, 'projects')
  const main = join(roots, 'project with spaces')
  const linked = join(dir, 'external worktree')
  const paths = {
    config: join(dir, 'config', 'discovery.json'),
    cache: join(dir, 'cache', 'catalog.json'),
  }
  try {
    repository(main)
    git(main, 'worktree', 'add', '-qb', 'feature', linked)
    git(main, 'worktree', 'lock', linked)
    const nested = join(main, 'nested')
    repository(nested)
    const hidden = join(roots, '.hidden', 'repo')
    repository(hidden)
    repository(join(roots, 'node_modules', 'ignored'))
    const terraformModule = join(main, '.terraform', 'modules', 'eks.eks.kms')
    repository(terraformModule)
    repository(join(main, '.terragrunt-cache', 'downloaded-module'))
    const clone = join(roots, 'clone')
    git(dir, 'clone', '-q', main, clone)
    const bare = join(roots, 'bare.git')
    git(dir, 'clone', '--bare', '-q', main, bare)
    const bareLinked = join(dir, 'bare-worktree')
    git(bare, 'worktree', 'add', '-q', bareLinked)
    const symlinkOnly = join(dir, 'unfollowed')
    repository(symlinkOnly)
    git(
      main,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      symlinkOnly,
      'modules/sub',
    )
    symlinkSync(symlinkOnly, join(roots, 'symlink'))
    symlinkSync(roots, join(dir, 'root-link'))
    const orphaned = join(roots, 'orphaned worktree')
    const missingGitDir = join(dir, 'old location', '.git')
    mkdirSync(orphaned)
    writeFileSync(join(orphaned, '.git'), `gitdir: ${missingGitDir}\n`)
    const relativeOrphan = join(roots, 'relative orphan')
    mkdirSync(relativeOrphan)
    writeFileSync(join(relativeOrphan, '.git'), 'gitdir: ../../missing-metadata\n')
    const staleLinked = join(roots, 'stale-slot')
    mkdirSync(staleLinked)
    writeFileSync(
      join(staleLinked, '.git'),
      `gitdir: ${join(dir, 'missing', '.git', 'worktrees', 'slot-1')}\n`,
    )
    repository(join(staleLinked, 'nested-in-linked-checkout'))
    const catalog = new Catalog(paths)
    await catalog.addRoot(join(dir, 'root-link'))
    await catalog.addRoot(main)
    // A previous scanner could have cached a dependency before it was excluded.
    await catalog.register(terraformModule, false, [roots, main])
    const first = catalog.scan(true)
    check('concurrent scans join the same operation', first === catalog.scan(true))
    await first
    check(
      'orphaned Git pointers explain the missing metadata without a command dump',
      [
        [orphaned, missingGitDir],
        [relativeOrphan, join(dir, 'missing-metadata')],
      ].every(([path, target]) =>
        catalog.state.scan.errors.some(
          (error) =>
            error.path === path &&
            error.message.includes('missing Git directory') &&
            error.message.includes(target!) &&
            !error.message.includes('Command failed') &&
            !error.message.includes('(null)'),
        ),
      ),
      JSON.stringify(catalog.state.scan.errors),
    )
    const worktrees = catalog.state.repositories.flatMap((r) => r.worktrees)
    check(
      'stale linked checkouts and their descendants are skipped without warnings',
      !catalog.state.scan.errors.some((error) => error.path.startsWith(staleLinked)) &&
        !worktrees.some((worktree) => worktree.path.startsWith(staleLinked)),
    )
    check(
      'ordinary, nested, hidden, submodule, clone and bare sources discovered',
      catalog.state.repositories.length === 6,
      String(catalog.state.repositories.length),
    )
    check(
      'overlapping roots do not duplicate worktrees',
      new Set(worktrees.map((w) => w.id)).size === worktrees.length,
    )
    check(
      'linked external worktree is grouped with its main repository',
      catalog.state.repositories.some(
        (r) =>
          r.worktrees.some((w) => w.path === main) &&
          r.worktrees.some((w) => w.path === linked && w.external && w.locked),
      ),
    )
    check(
      'repository destination is its main checkout, even with linked worktrees',
      catalog.state.repositories.find((r) => r.worktrees.some((w) => w.path === linked))
        ?.mainWorktreeId === repoIdFor(main),
    )
    check(
      'bare repositories never offer a linked worktree as their main checkout',
      catalog.state.repositories.find((r) => r.commonDir === bare)?.mainWorktreeId === null,
    )
    check(
      'bare source only offers its linked checkout',
      worktrees.some((w) => w.path === bareLinked) && !worktrees.some((w) => w.path === bare),
    )
    check(
      'symlink children and excluded folders skipped',
      !worktrees.some((w) => w.path === symlinkOnly || w.path.includes('node_modules')),
    )
    check(
      'generated infrastructure caches are removed even when unrelated worktrees are broken',
      !worktrees.some((w) => /\/(\.terraform|\.terragrunt-cache)\//.test(w.path)),
    )
    check('explicit symlink root canonicalized', catalog.state.roots.includes(roots))
    check(
      'locked checkout remains openable',
      (await catalog.validate(repoIdFor(linked))) === linked,
    )
    const linkedOnly = new Catalog({
      config: join(dir, 'linked-only-config.json'),
      cache: join(dir, 'linked-only-cache.json'),
    })
    await linkedOnly.addRoot(linked)
    await linkedOnly.scan(true)
    check(
      'discovery skips a healthy linked checkout even when configured as a root',
      linkedOnly.state.repositories.length === 0 && linkedOnly.state.scan.errors.length === 0,
    )
    writeFileSync(join(linked, 'file.txt'), 'changed\n')
    writeFileSync(join(linked, 'new.txt'), 'untracked\n')
    const [status] = await catalog.status([repoIdFor(linked)])
    check(
      'status distinguishes tracked and untracked changes',
      status?.tracked === 1 &&
        status.untracked === 1 &&
        status.conflicts === 0 &&
        status.branch === 'feature',
    )
    writeFileSync(join(linked, 'another.txt'), 'new\n')
    check(
      'status is cached for ten seconds',
      (await catalog.status([repoIdFor(linked)]))[0]?.untracked === 1,
    )
    check(
      'only requested status entries returned',
      (await catalog.status([repoIdFor(main)])).length === 1,
    )
    git(linked, 'checkout', '--detach', '-q')
    const fresh = new Catalog(paths)
    check('catalog immediately restored from disk', fresh.find(repoIdFor(linked))?.path === linked)
    check(
      'detached status refreshes branch',
      (await fresh.status([repoIdFor(linked)]))[0]?.branch === null,
    )
    const blob = git(linked, 'rev-parse', 'HEAD:file.txt')
    execFileSync('git', ['-C', linked, 'update-index', '--index-info'], {
      input: `0 ${'0'.repeat(40)}\tfile.txt\n${[1, 2, 3].map((stage) => `100644 ${blob} ${stage}\tfile.txt\n`).join('')}`,
    })
    check(
      'conflicts are distinct from tracked and untracked changes',
      (await new Catalog(paths).status([repoIdFor(linked)]))[0]?.conflicts === 1,
    )
    renameSync(roots, `${roots}-away`)
    await catalog.scan(true)
    check(
      'inaccessible root preserves known entries and reports error',
      catalog.find(repoIdFor(main)) !== undefined && catalog.state.scan.errors.length > 0,
    )
    renameSync(`${roots}-away`, roots)
    rmSync(linked, { recursive: true, force: true })
    let rejected = false
    try {
      await catalog.validate(repoIdFor(linked))
    } catch {
      rejected = true
    }
    check(
      'deleted worktree refuses opening with explanation',
      rejected && catalog.find(repoIdFor(linked))?.available === false,
    )
    await catalog.register(main)
    await catalog.removeRoot(main)
    await catalog.removeRoot(roots)
    check(
      'removing roots preserves explicitly opened reviews only',
      catalog.state.repositories.length === 1 && catalog.state.repositories[0]?.explicit === true,
    )
    check(
      'configuration is versioned',
      JSON.parse(readFileSync(paths.config, 'utf8')).version === 2,
    )
    const legacyPaths = {
      config: join(dir, 'legacy-settings.json'),
      cache: join(dir, 'legacy-cache.json'),
    }
    writeFileSync(
      legacyPaths.config,
      JSON.stringify({
        version: 1,
        roots: [roots],
        exclusions: ['.git', 'custom-cache'],
      }),
    )
    const legacy = new Catalog(legacyPaths)
    check(
      'existing settings gain generated-cache exclusions while preserving custom exclusions',
      ['.terraform', '.terragrunt-cache', 'custom-cache'].every((name) =>
        legacy.state.exclusions.includes(name),
      ),
    )
    await legacy.setExclusions(['.git', 'custom-cache'])
    check(
      'explicitly allowing generated caches survives a restart',
      !new Catalog(legacyPaths).state.exclusions.includes('.terraform'),
    )
    writeFileSync(paths.cache, '{invalid')
    const invalid = new Catalog(paths)
    check(
      'invalid cache is reported without stopping discovery',
      invalid.state.repositories.length === 0 && invalid.state.scan.errors.length === 1,
    )
    await invalid.addRoot(roots)
    await invalid.scan(true)
    const hot = new Catalog({
      config: join(dir, 'hot-config.json'),
      cache: join(dir, 'hot-cache.json'),
    })
    await hot.addRoot(main)
    const scanning = hot.scan(true)
    await hot.addRoot(symlinkOnly)
    await scanning
    check(
      'a root added during discovery joins the active scan',
      hot.find(repoIdFor(symlinkOnly)) !== undefined,
    )
    const removing = hot.scan(true)
    await hot.removeRoot(main)
    await removing
    check(
      'removing a root during discovery does not restore its contribution',
      hot.state.repositories.length === 1 && hot.find(repoIdFor(symlinkOnly)) !== undefined,
    )
    const resetPaths = {
      config: join(dir, 'reset-config.json'),
      cache: join(dir, 'reset-cache.json'),
    }
    const resettable = new Catalog(resetPaths)
    await resettable.addRoot(main)
    await resettable.register(terraformModule)
    await resettable.register(symlinkOnly)
    const favoriteRepo = await resettable.register(main)
    await resettable.setFavorite(favoriteRepo.id, true)
    await resettable.setFavorite(favoriteRepo.id, true)
    check(
      'favorites are durable and idempotent',
      new Catalog(resetPaths).state.favorites.length === 1 &&
        new Catalog(resetPaths).state.favorites[0] === favoriteRepo.id,
    )
    const configBefore = readFileSync(resetPaths.config, 'utf8')
    const moduleBefore = readFileSync(join(terraformModule, 'file.txt'), 'utf8')
    const inProgress = resettable.scan(true)
    check('reset joins an active scan', resettable.reset() === inProgress)
    await inProgress
    check(
      'reset removes explicitly opened excluded and outside-root entries',
      resettable.find(repoIdFor(terraformModule)) === undefined &&
        resettable.find(repoIdFor(symlinkOnly)) === undefined &&
        resettable.find(repoIdFor(main)) !== undefined &&
        resettable.find(repoIdFor(nested)) !== undefined,
    )
    check(
      'reset preserves settings and repository files',
      readFileSync(resetPaths.config, 'utf8') === configBefore &&
        readFileSync(join(terraformModule, 'file.txt'), 'utf8') === moduleBefore,
    )
    check(
      'reset cache stays clean after restart',
      new Catalog(resetPaths).find(repoIdFor(terraformModule)) === undefined,
    )
    check(
      'favorites survive clear and rescan',
      resettable.state.favorites.includes(favoriteRepo.id),
    )
    await resettable.setFavorite(favoriteRepo.id, false)
    check('removing a favorite is durable', new Catalog(resetPaths).state.favorites.length === 0)
    const blockedConfig = join(dir, 'blocked-favorite-config')
    writeFileSync(blockedConfig, 'not a directory')
    const cannotSave = new Catalog({
      config: join(blockedConfig, 'settings.json'),
      cache: join(dir, 'unused-cache.json'),
    })
    await cannotSave.register(main, false)
    let favoriteRejected = false
    try {
      await cannotSave.setFavorite(favoriteRepo.id, true)
    } catch {
      favoriteRejected = true
    }
    check(
      'failed favorite writes do not leave an unsaved favorite',
      favoriteRejected && cannotSave.state.favorites.length === 0,
    )
    const server = createGhlServer({ repos: [], catalogPaths: paths })
    const port = await listen(server, 0)
    const base = `http://127.0.0.1:${port}`
    try {
      check('home served without an opened repository', (await fetch(base)).status === 200)
      check(
        'favorite endpoint rejects unknown repositories',
        (
          await fetch(`${base}/api/catalog/favorite`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: 'unknown', favorite: true }),
          })
        ).status === 400,
      )
      check(
        'favorite mutations reject cross-site origins',
        (
          await fetch(`${base}/api/catalog/favorite`, {
            method: 'PUT',
            headers: { origin: 'https://example.com' },
          })
        ).status === 403,
      )
      check(
        'cached bookmark reconstitutes checkout registry',
        (await fetch(`${base}/r/${repoIdFor(main)}`)).status === 200,
      )
      check(
        'status rejects unknown destinations',
        (
          await fetch(`${base}/api/catalog/status`, {
            method: 'POST',
            body: JSON.stringify({ ids: ['unknown'] }),
          })
        ).status === 400,
      )
      check(
        'catalog mutations reject cross-site origins',
        (
          await fetch(`${base}/api/catalog/scan`, {
            method: 'POST',
            headers: { origin: 'https://example.com' },
          })
        ).status === 403,
      )
      check(
        'health contract retains registered repos',
        (await (await fetch(`${base}/api/health`)).json()).repos.some(
          (r: { id: string }) => r.id === repoIdFor(main),
        ),
      )
      // Let the startup scan finish before removing its fixture.
      for (let i = 0; i < 200; i++) {
        if (!(await (await fetch(`${base}/api/catalog`)).json()).scan.active) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
