# ghl

Review the PR you are about to open, without opening it.

A local git diff viewer with a GitHub-like UI, for the moment when the change is written
but pushing it just to look at it is not worth the trip.

The runtime is Go with the React interface embedded. Release builds target macOS
(Apple Silicon and Intel) and Linux (ARM64 and x86-64). Git and a browser are
runtime prerequisites. The published v0.1.0 contains macOS ARM64 only; the added
platform archives require a subsequent release and their platform acceptance gate.
See the [installation guide](./docs/installation.md).

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
provides structured output. Shared golden fixtures keep Go and React exports aligned.
The UI overview also includes comments outside that comparison. Neither export adds
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
mise use -g github:vmaerten/ghl@X.Y.Z # select a published version with your platform archive
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

**Ignore whitespace**, beside Unified/Split, filters the diff with Git's
`--ignore-all-space` option. It ignores indentation, tabs/spaces and inline or trailing
spacing changes while keeping line breaks and other text changes. Files whose only
changes are whitespace disappear from the tree, and file/line counts follow the filtered
diff. Renames and other file metadata changes remain visible.

The setting is off by default and lives in `w=1` in the URL, so reloading or picking
another revision keeps it. Viewed ticks are separate for the full and filtered modes;
returning to either mode restores its own ticks. Comments keep their original source
line numbers and anchors. Comments on hidden files remain available in **Comments**;
turn the setting off to see those files in the diff again.

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
repository URLs. Go is the only supported backend and CLI runtime.

```bash
task build
./go/dist/ghl --version
./go/dist/ghl --repo /path/to/repo --base main
task test
```

It preserves existing version-1 `.git/ghl/state.json`, including a cross-process
lock. Stop legacy Node daemons before switching; prototype and
PoC data stay separate unless explicitly imported. See the [Go runtime guide](./go/README.md)
and [industrialization project](https://github.com/vmaerten/ghl/issues/97).
The [release guide](./docs/releases.md) covers verified macOS/Linux archives
and manual publication from a validated version tag.
GitHub Actions is disabled; verification runs locally.
The [acceptance guide](./docs/validation.md) covers the full release gate
and production runtime measurements.
The [mise installation guide](./docs/installation.md) covers PATH activation,
version pinning, upgrades and rollback. The
[migration guide](./docs/migration.md) covers existing Node installations.

## Go proof of concept

A separate Go executable embeds the React UI for evaluating backend cost and
single-file distribution. It requires Git and a browser at runtime; Go ≥ 1.24,
Node, pnpm and Task v3 are build tools.

```bash
task poc:build
./poc/go/dist/ghl-go-poc --repo /path/to/repo --base main
task poc:test
```

The PoC reviews the checkout, including staged and unstaged work, with comments,
Viewed and context expansion. Its state is isolated in `.git/ghl-go-poc/state.json`.
It omits image previews, untracked files, stacks, revision pickers and the shared
daemon. See [scope, validation and measurements](./docs/go-poc.md).

## Tests

```bash
task test                     # Go race, CLI, lifecycle, API and browser checks
task test:install             # local installation and state preservation
node test/run.ts tree         # one browser suite after task build
node test/run.ts export       # formatter goldens, without a browser
task test:dev                 # React hot reload and Go restart
task bench                    # three-pass production Go measurements
```

`task test` builds the Go executable with its React assets, then tests it directly.
CLI, state, daemon, revision and image tests use temporary Git repositories.
State tests exercise concurrent Go processes, existing version-1 data, imports,
linked worktrees, corruption and unsupported schemas. Go race tests cover lock
cancellation and interrupted writes as well as the backend contracts.

The browser suites drive headless Chrome over the embedded UI, including context
expansion, comments, copy, Viewed, revision selection and restart. `CHROME_PATH`
overrides the pinned Chrome for Testing build. Fixtures and ephemeral ports keep
these tests separate from real repositories and the daemon on port 7777.
Node runs the TypeScript test drivers and frontend build tools; it does not serve
the application. Release acceptance repeats the checks against the executable
extracted from the archive, with only Git in its runtime PATH.

## Layout

```text
go/cmd/ghl/          CLI with embedded React assets
go/cmd/ghl-dev/      development server behind Vite and Air
go/internal/app/     backend, CLI, state and daemon
Taskfile.yml         build, dev, installation and validation tasks
src/types.ts         HTTP/JSON contracts consumed by React and test drivers
src/export.ts        browser Markdown/JSON formatter, aligned with Go goldens
web/src/             React interface
scripts/             build, release and benchmark tooling
test/                CLI/API and browser acceptance drivers
```

Node >= 24 and pnpm are development/build prerequisites for React and the
TypeScript test drivers. Consumers run the Go executable without them.
