# ghl Desktop

The desktop app opens the existing Go backend and React interface in one
reusable native window with review tabs. It coexists with the browser CLI and
currently targets macOS on Apple Silicon.

## Run

From the repository root, with pnpm dependencies installed, Go >= 1.25, Task v3
and Xcode Command Line Tools:

```bash
task desktop:run -- --repo .
task desktop:run -- --repo /path/to/another/repository --base main
```

The task builds an embedded React release and a locally signed application in
`.task/desktop/ghl Desktop.app`. The terminal returns after opening the window.
Later launches open or activate a review tab in the same window and bring it
back from a minimised state. A tab identifies a canonical checkout and its base/
target parameters; repeated commands activate an existing matching tab. Commit,
Working tree and Untracked selections belong to that tab's view and survive
switching. Repeating the active comparison does not reload its page.

The tab strip supplies selection, per-tab close buttons and **+** to open a
repository. Arrow keys, Home and End navigate the focused tab strip. `Cmd+W`
closes the active tab; closing the last tab leaves the welcome screen open.
Only the active React review is mounted. Inactive tabs retain their route and
label, not their parsed patch, DOM or a hidden review component. Each tab also
keeps a small, versioned view capture: unified/split mode, scroll position,
selected lines, inline composer text, comment-panel edits and context-expansion
coordinates. These survive switching and `Cmd+R`; `Ctrl+Tab` and
`Ctrl+Shift+Tab` cycle reviews. A user interaction cancels a pending scroll
restoration. Expansion replay checks each file's diff hash before applying it.
Captures remain in memory, with a 2 MiB per-tab limit. Closing a tab discards its
unsaved drafts; quitting the application discards all captures and the tab list.
Saved comments and Viewed remain durable in repository state.

For daily use, install a separate command:

```bash
task desktop:install
ghl-desktop                    # current repository, automatically resolved base
ghl-desktop --base main
ghl-desktop feature --repo ../another-repository --base main
ghl-desktop --help
```

Installation creates a symlink in `~/.local/bin` pointing to the local bundle;
that directory must be on PATH. `BIN_DIR` overrides the command directory.
Keep the bundle at its build location while using that link. The normal `ghl`
installation remains the browser version. `task desktop:uninstall` removes only
the desktop symlink.

The application menu supplies **File → Open repository** (`Cmd+O`), native Edit
commands, close tab (`Cmd+W`), reload (`Cmd+R`) and quit (`Cmd+Q`). Closing the window quits the app.
Git and macOS system WebKit are the runtime requirements; consumers of a copied
bundle need no Node, pnpm, Task or Go. No Caddy, DNS or proxy setup is required.

## Release archive

`task release:snapshot` invokes GoReleaser OSS to build the CLI and desktop,
package `ghl-desktop_<version>_darwin_arm64.zip` beside the CLI tarball and
checksum both in `go/dist/release/checksums.txt`. The ZIP contains the complete
`ghl Desktop.app`, the project MIT license and notices for the embedded frontend,
Go standard library and linked Go dependencies. Version and commit metadata
are checked against the release in both the bundle and native runtime.

Extract the ZIP and move `ghl Desktop.app` to `/Applications`. The archive has
free ad hoc signing, with no Apple notarisation. macOS may require a first-launch
exception after download. No automatic quarantine removal or desktop mise
installer is included in this layer. See the [release guide](../docs/go-releases.md)
for local verification and the tag-only release workflow. `task release:snapshot`
and `task desktop:build` do not publish; `task release` publishes verified archives.

## What is preserved

The current React interface keeps its files/tree, unified/split diffs, context
expansion, comments, Viewed, themes, search, revision selectors and shortcuts.
Markdown/file-name copy uses the native macOS clipboard through Wails instead
of browser permission prompts. Comments and Viewed use the existing version-1
`.git/ghl/state.json`, including worktree-specific Git directories. The desktop app
does not import or create another review-state schema.

One Go process owns the native window and the review server. It binds a private
ephemeral loopback port, independently of the browser daemon on 7777, and stops
on window close, quit or a termination signal. Reopening another repository
registers it in that same runtime; there is no companion executable or separate
server process. A bad repository/ref reports an error while keeping the current
review. Selection failures occur in the window after the launcher has returned.

The Wails module depends on the production Go source through a local module
replacement. Its dependencies stay in the desktop module; the production
module retains its standard-library-only dependency set. The Wails asset
handler forwards requests to the owned runtime, translating only the private
document origin. The public runtime Host/Origin checks remain intact.

Wails v2 notifications contain arguments without the executable and report the
executable directory, rather than the terminal directory. The launcher resolves
relative paths and canonicalizes arguments before handing them to Wails. Review
URLs end in `/` so Wails injects its native runtime after a page reload. Tab
navigation changes history and remounts the active review within the same native
document. A late remembered-base write from an unmounted review cannot replace
the next tab's URL. Revision numbers on native tab snapshots reject old replies.

## Validation and limitations

```bash
task desktop:test
task desktop:smoke
task desktop:memory
# Verify a relocated bundle without Node/pnpm/Go in PATH, after building:
python3 desktop/smoke.py --standalone
```

Race tests exercise argument handling, caller-directory preservation, invalid
repos/refs, the shared in-process backend, comment persistence, shutdown and
the native/public origin boundary, tab identity/closing, stale route updates and
concurrent opens. The smoke test opens the real WebKit window
on two temporary repositories. It exercises context expansion, UI comment
creation/edit/deletion, Markdown copy checked against the OS clipboard, Viewed,
relative Unicode paths from another caller, reuse of the same process/window,
unminimising, CLI deduplication, UI tab closing, one mounted review, the empty
welcome screen, shutdown and state restoration after restarting.
It writes `.task/desktop/validation.json` and `.task/desktop/smoke.log`.
The standalone mode copies the complete bundle outside the checkout and reruns
the same native checks with only the system tools/Git in PATH.

The native suite also checks restoration of an inline draft on expanded context,
scroll, panel editing, `Ctrl+Tab` and reload with drafts. Go tests check view-copy
isolation, version/size validation and late captures of closed tabs.

## Navigation memory sample

Three local runs on the Apple M5 Pro/macOS ARM64 machine each warm two tabs and
then switch ten times. Both temporary fixtures contain 100 text lines and two
modified lines. The [raw report](./tab-memory.json) keeps every process and
intermediate sample. This is deliberately smaller than the earlier 40,000-line
desktop-envelope workload.

The median physical footprint is **116.6 MiB after warming both tabs**, then
**143.6 MiB after ten switches**; paired growth is 25.7–27.9 MiB. There is always
one mounted review, and the two view captures total only **366 JSON bytes** in
this workload. Unmounting views does not make their allocations disappear
immediately: caches and collection timing still matter. These measurements do
not isolate the cause of the growth and do not establish a leak or a stable
long-term plateau. They do not promise a RAM saving on large diffs.

`desktop:memory` measures app descendants plus attributed WebKit/network/GPU tasks
with the same macOS footprint/Mach-time sampler as the envelope benchmark.
WindowServer and the driver are excluded. Run it without concurrent tests or
other benchmark loads; no forced garbage collection is requested.

The optional `GHL_DESKTOP_PROBE` path is a local acceptance-test script injected
into the native document; it is unused in normal launches. Its unique path also
isolates the test's instance lock, so fixture opens cannot join a user's running
desktop app. Tests do not open your personal Chrome or mutate a real repository. The clipboard check writes
fixture Markdown to the system clipboard.

During the local demonstration, a second invocation sent while the first window
was still bootstrapping was not registered; retrying after the window was ready
worked. Concurrent cold launches are not yet guaranteed by the Wails notification
path. Wait for the first window before sending another review. This is tracked
as a non-blocking follow-up in [#136](https://github.com/vmaerten/ghl/issues/136).

Builds are manual/local with ad hoc signing. Release signing, notarisation and
automatic updates are not configured. Stable release tags run a hosted macOS
job through `task release`; PRs and branch pushes do not run CI. Native hot
reload is not configured;
the existing `task dev` remains available for browser development. Quit the
desktop app before rebuilding to load new embedded UI/server code. The envelope
benchmark's RAM measurements do not measure this in-process integration; no
memory saving is asserted here. Linux/Windows, native image interactions and
restoration against a substantially changed diff remain outside this validation.
