# ghl

Review the PR you are about to open, without opening it.

A local git diff viewer with a GitHub-like UI, for the moment when the change is written
but pushing it just to look at it is not worth the trip.

**Status:** V1 complete — steps 1–5 of [PLAN.md](./PLAN.md).

| key | action |
|-----|--------|
| `j` / `k` | next / previous file |
| `v` | mark the current file as viewed |
| `c` | comment the selected lines |
| `b` | change the base |
| `t` | change the revision under review |
| `l` | show one commit, or all of them |
| `r` | refresh the diff |
| `o` | open the repository picker |

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

The theme selector offers **GitHub Dark dimmed** (the default), **Catppuccin Frappé**, and
**GitHub Dark**. It updates the interface and syntax highlighting together, keeps the
coloured file-type icons, and remembers the choice in this browser.

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
pnpm install && pnpm install:local   # once: builds the UI and installs the command

ghl                    # open the current repo's virtual PR in the browser
ghl origin/some-branch # review another revision, without checking it out
ghl --print            # summary on stdout, no server
ghl --base main        # compare against an explicit revision
ghl --port 8080        # listen somewhere else (or set $GHL_PORT)
ghl --no-daemon        # serve from this process and stay in the foreground
ghl --browse           # open the local repository catalogue from any folder
ghl --root ~/dev --browse # remember a discovery root and browse its projects
ghl --root ~/work --root ~/personal --no-open # add several roots

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
repository path, so each checkout keeps its own address; a second `ghl` running at the same
time takes the next free port.

Click the repository name, or press `o`, to open another repository. The picker lists each
repository once and opens its main checkout. Search matches repository names and paths;
Enter opens the first match. Arrow keys move through the choices, and Escape closes the
picker and returns focus. The same list fills the screen on mobile. Choose the branch to
review within the review; branches used by linked worktrees are available there too.
Opening a review never creates a worktree or checks out a branch.
Click the star beside a repository to add or remove it from favorites. Favorites appear
first and are saved with your discovery settings, surviving restarts and **Clear & rescan**.

Outside a Git repository, `ghl` opens the catalogue at `/`. **Manage roots** adds and removes
folders, accepts `~/…`, and edits the excluded directory names. `--root <path>` adds a root
permanently and is repeatable; relative CLI paths are resolved from the current directory.
`--browse` explicitly opens the catalogue. `comments`, `--print`, revisions and `--base`
still require a repository; `--browse` cannot be combined with them, and `--root` cannot be
combined with `comments` or `--print`.

Discovery starts after the server begins listening, with cached results available immediately.
Opening the picker refreshes a catalogue older than 30 seconds; **Rescan** forces a scan.
**Clear & rescan** rebuilds the catalogue from your roots and exclusions, forgetting cached
entries (including previously opened repositories). Repository files, comments, drafts and
open reviews are preserved.
There is no recursive watcher or permanent scan timer. The page polls scan progress only
while the catalogue is visible and a scan is running. Git status is requested for the listed
main checkouts and cached for ten seconds; it distinguishes modified files, untracked files and
conflicts. A failed status query is never labelled clean.

The scanner includes nested repositories, submodules and ordinary hidden folders. Linked
checkout directories and their descendants are skipped, including stale worktree pointers.
By default it skips `.git`, `node_modules`, `.venv`, `.cache`, `dist`, `build`, `.terraform` and
`.terragrunt-cache`; `.git` is always skipped. Existing discovery settings also gain the
Terraform and Terragrunt exclusions. You can edit these in **Manage roots**.
It does not follow symlinks encountered below a root, but an explicitly configured symlink
root is resolved to its real path. Worktrees sharing a common Git directory are grouped;
independent clones remain separate. Linked worktrees are not separate picker destinations.
Bare repositories are shown without an open action because they have no main checkout.
Existing worktree review URLs and launching `ghl` from a worktree still work.
Partial scan errors appear in an expandable summary.
Stale `.git` files report the missing Git metadata path; a temporarily
unavailable root does not erase its known projects. Opening a destination validates it again.

Discovery configuration lives in `$XDG_CONFIG_HOME/ghl/discovery.json` (default
`~/.config/ghl/discovery.json`), and the catalogue in `$XDG_CACHE_HOME/ghl/catalog.json`
(default `~/.cache/ghl/catalog.json`). Both are versioned and written atomically, outside the
installation directory. Removing a root removes its discovery contribution; reviews opened
explicitly remain available. Cached destinations can be opened again after a daemon restart.

Within one browser tab, switching repositories restores the last review URL, diff layout,
reading position and drafts from `sessionStorage`. Reloads preserve that session too; an
explicit URL always chooses its own comparison. Drafts from the diff and Comments panel are
isolated by checkout and comparison. If their file changed, the text appears under
**Recovered drafts**, where it can be selected for copying or discarded. Switching waits for
pending comments, deletions, Viewed updates and remembered-base writes. Failed writes offer
a retry, and unavailable browser storage blocks switching rather than losing draft text.
Saved comments and Viewed state keep their existing Git storage; no migration is needed.

A fixed port makes the address guessable, so the server answers only to `ghl.localhost`,
`localhost` and the loopback addresses: a page that re-resolved its own domain to
`127.0.0.1` would otherwise be same-origin with the code being served.

`pnpm install:local` copies `bin/`, `src/` and `web-dist/` into
`~/.local/share/ghl` and links `~/.local/bin/ghl` at that copy. A symlink straight
into the checkout would have been shorter, but it keeps the command tied to the
working copy: move it, delete it, or check out a branch mid-rewrite, and the
command follows. The copy is frozen instead — **re-run `pnpm install:local` after
pulling**, and `pnpm uninstall:local` to remove both. Nothing else is installed:
the server imports nothing outside `node:`, so the command has no dependencies at
all — the five in `dependencies` build the front end and end up inside
`web-dist/`.

To iterate on the UI, run `ghl --no-open` in a repository and `pnpm dev` here: Vite
serves the front end on :5180 and forwards data calls to :7777, which is where `ghl`
already is. That runs against the checkout, not the installed copy.

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

## Tests

```bash
pnpm test            # all of them
pnpm test tree       # one suite: tree, resize, viewed, pickers, scroll, rename, order,
                     # stack, commits, worktree, untracked, review-panel
pnpm test lifecycle  # the shared process, without starting a browser
pnpm test images     # image API and previews, using a dedicated fixture and Chrome
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

`pnpm test` builds the UI first on purpose: `web-dist/` is what the server
serves, so testing without rebuilding silently tests the previous version.

## Layout

```
bin/ghl.ts       CLI — the only place that reads the current directory,
                 and the shared process it starts in the background
src/git.ts       git layer, every call through `git -C <repoPath>`
src/revision.ts  base resolution and patch construction
src/server.ts    HTTP server, routes namespaced by repo
src/state.ts     the viewed state, in .git/ghl/state.json
src/version.ts   what this runtime is, so a stale instance is replaced
src/types.ts     the shapes that cross the HTTP boundary
web/src/*.tsx    the UI, importing those same shapes
web/src/fileOrder.ts  the tree's file order, which the diff list follows
scripts/install.ts  copies the runtime out of the checkout
```

TypeScript throughout, and the server side runs unbuilt: Node strips the types
itself, which is why relative imports name the real `.ts` file and why `engines`
asks for Node 24 — the first LTS with that on by default.
