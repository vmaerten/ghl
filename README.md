# ghl

Review the PR you are about to open, without opening it.

A local git diff viewer with a GitHub-like UI, for the moment when the change is written
but pushing it just to look at it is not worth the trip.

**Status:** V1 complete — steps 1–5 of [PLAN.md](./PLAN.md).

| key | action |
|-----|--------|
| `j` / `k` | next / previous file |
| `/` | filter the tree by path (Enter keeps it, Escape drops it) |
| `v` | mark the current file as viewed |
| `c` | comment the selected lines |
| `b` | change the base |
| `t` | change the revision under review |
| `r` | refresh the diff |

The file tree shows an icon per file type, colours each row by its git status (added,
modified, deleted, renamed, untracked) and folds chains of single-child directories into
one row. Both panes are virtualised, so a 107-file diff keeps ~48 rows in the DOM. The diff
lists files in the tree's order, not the patch's — git sorts whole paths bytewise, so a file
at the root would otherwise come first on one side and last on the other, and `j`/`k` would
walk an order the eye is not following.

`/` filters that tree on the path — a plain case-insensitive substring, so a directory name
brings everything under it. While a filter is in force `j`/`k` walk what it kept, and the
diff pane keeps every file: the filter says where to look, it does not narrow the review.

Lines can be commented, from the `+` in the gutter or with `c` on a selection. A comment is a
remark meant to be handed to an agent, so it is filed against the code rather than against the
comparison: it lives under the repository, keyed by path and by the text of the lines it was
written on, and follows its file when the base changes. Since a viewed file folds shut and
takes its cards off screen, the tree carries a `✎N` badge — otherwise a remark on a file marked
read would have nowhere left to show.

When the lines a comment was written on stop reading the same, it says so and shows what they
used to say. Its own lines, not its file: an agent handed four remarks fixes one and leaves
three, so a per-file signal would fire every time and mean nothing. The flag is computed on
read and never stored, so putting the lines back clears it — and it is never a reason to delete
the comment on your behalf, since code can change without anyone having done what it asked.

The point of writing them down is getting them out again: `ghl comments` prints the review as
markdown, `--json` as something to parse, and the sidebar has a copy button for the same text.
Both go through one formatter, so the button and the command cannot disagree about a review.
Each remark comes with the lines it points at **as they read now**, because a path and a line
number alone go stale between taking the export and acting on it — but not the surrounding hunk,
which is what `git diff` is for. There is no "apply these" preamble: that is the prompt of
whoever pastes it.

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
ghl --untracked        # include untracked files in the diff
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
bookmarked and the tab recognised among a dozen others. `*.localhost` is loopback by spec —
no `/etc/hosts` entry, no dnsmasq — but the name is checked at startup and falls back to
`127.0.0.1` rather than print a URL that would not connect. The `repoId` is derived from the
repository path, so each checkout keeps its own address; a second `ghl` running at the same
time takes the next free port.

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

## How the base is chosen

Git records no parent for a branch, so `ghl` resolves one, most trustworthy source first:

1. `branch.<name>.ghlBase` in `.git/config` — your remembered choice
2. the `gh stack` chain, when the branch is part of one — not a guess, it is written down
3. the stacked-branch heuristic — the ref whose merge-base is closest to HEAD, the trunk
   winning ties (a sibling branch is not a parent)
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
pnpm test tree       # one suite: tree, resize, viewed, pickers, scroll, rename, order, stack
pnpm test lifecycle  # the shared process, without starting a browser
```

`lifecycle` drives real `ghl` processes — cold start, a second repository joining, a newer
build taking over, two starts racing for the port, the idle stop, the Host allowlist. It
runs against a copy of `bin/` and `src/` in a temp directory, on a port picked free at the
last moment, so it never fights the `ghl` you have running on 7777.

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
