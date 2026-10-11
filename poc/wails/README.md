# Usable Wails desktop prototype

This prototype answers a daily-use question: can `ghl` keep one dedicated review
window while preserving the existing Go backend and React interface? It lives
on `poc/wails-desktop`, separately from the desktop-envelope benchmark and the
default browser CLI. It currently targets macOS on Apple Silicon.

## Run

From the repository root, with pnpm dependencies installed, Go >= 1.25, Task v3
and Xcode Command Line Tools:

```bash
task wails:run -- --repo .
task wails:run -- --repo /path/to/another/repository --base main
```

The task builds an embedded React release and a locally signed application in
`.task/wails/ghl Prototype.app`. The terminal returns after opening the window.
Later launches switch the existing window to the requested repository/selection
and bring it back from a minimised state. Repeating the same selection focuses
the window without reloading its draft or scrolling position.

For daily use, install a separate command:

```bash
task wails:install
ghl-desktop                    # current repository, automatically resolved base
ghl-desktop --base main
ghl-desktop feature --repo ../another-repository --base main
ghl-desktop --help
```

Installation creates a symlink in `~/.local/bin` pointing to the local bundle;
that directory must be on PATH. `BIN_DIR` overrides the command directory.
Keep the bundle at its build location while using that link. The normal `ghl`
installation remains the browser version. `task wails:uninstall` removes only
the prototype symlink.

The application menu supplies **File → Open repository** (`Cmd+O`), native Edit
commands, reload (`Cmd+R`) and quit (`Cmd+Q`). Closing the window quits the app.
Git and macOS system WebKit are the runtime requirements; consumers of a copied
bundle need no Node, pnpm, Task or Go. No Caddy, DNS or proxy setup is required.

## What is preserved

The current React interface keeps its files/tree, unified/split diffs, context
expansion, comments, Viewed, themes, search, revision selectors and shortcuts.
Markdown/file-name copy uses the native macOS clipboard through Wails instead
of browser permission prompts. Comments and Viewed use the existing version-1
`.git/ghl/state.json`, including worktree-specific Git directories. The prototype
does not import or create another review-state schema.

One Go process owns the native window and the review server. It binds a private
ephemeral loopback port, independently of the browser daemon on 7777, and stops
on window close, quit or a termination signal. Reopening another repository
registers it in that same runtime; there is no companion executable or separate
server process. A bad repository/ref reports an error while keeping the current
review. Selection failures occur in the window after the launcher has returned.

The Wails module depends on the production Go source through a local module
replacement. Its dependencies stay in this prototype module; the production
module retains its standard-library-only dependency set. The Wails asset
handler forwards requests to the owned runtime, translating only the private
document origin. The public runtime Host/Origin checks remain intact.

Wails v2 notifications contain arguments without the executable and report the
executable directory, rather than the terminal directory. The launcher resolves
relative paths and canonicalizes arguments before handing them to Wails. Review
URLs end in `/` so Wails injects its native runtime after every page navigation.

## Validation and limitations

```bash
task wails:test
task wails:smoke
# Verify a relocated bundle without Node/pnpm/Go in PATH, after building:
python3 poc/wails/smoke.py --standalone
```

Race tests exercise argument handling, caller-directory preservation, invalid
repos/refs, the shared in-process backend, comment persistence, shutdown and
the native/public origin boundary. The smoke test opens the real WebKit window
on two temporary repositories. It exercises context expansion, UI comment
creation/edit/deletion, Markdown copy checked against the OS clipboard, Viewed,
relative Unicode paths from another caller, reuse of the same process/window,
unminimising, switching back, shutdown and state restoration after restarting.
It writes `.task/wails/validation.json` and `.task/wails/smoke.log`.
The standalone mode copies the complete bundle outside the checkout and reruns
the same native checks with only the system tools/Git in PATH.

The optional `GHL_DESKTOP_PROBE` path is a local acceptance-test script injected
into the native document; it is unused in normal launches. Tests do not open
your personal Chrome or mutate a real repository. The clipboard check writes
fixture Markdown to the system clipboard.

This is a usable prototype, not a signed/notarised release or an updater. Builds
are manual/local, with no CI or publication. Native hot reload is not configured;
the existing `task dev` remains available for browser development. Quit the
prototype before rebuilding to load new embedded UI/server code. The envelope
benchmark's RAM measurements do not measure this in-process integration; no
memory saving is asserted here. Linux/Windows, native image interactions and
unsaved drafts across a repository change remain outside this validation.
