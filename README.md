# ghl

Review the PR you are about to open, without opening it.

A local git diff viewer with a GitHub-like UI, for the moment when the change is written
but pushing it just to look at it is not worth the trip.

The default runtime is Go with the React interface embedded. The initial supported
release platform is **macOS on Apple Silicon (ARM64)**. Git and a browser are the
only runtime prerequisites. See the [installation guide](./docs/go-installation.md).

A [Wails desktop prototype](./poc/wails/README.md) opens the same review UI in a
single reusable native window: `task wails:run -- --repo .`. It is optional and
keeps the installed browser CLI separate.

| key       | action                           |
| --------- | -------------------------------- |
| `j` / `k` | next / previous file             |
| `v`       | mark the current file as viewed  |
| `c`       | comment the selected lines       |
| `b`       | change the base                  |
| `t`       | change the revision under review |
| `l`       | show one commit, or all of them  |
| `r`       | refresh the diff                 |

The file tree uses coloured file-type icons and neutral names, with a coloured git status (added,
modified, deleted, renamed, untracked), and folds chains of single-child directories into
one row. Both panes are virtualised, so a 107-file diff keeps ~48 rows in the DOM. The diff
lists files in the tree's order, not the patch's — git sorts whole paths bytewise, so a file
at the root would otherwise come first on one side and last on the other, and `j`/`k` would
walk an order the eye is not following.

Lines can be commented, from the `+` in the gutter or with `c` on a selection. A comment is a
remark meant to be handed to an agent, so it is filed against the code rather than against the
comparison: it lives under the repository, keyed by path and by the text of the lines it was
written on, and follows its file when the base changes. The tree carries a `✎N` badge even
when the file is marked viewed.
Inline comments use compact cards. Click the chevron beside the line number to fold a comment
into a one-line preview; click again to expand it. The folded state survives scrolling and
reloads in the same tab. Copy and edit remain available while folded, and **View in diff**
expands the comment when revealing it.

When the lines a comment was written on stop reading the same, it says so and shows what they
used to say. Its own lines, not its file: an agent handed four remarks fixes one and leaves
three, so a per-file signal would fire every time and mean nothing. The flag is computed on
read and never stored, so putting the lines back clears it — and it is never a reason to delete
the comment on your behalf, since code can change without anyone having done what it asked.

The **Comments** button opens an overview of every comment in the repository, grouped by
file. **View in diff** reveals the commented lines, opening a folded file without clearing
its Viewed tick. Comments outside the current diff remain readable and editable in the
panel, with their original code available. The `…` menu offers Edit and Delete; editing
changes the text without replacing its original code anchor or comparison.

**Copy all** copies every comment in the overview as Markdown, including comments on viewed
files and files outside the current diff. Each comment also has its own copy button.
The export includes paths, line numbers, and the code as it reads now. Where current code
is unavailable, the original lines are included and explicitly labelled as historical.
A failed clipboard write is reported instead of displaying a successful copy.

`ghl comments` exports the comments belonging to the requested comparison, and `--json`
provides structured output. The CLI and UI share the Markdown formatter; the UI's overview
has a wider scope because it also includes comments outside that comparison. Neither adds
an instruction to apply the remarks: that is the prompt of whoever pastes them.

On narrow screens, **Files** opens the file tree over the diff and closes after selecting
a file. The diff uses unified mode, while the comments panel fills the screen.

The theme selector groups ten palettes into **Dark** and **Light**:

- **Dark:** GitHub Dark dimmed (the default), GitHub Dark, VS Code Dark+, JetBrains Darcula,
  Catppuccin Frappé, and Catppuccin Mocha.
- **Light:** GitHub Light, VS Code Light+, Catppuccin Latte, and Solarized Light.

It updates the interface and syntax highlighting together, keeps the coloured file-type
icons and reading position, and remembers the choice in this browser. Darcula uses a
Shiki adaptation of JetBrains' palette; the other syntax themes are bundled with Shiki.

Press `l` to read the branch one commit at a time. The picker lists what the range holds,
newest first, and picking one shows that commit's **own** diff — what `git show` shows, not
everything since the base. The base stays on screen because it decides which commits are
offered, but it does not enter the patch. Merges are listed too, badged, and read against
their first parent. A sha that no longer resolves — rebased away, amended — falls back to
the whole range and says so, rather than showing the branch under a commit's name.

Image changes have visual previews: additions show the new image, modifications show
**Before / After** side by side, and deletions show the old image. PNG, JPEG, GIF, WebP,
AVIF, SVG, ICO and BMP are supported, with dimensions, file sizes and a checkerboard for
transparency. Previews follow the selected revision and the Working tree / Untracked
controls, and fold when marked viewed. Images over 20 MB or that cannot be decoded show
an explanation instead of a preview.
Click an image to enlarge it in an overlay; close it with Escape, the close button or a
click on the background.

Ticks are keyed on the commit, so a file read there is not counted as read of the branch.
And since a commit's diff cannot change, a tick set on one never clears itself — unlike the
branch view, where the next commit unticks the file it touched.

A viewed file folds shut and is ticked in the tree, as on GitHub — it keeps its place in the
list, so marking one never moves you, and clicking any row takes you to that file whether it
is folded or not. The state lives in `.git/ghl/state.json` and is keyed by revision range, so
a file marked against one base is not marked against another. Each tick stores the hash of
that file's diff section: if the file changes, its tick clears on its own.

## Usage

```bash
mise use -g github:vmaerten/ghl@0.1.0 # install the first stable release
# Requires a published archive; source installation: pnpm install && task install

ghl                    # open the current repo's virtual PR in the browser
ghl origin/some-branch # review another revision, without checking it out
ghl --print            # summary on stdout, no server
ghl --base main        # compare against an explicit revision
ghl --port 8080        # listen somewhere else (or set $GHL_PORT)
ghl --no-daemon        # serve from this process and stay in the foreground

ghl comments           # the review's comments as markdown, on stdout
ghl comments --json    # the same, to parse
ghl comments feature   # the comments on another revision's review
```

One process serves every repository you point it at. The first `ghl` starts it in the
background; every one after that hands it a repository and **returns**, so the tab outlives
the terminal that opened it. It stops on its own after 30 minutes with no tab watching
(`--idle`, `0` to never stop), and a `ghl` from a newer install replaces it, carrying the
repositories it was serving across so their tabs keep working.

The URL is the same every time: **`http://ghl.localhost:7777/r/<repoId>`**, so it can be
bookmarked and the tab recognised among a dozen others. What you asked for on the command
line rides in that address rather than in the server — `ghl origin/some-branch --base main`
opens `…/r/<repoId>?target=origin/some-branch&base=main` — so the page can drop a parameter
to mean "I have chosen the default" and nothing answers in its place. Bare, the address is
the one to bookmark: it reviews the checkout against the base `ghl` resolves on its own. `*.localhost` is loopback by spec —
no `/etc/hosts` entry, no dnsmasq — but the name is checked at startup and falls back to
`127.0.0.1` rather than print a URL that would not connect. The `repoId` is derived from the
repository path, so each checkout keeps its own address. Concurrent launches reuse
the daemon on the selected port; a conflicting listener reports an error instead
of silently changing the URL.

A fixed port makes the address guessable, so the server answers only to `ghl.localhost`,
`localhost` and the loopback addresses: a page that re-resolved its own domain to
`127.0.0.1` would otherwise be same-origin with the code being served.

For a source installation, run `pnpm install && task install`. Task builds one
Go executable and atomically replaces `~/.local/bin/ghl`. Add that directory to
PATH. `task uninstall` removes this executable and preserves repository state.
GitHub Releases and mise are the consumer distribution channels; source builds
also require Go, Node, pnpm and Task.

`task dev` (or `pnpm dev`) starts Vite and Air together: React/CSS changes refresh
in the browser and Go changes rebuild and restart the backend. The frontend
listens on :5180 and the API on :5181. Use
`task dev REPO=/path/to/repository BASE=main` to review another checkout. See the
[development guide](./go/README.md#development) for prerequisites and build/test tasks.

The Node fallback remains maintained during the 0.1.x transition.
`pnpm install:node` installs it as `ghl-node`, without replacing Go;
`pnpm uninstall:node` removes that fallback. See the
[migration guide](./docs/go-migration.md) before switching an older installation.

`ghl` with no argument shows **everything that is not in the base**, committed or not:
the diff from `merge-base(base, HEAD)` down to the working tree.

The **Working tree** checkbox in the topbar takes that last part back out. Cleared, the diff
stops at HEAD — the branch as its pull request will show it, without checking anything else
out. Staged and unstaged go together, since both are uncommitted, and the untracked files
leave with them whatever their own checkbox says. The checkbox is disabled while a ref or a single
commit is under review: there is no working tree in either, and both already say so.

Files git does not track yet are listed but kept out of the diff, and the **Untracked** checkbox
brings them in. It is off by default because one repository here has 2 modified files against
446 untracked ones — real, unignored, and enough to drown the change under review. It carries
the count, which is the whole reason for that default and reads both ways: unchecked it says
what is being kept out, checked it says what was taken in. A file it brings in is a file the
diff counts and a file you can comment on, like any other.

`ghl comments` takes them in unconditionally: the page has a scope control and a reader who chose
what is on screen, the export has neither, and its scope is the review rather than the view.

The state lives in the URL and nowhere else. A remembered preference would answer over what
you last chose in the page, which is the one thing this tool must never do about what a diff
contains.

## How the base is chosen

Git records no parent for a branch, so `ghl` resolves one, most trustworthy source first:

1. `branch.<name>.ghlBase` in `.git/config` — your remembered choice
2. the `gh stack` chain, when the branch is part of one — not a guess, it is written down
3. the stacked-branch heuristic — the ref whose merge-base is closest to HEAD, the trunk
   winning ties (a sibling branch is not a parent), including the tie a branch with no
   commits of its own makes with it
4. `origin/HEAD`, under its local name
5. the first existing of `main`, `master`, `develop`, then their `origin/` counterparts

The chosen base and how it was obtained are always reported: a wrong base silently produces
a misleading diff.

Press `b` (or click the base) to pick another one: the list is searchable, ordered by
commit date, and the choice is written to `.git/config` for that branch. Both pickers list
local branches only — `origin/<name>` is the same branch under another name, and offering
both doubled every entry.

Press `t` to review a different revision altogether — a colleague's branch, say — without
checking it out. The revision lives in the URL, so a reload stays on it, and anything git
resolves works there: `ghl origin/some-branch`, or `?target=origin/some-branch` by hand.
Reviewing a ref excludes uncommitted work, which belongs to the working tree and not to
that ref; the UI says so.

## Stacked branches

Git records no parent, but [`gh stack`](https://github.com/github/gh-stack) does: it keeps
the whole chain in `.git/gh-stack`. When the branch under review is part of one, the topbar
shows it — `main → auth → api → ui` — and each layer is diffed against the one below, so
what you read is what its pull request will show. Click any layer to move to it. The file is
read straight off disk, so this needs neither the network nor `gh` itself.

Merged layers stay in the chain: their pull request number is still there, but a layer whose
branch is gone is struck through and the one above it falls through to the next live layer.
Each layer keeps its own viewed ticks, since those are keyed by the revision range.

## Go runtime

The production Go entry point embeds React and provides text review
with optional untracked files and image previews, comments, Viewed, context expansion, automatic bases,
stacks, revision/commit selection and a shared background daemon with stable
repository URLs. The same UI and version-1 state are shared with the explicit
Node fallback.

```bash
task build
./go/dist/ghl --version
./go/dist/ghl --repo /path/to/repo --base main
task test
```

It shares version-1 `.git/ghl/state.json` with the updated Node runtime, including
a cross-process lock. Stop older Node processes before switching; prototype and
PoC data stay separate unless explicitly imported. See the [Go runtime guide](./go/README.md)
and [industrialization project](https://github.com/vmaerten/ghl/issues/97).
The [release guide](./docs/go-releases.md) covers verified macOS ARM64 archives
and manual publication from a validated version tag.
GitHub Actions is disabled; verification runs locally.
The [acceptance guide](./docs/go-validation.md) covers the full release gate
and production runtime measurements.
The [mise installation guide](./docs/go-installation.md) covers PATH activation,
version pinning, upgrades and rollback. The
[migration guide](./docs/go-migration.md) covers existing Node installations.

## Go proof of concept

A separate Go executable embeds the React UI for evaluating backend cost and
single-file distribution. It requires Git and a browser at runtime; Go ≥ 1.24,
Node, pnpm and Task v3 are build tools.

```bash
task poc:build
./poc/go/dist/ghl-go-poc --repo /path/to/repo --base main
task poc:test
pnpm poc:go:bench
```

The PoC reviews the checkout, including staged and unstaged work, with comments,
Viewed and context expansion. Its state is isolated in `.git/ghl-go-poc/state.json`.
It omits image previews, untracked files, stacks, revision pickers and the shared
daemon. See [scope, validation and measurements](./docs/go-poc.md).

## Tests

```bash
task test                  # Go race, parity, lifecycle and browser checks
task test:install          # local installation and explicit Node fallback
pnpm test:node             # complete Node reference suite
node test/run.ts --go tree  # one Go browser suite after task build
pnpm test:node lifecycle   # Node shared process, without starting a browser
pnpm test:node images      # Node image API and previews
```

`lifecycle` drives real `ghl` processes — cold start, a second repository joining, a newer
build taking over, two starts racing for the port, the idle stop, the Host allowlist. It
runs against a copy of `bin/` and `src/` in a temp directory, on a port picked free at the
last moment, so it never fights the `ghl` you have running on 7777.

`state`, `refs`, `commits` and `worktree` need no browser either, and build their own
repositories: what they ask has no answer in the shared fixture — a remote, a merge, a root
commit which no base can bring into range, a checkout dirty in three different ways.

The rest drive a headless Chrome over the real UI — `CHROME_PATH` overrides where it
is found. Each run builds a throwaway git repository in a temp directory with a
known diff (one file of each git status, a chain of single-child directories,
enough rows to force both panes to virtualise) and serves that. Nothing touches
a real repository, and nothing depends on which branch happens to be checked
out — an earlier version did both, and broke when the branch moved.

`task test` builds both the Go executable and the Node reference UI before checking
parity. `pnpm test:node` builds `web-dist/` before running the reference suite;
testing without rebuilding would silently test the previous interface.

## Layout

```
go/cmd/ghl/     default CLI with embedded React assets
go/internal/app/ Go backend, CLI, state and daemon
Taskfile.yml    native build, dev, installation and validation tasks
bin/ghl.ts       Node reference CLI — reads the current directory,
                 and the shared process it starts in the background
src/git.ts       git layer, every call through `git -C <repoPath>`
src/revision.ts  base resolution and patch construction
src/server.ts    HTTP server, routes namespaced by repo
src/state.ts     the viewed state, in .git/ghl/state.json
src/version.ts   what this runtime is, so a stale instance is replaced
src/types.ts     the shapes that cross the HTTP boundary
web/src/*.tsx    the UI, importing those same shapes
web/src/fileOrder.ts  the tree's file order, which the diff list follows
scripts/install.ts  installs the explicit ghl-node fallback
```

The Node reference backend runs TypeScript unbuilt: Node strips the types
itself, which is why relative imports name the real `.ts` file and why `engines`
asks for Node 24 — the first LTS with that on by default.
