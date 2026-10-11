# Go releases

The release pipeline builds the browser CLI and the desktop application, both
containing the production React UI. The first supported target is macOS ARM64.
The CLI requires Git and a browser; the desktop app requires Git and system WebKit. The project uses MIT; archives also contain the notices for
third-party components. The [mise installation guide](./go-installation.md)
documents the consumer path and its verification; the first published-release
check is still pending while no Go release exists.

## Local snapshot

Use [mise](https://mise.jdx.dev/) to install the exact tool versions in
`.mise.toml` and the download checksums in `mise.lock`:

```bash
mise install --locked
mise exec -- task release:check
mise exec -- task release:snapshot
```

This invokes GoReleaser OSS 2.18.2. Its before hooks install the frozen pnpm
lockfile, build Vite in `go` mode and generate dependency notices. GoReleaser
then compiles `go/cmd/ghl` with `CGO_ENABLED=0`, `-trimpath`, `-s -w`, and version,
full commit and date metadata. The date is the commit's UTC timestamp, which
keeps the version stamp and archive file times stable for repeated builds.
The before hooks also invoke `task desktop:build` with the release version,
commit and commit date. Task builds the Wails application natively with
`CGO_ENABLED=1`, embeds the `go-desktop` frontend, stamps bundle/runtime metadata
and applies free ad hoc signing. GoReleaser OSS packages the complete current
bundle as a `meta: true` ZIP; explicit destinations retain its `Contents/MacOS`
and `_CodeSignature` structure. Python collects notices from the actual linked
Go modules. The isolated Go PoC remains outside the release configuration.

Outputs live in `go/dist/release/`:

| File | Content |
| --- | --- |
| `ghl_<version>_darwin_arm64.tar.gz` | `ghl`, `LICENSE`, `THIRD_PARTY_NOTICES.txt` |
| `ghl-desktop_<version>_darwin_arm64.zip` | `ghl Desktop.app`, `LICENSE`, desktop `THIRD_PARTY_NOTICES.txt` |
| `checksums.txt` | SHA-256 of both archives, with their exact filenames |
| `metadata.json`, `artifacts.json` | Local GoReleaser build records; retained for validation |

Snapshot versions use `<latest-version>-next-<short-commit>`, or start at
`0.0.0` when no version tag exists. The archive naming pattern is predictable
for download clients and mise. React HTML, JavaScript, CSS and other generated
assets live inside the executable. Toolchains, node_modules and test browsers
are excluded from the archive.

`task release:snapshot` finishes by verifying checksums and the exact archive
contents. It extracts the executable into a temporary directory outside the
checkout and runs it with only Git in PATH. The checks cover `--version --json`,
health metadata, a production diff with untracked files, clean shutdown and
embedded HTML/JavaScript/CSS responses. Guard tests reject corrupt checksums,
wrong commit metadata, unexpected files, symlinks and invalid/stale version tags.
Desktop verification checks both checksums, rejects unexpected ZIP members,
links and missing executable permissions before extraction, and verifies bundle
metadata, licenses and the preserved ad hoc signature. It then tests the app
from the extracted ZIP outside the checkout, without Node/pnpm/Go in PATH, using
the 21 native fixture checks and verifying runtime release metadata. These tests
use an isolated instance and temporary repositories. Reports live in
`.task/desktop/validation.json`; the clipboard receives fixture Markdown.
`task desktop:test` includes the ZIP/checksum guard tests.
The validators run natively on macOS ARM64; they do not emulate other targets.

## Version tags and publication

Set `package.json` to the intended version and commit it with the release's
changes. Supported versions are `X.Y.Z` and `X.Y.Z-prerelease`, with a matching
`v`-prefixed tag on that commit. Before pushing a release tag, the same archives
can be built and verified locally from its clean checkout:

```bash
RELEASE_TAG=v0.1.0 mise exec -- task release:build
```

Replace the example with the checked-out tag. The command checks that it matches
`package.json` and points at HEAD. GoReleaser's non-snapshot mode requires a
clean checkout. Both local tasks leave publication disabled in the configuration.

The `Release` GitHub workflow runs only when a stable `vX.Y.Z` tag is pushed.
It has no branch, pull-request or manual-dispatch trigger. A single `macos-26`
ARM64 job checks out the event commit with all tags, installs the locked tools
through mise 2026.10.2 and invokes `task release`. Actions are pinned by commit;
only the release job receives `contents: write`. Its timeout is 20 minutes and
reruns of the same tag cannot cancel an ongoing release. The older workflow
remains disabled. On this private repository, the hosted job consumes the
account's included minutes and may incur charges beyond that allowance.

`task release` resolves `RELEASE_TAG` from the workflow, an explicit `TAG`, or
the exact tag on HEAD. It first runs the existing checked-tag build and complete
archive verification. It then checks the version/commit/tag and checksums again,
creates a draft with the two archives and checksum file, and publishes that
draft only after uploads succeed. An existing release is not overwritten; a
failed upload leaves a draft for inspection. GoReleaser's own publishing remains
disabled. There is no paid signing or notarisation service.

Test publication ordering and failures without GitHub writes:

```bash
task test:release
```

Before pushing a release tag, run the relevant
[local acceptance checks](./go-validation.md), including the extracted archive,
mise fixture and runtime measurements. Commit the intended `package.json`
version and release notes, then create and push its tag:

```bash
git tag v0.1.0
git push origin refs/tags/v0.1.0
```

The workflow builds and publishes that tag's exact commit. It does not create
or push tags. Replace the example with the release version. The automatic
trigger accepts stable tags only; prereleases are available through the local
Task path, which marks them as prereleases.

As an alternative to the hosted workflow, from a clean checkout whose tag
already exists on GitHub, an authenticated maintainer can run:

```bash
task release TAG=v0.1.0
```

Do not run the local publisher concurrently with the tag workflow. For a build
without publication, retain `RELEASE_TAG=v0.1.0 task release:build` or
`task release:snapshot`. To verify the published CLI installation afterward:

```bash
task release:mise:published VERSION=0.1.0
```

GitHub Releases and mise remain the consumer distribution channels. The hosted
workflow itself still needs its first real release-tag run; local validation
does not establish that the runner's native UI environment works identically.

The desktop ZIP can be downloaded and extracted manually; move `ghl Desktop.app`
to `/Applications` and launch it there. It has ad hoc signing only, with no paid
Apple certificate or notarisation. macOS may require an explicit first-launch
exception in Privacy & Security after a browser download. This packaging does
not remove download quarantine, supply an installer hook, or implement automatic
updates. A separate desktop mise installation remains to be implemented; the
current mise path installs the browser CLI. Its local fixture includes both
assets and checks that the existing CLI selector still chooses its tarball.

The last task downloads the actual published CLI assets through mise and exercises
the installed executable, state and lifecycle. Node is a local test driver
outside the consumer PATH; no Go/pnpm build is used to install the release. It
never deletes or replaces release assets. See the installation guide for the
first-release limitations on historical upgrades.

Go, Node, pnpm, Task and GoReleaser remain pinned in `.mise.toml`, with download
checksums in `mise.lock`.

## License material

`scripts/release-notices.ts` collects the installed production JavaScript
package closure, preserving complete LICENSE and NOTICE files, and the Go
standard-library license. It fails on missing material. Two npm packages need
special handling: `lru_map` puts its MIT text in its packaged README, while
`react-remove-scroll-bar@2.3.8` uses the reviewed immutable upstream license in
`scripts/licenses/`. Shiki's vendored Oniguruma, grammar and theme notices are
also preserved from their exact upstream versions. Their sources and version
guards are documented in `scripts/licenses/README.md`. An upgrade with missing
notices requires reviewing its license source before proceeding. Generated
notices stay in `.task/release/`.

`desktop/release.py notices` extends that material with LICENSE/NOTICE files
from the Go modules actually linked into the production desktop executable,
including Wails. Missing material or a linked version mismatch stops the build.
Its output is `.task/desktop/THIRD_PARTY_NOTICES.txt`, shipped only in the desktop
ZIP; the CLI archive retains its existing notices.

The JavaScript generator handles license material for the embedded frontend. The Taskfile
and GoReleaser call Go directly; there is no TypeScript build wrapper for Go.

References: [Archives](https://goreleaser.com/customization/package/archives/),
[Go builds](https://goreleaser.com/customization/builds/builders/go/),
[GoReleaser templates](https://goreleaser.com/customization/general/templates/).
