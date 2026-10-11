import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Comment, DiffPayload } from '../src/types.ts'
import {
  miseReleaseFixture,
  sha256,
  type Release,
  type ReleaseAsset,
} from './miseReleaseFixture.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const published = args[0] === '--published'
assert.ok(
  args.length === 0 ||
    (published && (args.length === 2 || (args.length === 4 && args[2] === '--previous'))),
  'Usage: node test/goMise.ts [--published VERSION [--previous VERSION]]',
)
const requestedVersion = args[1]?.replace(/^v/, '')
const versionPattern = /^\d+\.\d+\.\d+(?:-[\da-zA-Z]+(?:[.-][\da-zA-Z]+)*)?$/
if (published)
  assert.ok(requestedVersion && versionPattern.test(requestedVersion), 'Expected a release version')
if (args[3])
  assert.ok(versionPattern.test(args[3].replace(/^v/, '')), 'Expected a previous release version')
assert.equal(process.platform, 'darwin')
assert.equal(process.arch, 'arm64', 'Only macOS ARM64 distribution is validated')
const miseBinary = realpathSync(
  process.env.GHL_TEST_MISE ??
    execFileSync('/usr/bin/which', ['mise'], { encoding: 'utf8' }).trim(),
)
const miseVersion = execFileSync(miseBinary, ['--version'], { encoding: 'utf8' }).trim()
assert.match(
  miseVersion,
  /^2026\.10\.2 /,
  'Use mise 2026.10.2 for release acceptance (GHL_TEST_MISE can select it)',
)
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'ghl-mise-')))
const reportFile = join(
  root,
  '.task',
  published ? 'go-mise-published.json' : 'go-mise-acceptance.json',
)
const report = {
  complete: false,
  mode: published ? 'github-release' : 'local-release-fixture',
  mise: miseVersion,
  platform: `${process.platform}-${process.arch}`,
  versions: [] as string[],
  checks: [] as string[],
  upgrade: false,
  latest: false,
}
mkdirSync(dirname(reportFile), { recursive: true })
const record = (check: string) => {
  report.checks.push(check)
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n')
  console.log(`mise: ${check}`)
}
writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n')
const onlyGit = join(temporary, 'path')
mkdirSync(onlyGit)
symlinkSync(
  execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim(),
  join(onlyGit, 'git'),
)
symlinkSync(miseBinary, join(onlyGit, 'mise'))
const env: NodeJS.ProcessEnv = {
  PATH: `${onlyGit}:/usr/bin:/bin:/usr/sbin:/sbin`,
  MISE_DATA_DIR: join(temporary, 'data'),
  MISE_CONFIG_DIR: join(temporary, 'config'),
  MISE_CACHE_DIR: join(temporary, 'cache'),
  MISE_STATE_DIR: join(temporary, 'state'),
  MISE_SYSTEM_CONFIG_DIR: join(temporary, 'system'),
  MISE_GLOBAL_CONFIG_FILE: join(temporary, 'config', 'config.toml'),
  XDG_CONFIG_HOME: join(temporary, 'config'),
  XDG_DATA_HOME: join(temporary, 'data'),
  XDG_CACHE_HOME: join(temporary, 'cache'),
  XDG_STATE_HOME: join(temporary, 'state'),
  MISE_BIN: miseBinary,
  MISE_YES: '1',
  MISE_COLOR: '0',
  MISE_USE_VERSIONS_HOST: '0',
  MISE_HTTP_TIMEOUT: '15',
  MISE_NETRC: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GHL_PORT: '',
}
const execute = promisify(execFile)
const run = async (binary: string, argv: string[], overrides: NodeJS.ProcessEnv = {}) =>
  (
    await execute(binary, argv, {
      cwd: temporary,
      env: { ...env, ...overrides },
      timeout: 60_000,
      maxBuffer: 5 * 1024 * 1024,
    })
  ).stdout.trim()
const mise = (...argv: string[]) => run(miseBinary, argv)
const tool = 'github:vmaerten/ghl'
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
const github = async (path: string, accept = 'application/vnd.github+json') => {
  const response = await fetch(`https://api.github.com/repos/vmaerten/ghl/${path}`, {
    headers: { Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(30_000),
  })
  assert.equal(response.status, 200, `GitHub ${path}: HTTP ${response.status}`)
  return response
}
const download = async (asset: ReleaseAsset) => {
  const url = new URL(asset.url)
  assert.equal(url.origin, 'https://api.github.com')
  assert.ok(url.pathname.startsWith('/repos/vmaerten/ghl/releases/assets/'))
  return Buffer.from(
    await (
      await github(url.pathname.replace('/repos/vmaerten/ghl/', ''), 'application/octet-stream')
    ).arrayBuffer(),
  )
}
const repo = join(temporary, 'review with spaces')
let mirror: Awaited<ReturnType<typeof miseReleaseFixture>> | undefined
let port: number | undefined
interface Health {
  pid: number
  instance: string
  revision: string
  version: string
  commit: string
  runtime: string
}
try {
  assert.equal(
    await run('/bin/sh', [
      '-c',
      'for tool in node pnpm go; do if command -v "$tool" >/dev/null; then exit 1; fi; done',
    ]),
    '',
  )
  let current = '1.0.1'
  let previous: string | undefined = '1.0.0'
  const expected = new Map<string, { version: string; commit: string; hash: string }>()
  if (published) {
    current = requestedVersion!
    if (token) env.GITHUB_TOKEN = token
    const releases: Release[] = await (await github('releases?per_page=100')).json()
    previous =
      args[3]?.replace(/^v/, '') ??
      releases
        .find(
          (release) =>
            !release.draft &&
            !release.prerelease &&
            release.tag_name !== `v${current}` &&
            versionPattern.test(release.tag_name.replace(/^v/, '')) &&
            release.assets.some((asset) => asset.name.endsWith('_darwin_arm64.tar.gz')),
        )
        ?.tag_name.replace(/^v/, '')
    for (const version of [current, ...(previous ? [previous] : [])]) {
      const release: Release = await (await github(`releases/tags/v${version}`)).json()
      assert.equal(release.draft, false)
      const archive = release.assets.find(
        (asset) => asset.name === `ghl_${version}_darwin_arm64.tar.gz`,
      )
      const sums = release.assets.find((asset) => asset.name === 'checksums.txt')
      assert.ok(archive && sums, `Release v${version} lacks distribution assets`)
      const bytes = await download(archive)
      const checksum = (await download(sums))
        .toString()
        .split('\n')
        .find((line) => line.endsWith(`  ${archive.name}`))
        ?.split('  ')[0]
      assert.equal(sha256(bytes), checksum)
      if (archive.digest) assert.equal(archive.digest, `sha256:${checksum}`)
      const path = join(temporary, archive.name)
      writeFileSync(path, bytes)
      const binary = execFileSync('/usr/bin/tar', ['-xOzf', path, 'ghl'], {
        maxBuffer: 32 * 1024 * 1024,
      })
      expected.set(version, { version, commit: '', hash: sha256(binary) })
    }
    record('published archives match checksums.txt')
  } else {
    // Verify the actual candidate before serving it through the fixture API.
    execFileSync(process.execPath, ['test/goRelease.ts'], { cwd: root, stdio: 'inherit' })
    const dist = join(root, 'go/dist/release')
    const metadata = JSON.parse(readFileSync(join(dist, 'metadata.json'), 'utf8'))
    mirror = await miseReleaseFixture(
      temporary,
      join(dist, `ghl_${metadata.version}_darwin_arm64.tar.gz`),
      join(dist, `ghl-desktop_${metadata.version}_darwin_arm64.zip`),
    )
    env.MISE_URL_REPLACEMENTS = JSON.stringify({
      'https://api.github.com/': `${mirror.origin}/`,
      'https://github.com/': `${mirror.origin}/`,
    })
    for (const version of [previous, current]) {
      expected.set(version, {
        version: metadata.version,
        commit: metadata.commit,
        hash: sha256(readFileSync(join(temporary, version, 'ghl'))),
      })
    }
  }
  report.versions = [current, ...(previous ? [previous] : [])]
  if (previous) assert.notEqual(previous, current, 'Upgrade needs two distinct release versions')
  const installed = new Map<string, string>()
  const verify = async (version: string) => {
    const binary = realpathSync(await mise('which', '--tool', `${tool}@${version}`, 'ghl'))
    assert.ok(
      binary.startsWith(env.MISE_DATA_DIR + '/installs/'),
      'Executable must be installed in the isolated mise data directory',
    )
    assert.equal(sha256(readFileSync(binary)), expected.get(version)?.hash)
    const info = JSON.parse(await run(binary, ['--version', '--json'], { PATH: onlyGit }))
    assert.equal(info.runtime, 'go')
    assert.equal(info.version, expected.get(version)?.version)
    if (published && version === current && process.env.GHL_MISE_EXPECTED_COMMIT)
      assert.equal(info.commit, process.env.GHL_MISE_EXPECTED_COMMIT)
    if (!published) assert.equal(info.commit, expected.get(version)?.commit)
    assert.equal(
      await mise('exec', `${tool}@${version}`, '--', 'ghl', '--version', '--json'),
      JSON.stringify(info),
    )
    assert.equal(existsSync(join(dirname(binary), 'LICENSE')), true)
    assert.equal(existsSync(join(dirname(binary), 'THIRD_PARTY_NOTICES.txt')), true)
    installed.set(version, binary)
    return binary
  }
  const initial = previous ?? current
  await mise('use', '-g', `${tool}@${initial}`)
  const firstBinary = await verify(initial)
  // Activation puts the selected executable on PATH. Shims are an alternative.
  const activated = JSON.parse(
    await run('/bin/zsh', [
      '-f',
      '-c',
      'eval "$(mise activate zsh)"; eval "$(mise env -s zsh)"; ghl --version --json',
    ]),
  )
  assert.equal(activated.version, expected.get(initial)?.version)
  const shim = join(env.MISE_DATA_DIR!, 'shims', 'ghl')
  assert.equal(JSON.parse(await run(shim, ['--version', '--json'])).version, activated.version)
  record('clean install, archive autodetection, extraction, activation, shims and mise exec')
  mkdirSync(repo)
  const git = (...argv: string[]) =>
    execFileSync(join(onlyGit, 'git'), ['-C', repo, ...argv], { env, encoding: 'utf8' }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'mise fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'sample.txt'), 'before\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  git('checkout', '-qb', 'feature')
  writeFileSync(join(repo, 'sample.txt'), 'after\n')
  git('commit', '-qam', 'review')
  const listener = createServer()
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')
  port = address.port
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  const json = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', Connection: 'close' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(response.status, 200, await response.clone().text())
    return response.json()
  }
  const launch = async (binary: string) =>
    JSON.parse(
      await run(
        binary,
        [
          '--repo',
          repo,
          '--base',
          'main',
          '--port',
          String(port),
          '--idle',
          '0',
          '--no-open',
          '--json',
        ],
        { PATH: onlyGit },
      ),
    )
  const first = await launch(firstBinary)
  const route = new URL(first.url).pathname
  const original = await json<Health>('/api/health')
  assert.equal(original.runtime, 'go')
  const diff = await json<DiffPayload>(`${route}/api/diff?base=main`)
  const file = diff.files.find((entry) => entry.path === 'sample.txt')
  assert.ok(file?.hash)
  const { comment } = await json<{ comment: Comment }>(`${route}/api/comments?base=main`, 'POST', {
    id: 'mise-preserved',
    range: diff.range,
    path: file.path,
    side: 'additions',
    start: 1,
    end: 1,
    body: 'Keep this review across mise versions',
  })
  await json(`${route}/api/viewed`, 'POST', {
    range: diff.range,
    path: file.path,
    hash: file.hash,
    viewed: true,
  })
  const statePath = join(repo, '.git/ghl/state.json')
  const stored = readFileSync(statePath, 'utf8')
  const preserved = async () => {
    const review = await json<DiffPayload>(`${route}/api/diff?base=main`)
    assert.deepEqual(
      review.comments.find((entry) => entry.id === comment.id),
      comment,
    )
    assert.equal(review.viewed[file.path], file.hash)
    assert.equal(readFileSync(statePath, 'utf8'), stored)
    const page = await fetch(first.url, {
      headers: { Connection: 'close' },
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.ok(html.includes('<div id="root">'))
    const script = html.match(/src="([^"]+\.js)"/)?.[1]
    assert.ok(script)
    assert.equal(
      (
        await fetch(new URL(script, first.url), {
          headers: { Connection: 'close' },
          signal: AbortSignal.timeout(5000),
        })
      ).status,
      200,
    )
  }
  await preserved()
  record('installed executable serves embedded React with only Git; comments and Viewed saved')
  if (previous) {
    if (mirror) {
      await mise('use', '-g', `${tool}@latest`)
      assert.equal(realpathSync(await mise('which', 'ghl')), firstBinary)
      mirror.publishNext()
      await mise('cache', 'clear')
      await mise('upgrade', '--no-prune', tool)
      report.latest = true
    } else await mise('upgrade', '--bump', '--no-prune', `${tool}@${current}`)
    const nextBinary = await verify(current)
    assert.equal(realpathSync(await mise('which', 'ghl')), nextBinary)
    assert.ok(existsSync(firstBinary), 'Keep the previous version available for rollback')
    assert.equal(
      (await json<Health>('/api/health')).instance,
      original.instance,
      'Installing alone must not restart the daemon',
    )
    const next = await launch(nextBinary)
    assert.equal(next.url, first.url)
    const upgraded = await json<Health>('/api/health')
    assert.notEqual(upgraded.pid, original.pid)
    assert.notEqual(upgraded.instance, original.instance)
    await preserved()
    record('upgrade keeps the old install; next launch replaces the daemon and preserves URL/state')
    await mise('use', '-g', `${tool}@${previous}`)
    await mise('upgrade', '--no-prune', tool)
    assert.equal(
      realpathSync(await mise('which', 'ghl')),
      firstBinary,
      'An exact pin must survive upgrade',
    )
    await launch(firstBinary)
    const rollback = await json<Health>('/api/health')
    assert.notEqual(rollback.instance, upgraded.instance)
    await preserved()
    report.upgrade = true
    record('rollback and exact pin preserve comments, anchors, timestamps and Viewed')
  } else record('first published version: historical upgrade/rollback awaits a second release')
  if (mirror) {
    // Exercise the exact-version upgrade command used by published mode too.
    await mise('upgrade', '--bump', '--no-prune', `${tool}@${current}`)
    assert.equal(realpathSync(await mise('which', 'ghl')), await verify(current))
    await mise('use', '-g', `${tool}@${previous}`)
    await assert.rejects(() => mise('install', `${tool}@1.0.2`), /checksum|digest|mismatch/i)
    assert.equal(realpathSync(await mise('which', 'ghl')), firstBinary)
    await preserved()
    assert.ok(mirror.requested.some((path) => path.endsWith('/checksums.txt')))
    assert.ok(mirror.requested.some((path) => path.endsWith('_darwin_arm64.tar.gz')))
    assert.ok(!mirror.requested.some((path) => path.endsWith('.zip')))
    record('CLI archive selected alongside desktop ZIP')
    const remote = await mise('ls-remote', tool)
    assert.ok(remote.includes('1.0.1'))
    assert.ok(!remote.includes('rc.1'), 'latest must exclude prereleases by default')
    record(
      'corrupt download rejected without altering selected version or review; prereleases excluded',
    )
  } else if (!current.includes('-')) {
    // The live gate validates this release immediately, before mise's default
    // minimum release age. Consumers can retain that delay or pin explicitly.
    await mise('use', '-g', '--minimum-release-age', '0s', `${tool}@latest`)
    assert.equal(
      realpathSync(await mise('which', 'ghl')),
      realpathSync(await mise('which', '--tool', `${tool}@${current}`, 'ghl')),
    )
    report.latest = true
    record('latest resolves the newly published stable release')
  }
  const health = await json<Health>('/api/health')
  await json('/api/shutdown', 'POST', { instance: health.instance })
  for (let i = 0; i < 100; i++) {
    try {
      await json('/api/health')
    } catch {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
    if (i === 99) throw new Error('Daemon did not stop')
  }
  port = undefined
  await mise('unuse', '-g', '--no-prune', tool)
  await mise('uninstall', '--all', tool)
  for (const binary of installed.values()) assert.equal(existsSync(binary), false)
  await assert.rejects(() => mise('which', 'ghl'))
  assert.equal(readFileSync(statePath, 'utf8'), stored, 'Uninstall must preserve review data')
  report.complete = true
  record('uninstall removes selection and executables while preserving repository state')
} finally {
  if (port) {
    try {
      const health: Health = await (
        await fetch(`http://127.0.0.1:${port}/api/health`, {
          headers: { Connection: 'close' },
          signal: AbortSignal.timeout(2000),
        })
      ).json()
      await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
        method: 'POST',
        headers: { Connection: 'close' },
        body: JSON.stringify({ instance: health.instance }),
        signal: AbortSignal.timeout(2000),
      })
      // Wait before removing the executable and fixture paths used by the daemon.
      await new Promise((resolve) => setTimeout(resolve, 500))
    } catch {
      /* The daemon may already be stopped. */
    }
  }
  await mirror?.close()
  rmSync(temporary, { recursive: true, force: true })
}
