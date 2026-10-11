import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

export interface ReleaseAsset {
  name: string
  browser_download_url: string
  url: string
  digest: string | null
}

export interface Release {
  tag_name: string
  draft: boolean
  prerelease: boolean
  created_at: string
  assets: ReleaseAsset[]
}

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** Real mise client/backend, local release API; no tags or releases are created. */
export async function miseReleaseFixture(
  directory: string,
  archive: string,
  desktopArchive: string,
) {
  const extracted = join(directory, 'candidate')
  mkdirSync(extracted)
  execFileSync('tar', ['-xzf', archive, '-C', extracted])
  const desktopBytes = readFileSync(desktopArchive)
  const assets = new Map<string, Buffer>()
  const releases: Release[] = []
  const requested: string[] = []
  let available = ['v1.0.0']
  const add = (version: string, previous = false, corrupt = false) => {
    const contents = join(directory, version)
    mkdirSync(contents)
    for (const name of ['ghl', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'])
      copyFileSync(join(extracted, name), join(contents, name))
    // Synthetic predecessor, as in goDaemon.ts: distinct executable identity,
    // same production build metadata. This is not a historical release test.
    if (previous) appendFileSync(join(contents, 'ghl'), '\nprevious mise fixture\n')
    const name = `ghl_${version}_darwin_arm64.tar.gz`
    const output = join(directory, name)
    execFileSync('tar', [
      '-czf',
      output,
      '-C',
      contents,
      'ghl',
      'LICENSE',
      'THIRD_PARTY_NOTICES.txt',
    ])
    const bytes = readFileSync(output)
    const desktopName = `ghl-desktop_${version}_darwin_arm64.zip`
    const digest = corrupt ? '0'.repeat(64) : sha256(bytes)
    const release: Release = {
      tag_name: `v${version}`,
      draft: false,
      prerelease: version.includes('-'),
      created_at: '2026-09-01T00:00:00Z',
      assets: [],
    }
    for (const [filename, payload] of [
      [desktopName, desktopBytes],
      [name, bytes],
      [
        'checksums.txt',
        Buffer.from(`${sha256(desktopBytes)}  ${desktopName}\n${digest}  ${name}\n`),
      ],
    ] as const) {
      const download = `/vmaerten/ghl/releases/download/v${version}/${filename}`
      const api = `/repos/vmaerten/ghl/releases/assets/${assets.size + 1}`
      assets.set(download, payload)
      assets.set(api, payload)
      release.assets.push({
        name: filename,
        browser_download_url: `https://github.com${download}`,
        url: `https://api.github.com${api}`,
        // Exercise the published checksum file fallback for the predecessor.
        digest: previous ? null : `sha256:${filename === name ? digest : sha256(payload)}`,
      })
    }
    releases.push(release)
  }
  add('1.0.0', true)
  add('1.0.1')
  add('1.1.0-rc.1')
  add('1.0.2', false, true)
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
    requested.push(path)
    const payload = assets.get(path)
    if (payload) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(payload)
      return
    }
    let result: unknown
    if (path === '/repos/vmaerten/ghl/releases')
      result = available.map((tag) => releases.find((release) => release.tag_name === tag))
    if (path === '/repos/vmaerten/ghl/releases/latest')
      result = releases.find(
        (release) => release.tag_name === available.find((tag) => !tag.includes('-')),
      )
    if (path.startsWith('/repos/vmaerten/ghl/releases/tags/'))
      result = releases.find(
        (release) => release.tag_name === decodeURIComponent(path.split('/').at(-1) ?? ''),
      )
    response.writeHead(result ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify(result ?? { message: 'Not Found' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requested,
    publishNext: () => {
      available = ['v1.1.0-rc.1', 'v1.0.1', 'v1.0.0']
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}
