# ghl

Review the PR you are about to open, without opening it.

A local git diff viewer with a GitHub-like UI, for the moment when the change is written
but pushing it just to look at it is not worth the trip.

**Status:** V1 complete — steps 1–5 of [PLAN.md](./PLAN.md).

| key | action |
|-----|--------|
| `j` / `k` | next / previous file |
| `v` | mark the current file as viewed |
| `b` | change the base |
| `t` | change the revision under review |
| `r` | refresh the diff |

The file tree shows an icon per file type, colours each row by its git status (added,
modified, deleted, renamed, untracked) and folds chains of single-child directories into
one row. Both panes are virtualised, so a 107-file diff keeps ~48 rows in the DOM.

Viewed files leave the diff and are ticked in the tree; click one to bring it back. The
state lives in `.git/ghl/state.json` and is keyed by revision range, so a file marked
against one base is not marked against another. Each tick stores the hash of that file's
diff section: if the file changes, its tick clears on its own.

Generated files are hidden the same way. Measured across 323 real branches, the largest
diffs are not large in code but in generated files — on one of them a `package-lock.json`
is 99.9% of the whole thing. Lockfiles, `__snapshots__/`, `dist/`, `vendor/`, minified
bundles and protobuf output are kept out of the diff pane by default, still listed in the
tree, marked `gen`, and one click away. The built-in list is deliberately narrow, because a
file wrongly hidden is a file you never learn to look for; `.gitattributes` has the last
word in both directions:

```gitattributes
src/api-types.ts     linguist-generated
dist/hand-written.ts -linguist-generated
```

## Usage

```bash
pnpm install && pnpm build   # once: builds the UI into web-dist/

ghl                    # open the current repo's virtual PR in the browser
ghl origin/some-branch # review another revision, without checking it out
ghl --print            # summary on stdout, no server
ghl --base main        # compare against an explicit revision
ghl --untracked        # include untracked files in the diff
```

To iterate on the UI, run `ghl --no-open --port 7777` in a repository and `pnpm dev`
here: Vite serves the front end on :5180 and forwards data calls to it.

`ghl` with no argument shows **everything that is not in the base**, committed or not:
the diff from `merge-base(base, HEAD)` down to the working tree.

## How the base is chosen

Git records no parent for a branch, so `ghl` resolves one, most trustworthy source first:

1. `branch.<name>.ghlBase` in `.git/config` — your remembered choice
2. the stacked-branch heuristic — the ref whose merge-base is closest to HEAD, the trunk
   winning ties (a sibling branch is not a parent)
3. `origin/HEAD`
4. the first existing of `origin/main`, `origin/master`, `origin/develop`, then their local
   counterparts

The chosen base and how it was obtained are always reported: a wrong base silently produces
a misleading diff.

Press `b` (or click the base) to pick another one: the list is searchable, ordered by
commit date, and the choice is written to `.git/config` for that branch.

Press `t` to review a different revision altogether — a colleague's branch, say — without
checking it out. The revision lives in the URL, so a reload stays on it. Reviewing a ref
excludes uncommitted work, which belongs to the working tree and not to that ref; the UI
says so.

## Tests

```bash
pnpm test          # all of them
pnpm test tree     # one suite: tree, resize, viewed, pickers, scroll, generated
```

They drive a headless Chrome over the real UI — `CHROME_PATH` overrides where it
is found. Each run builds a throwaway git repository in a temp directory with a
known diff (one file of each git status, a chain of single-child directories,
enough rows to force both panes to virtualise) and serves that. Nothing touches
a real repository, and nothing depends on which branch happens to be checked
out — an earlier version did both, and broke when the branch moved.

`pnpm test` builds the UI first on purpose: `web-dist/` is what the server
serves, so testing without rebuilding silently tests the previous version.

## Layout

```
bin/ghl.ts       CLI — the only place that reads the current directory
src/git.ts       git layer, every call through `git -C <repoPath>`
src/revision.ts  base resolution and patch construction
src/generated.ts which files a tool wrote, rules then `.gitattributes`
src/server.ts    HTTP server, routes namespaced by repo
src/types.ts     the shapes that cross the HTTP boundary
web/src/*.tsx    the UI, importing those same shapes
```

TypeScript throughout, and the server side runs unbuilt: Node strips the types
itself, which is why relative imports name the real `.ts` file and why `engines`
asks for Node 24 — the first LTS with that on by default.
