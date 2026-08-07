# ghl — local git diff viewer

Review the PR you are about to open, without opening it. GitHub-like UI (unified/split,
collapsing, file tree), locally, on any of ~39 active repositories.

## 1. What was measured (and what it changed)

The project was meant to be about performance. Measurement took that problem off the table.

**Real PR sizes** — 323 real branches (merge-base → branch) across pubstack, perso and oss:

| | files | lines |
|---|---|---|
| p50 | 2 | 36 |
| p90 | 12 | 1,071 |
| p99 | 91 | 11,841 |
| max | 218 | 36,858 |

The largest PRs are not large in code but in generated files: on one of them a
`package-lock.json` accounts for 99.9% of the diff.

**Rendering with `@pierre/diffs`** (headless Chrome, fixtures are real PRs). Content
rendering is asynchronous (worker pool + Shiki), so these numbers measure time to **DOM
stabilisation**, not to first frame — see "On the metric" below.

| scenario | parse | paint | DOM nodes | mem |
|---|---|---|---|---|
| 177 files / 36,289 lines, unified | 15 ms | 627 ms | 482 | 34 MB |
| 177 files / 36,289 lines, split | 14 ms | 637 ms | 482 | 34 MB |
| 218 files / 12,990 lines | 8.9 ms | 225 ms | 565 | 9 MB |
| 87 files / 13,182 lines | 8.5 ms | 214 ms | 510 | 11 MB |

The DOM does not grow with diff size (482 nodes for 36,289 lines, same as for 13,000):
the library is virtualised natively (`virtualDiffLayout`, `createWindowFromScrollPosition`,
`VirtualizedFileDiff`). **There is no virtualisation and no lazy loading to write.** The
worst real PR renders in ~640 ms — comfortable, though not free. The work lies elsewhere:
the git layer and the UX.

**Cost of collapsing** — decisive for the "viewed" state:

| files | expanded | all collapsed | penalty | DOM nodes |
|---|---|---|---|---|
| 2 | 367 ms | 500 ms | 1.4× | 490 → 128 ↓ |
| 87 | 214 ms | 1,042 ms | **4.9×** | 510 → 1,351 ↑ |
| 177 | 624 ms | 2,652 ms | **4.3×** | 482 → 1,349 ↑ |
| 218 | 217 ms | 472 ms | 2.2× | 565 → 1,339 ↑ |

Collapsing shortens each item, so more of them fit in the virtualisation window, so the
library mounts more of them. At 2 files the DOM drops as expected; from 87 on it triples
and plateaus around 1,350 (window saturated with headers). Not a library defect —
mechanical — but it dictates how "viewed" is implemented (see Decisions).

**On the metric**: an earlier campaign reported 26 ms / 192 nodes for the p99. That was
wrong. It sampled two `requestAnimationFrame`s after the React commit and therefore often
captured an empty skeleton — the `totalHeight > 0` guard did not help, since the
virtualiser knows the *estimated* height (from `unifiedLineCount`) before rendering
anything. Symptom: runs at `266, 343, 339, 28, 258` ms. After the fix (wait for DOM
stabilisation): `371, 365, 365, 371, 364`.

**Not measured**: scroll smoothness. The method used (a `requestAnimationFrame` loop under
`headless: shell`) returned 120 fps on every scenario to within 0.1 — an artefact, since
headless does no real compositing. Redo with CDP tracing if the need arises.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **One-shot CLI**, no daemon | A daemon saves 40–80 ms out of ~600 ms, for all of the lifecycle complexity |
| 2 | **Node end to end** | One parsing implementation (server and client), and the `./ssr` export stays reachable |
| 3 | Default = **virtual PR**: `merge-base(base, HEAD)` → working tree | "The PR I would open if I pushed right now" |
| 3b | Untracked files **listed but excluded** from the diff | Measured on prebid-server-proxy: 2 modified files against 446 untracked ones. `--untracked` opts in |
| 4 | Base **guessed, displayed, remembered** | A heuristic stays a heuristic: it must be visible and correctable |
| 8 | `cmdk` for the base picker, no design system | 79 KB headless, no provider, no theme competing with the one Shiki imposes. Mantine core is 8.6 MB and brings its own theming |
| 5 | **Manual** refresh (button + `R`) | `.git` watcher deferred; `.git` changes constantly, debouncing is a topic of its own |
| 6 | V1 = file tree + keyboard + persistent viewed | Context expansion and comments in V2 |
| 7 | A viewed file is **removed from the items**, never `collapsed: true` | Collapsing multiplies cost by 4–5 beyond 87 files (measured) |
| 9 | Generated files **hidden by default**, `.gitattributes` overriding | They are what makes the largest diffs large (99.9% of one of them). Same removal as 7, on the files that cost the most |

### Three disciplines to hold from the first line

They make a later move to a daemon nearly free (~150 lines) instead of a refactor:

1. **Explicit `repoPath` everywhere.** Never `process.cwd()` in the git layer. Enforced by
   routing every call through `git -C <repoPath>`; `bin/ghl.ts` reads the cwd once.
2. **State on disk**, never in memory alone.
3. **Namespaced routes** `/r/:repoId/...` from the start, even with a single repo served.

And a fourth, for the watcher: **every refresh goes through one `refresh()` function** that
refetches and replaces the items. Wiring a WebSocket to it later is ten lines.

## 3. Architecture

```
ghl (node bin, one-shot)
 │
 ├── revision resolution
 │     base   : branch.<name>.ghlBase → heuristic → origin/HEAD → main|master|develop
 │     target : working tree by default, or any ref (?target=)
 │              the base is guessed FOR the target, not for the checkout
 │
 ├── git diff --merge-base <base> → raw patch
 │
 ├── ephemeral HTTP server
 │     GET  /api/repos            → served repositories
 │     GET  /r/:repoId/api/diff   → patch + revision metadata
 │     POST /r/:repoId/api/base   → remember a base choice
 │     GET  /r/:repoId/api/state  → viewed state              (step 5)
 │     GET  /r/:repoId/api/file   → full contents             (V2, loadDiffFiles)
 │
 └── React front end
       parsePatchFiles(patch, cacheKey)  →  CodeViewItem[]
       <CodeView items options />         ← virtualised by the library
       <FileTree model />                 ← @pierre/trees, also virtualised
       j/k · viewed
```

### The file tree

`@pierre/trees` (same authors as `@pierre/diffs`, Apache-2.0). It brings row
virtualisation, single-child directory folding, per-extension icons and git-status
colouring — all of which we would otherwise have written. Three things it imposes:

- **Options are read once.** `useFileTree` builds the model on first render and ignores
  every later options object. Entries, decorations and handlers therefore reach the model
  imperatively (`resetPaths`, `setGitStatus`) or through refs.
- **One decoration per row, text or icon — not a node.** The viewed tick and the `+/−`
  counts share a single coloured string.
- **Shadow DOM.** `styles.css` does not reach the rows; they are themed through
  `--trees-*` custom properties, fed by `themeToTreeStyles(resolveTheme('github-dark'))`
  so both panes read the same resolved theme.

Directory ids carry a trailing slash (`src/`), and a folded chain is one node named after
its deepest segment (`web/src/`) — both matter when addressing rows by path.

### Base resolution

Most trustworthy source first:

1. `git config branch.<name>.ghlBase` — the user's remembered choice, authoritative.
2. "Stacked branch" heuristic: among candidate refs, the one whose merge-base sits closest
   to HEAD. **The trunk wins ties** — two sibling branches cut from the same commit produce
   the same distance as the trunk, and a sibling is not a parent. Verified on a fixture
   where `sister-c` shares `feature-a`'s fork point and still resolves to the trunk.
3. `origin/HEAD` — present on 64 of 86 repositories.
4. First existing among `origin/main`, `origin/master`, `origin/develop`, then the local
   `main`, `master`, `develop` (57 / 5 / 2 repos; hardcoding `main` would fail on 29, and
   some repos such as mrev and fuel-tracker have no remote at all).

Short-circuit: when HEAD *is* the trunk, guess nothing.

Covered: 86 of 86 repositories resolve a base.

### Viewed state

`.git/ghl/state.json` (inside `.git`, so never committed, and removed with the repo).
Key: `(base..target, path, content hash)` — if a file changes after being viewed, the tick
clears itself.

**A viewed file leaves the items array**, it is not switched to `collapsed: true`:

```js
const visible = items.filter((item) => !viewed.has(item.id))
// plus a collapsible "12 viewed files" entry that puts them back on demand
```

Measured: collapsing 177 files costs 2,652 ms against 624 ms expanded, and triples the DOM.
Collapsing saturates the virtualisation window with headers. Removing them keeps the list
short — which is also what we want visually.

Stale entries are filtered on read, not deleted on disk: if the file goes back to what it
was, the tick returns. The file only ever holds one hash per path per range.

Membership decides, not truthiness (`path in viewed`): a stored hash may legitimately be
null, and `Boolean(null)` would silently drop the tick.

## 4. Steps

1. **CLI + server skeleton.** ✅ Resolves the repo, serves `/r/:repoId/api/diff`, opens the
   browser. Raw output, no UI. Validated on 86/86 repositories.
2. **Base resolution.** ✅ Full cascade, `--base` override, persistence in `.git/config`.
3. **Rendering.** ✅ `CodeView` fed by `parsePatchFiles`, unified/split toggle, revision bar
   showing base → target and how the base was chosen. Verified against real PRs of 17 and
   107 files. Vite code-splits the Shiki grammars, so only the languages present in the
   diff are fetched.
4. **File tree + keyboard.** ✅ Sidebar tree with per-file counts (from `--numstat`) and
   single-child directory chains collapsed into one row, `j`/`k` to move between files,
   click to jump, `r` to refresh. Verified on a 107-file PR.
5. **Base picker.** ✅ Combobox anchored under the base button (`b` or click), searchable,
   refs ordered by commit date — Prebid.js carries 501 of them, so a plain list was never
   an option. Picking writes the choice to `.git/config` and reloads the diff.
6. **Reviewable target.** ✅ Any ref can be reviewed without checking it out, from the CLI
   (`ghl <ref>`), the `t` picker or `?target=`. Uncommitted work is excluded then, since it
   belongs to the working tree.
7. **Persistent viewed.** ✅ Checkbox in each file header (via `renderHeaderMetadata`),
   `v` on the active file, tick in the tree, `Reset`. A viewed file leaves the items array.
   State lives in `.git/ghl/state.json`, keyed by revision range, and each entry stores the
   hash of that file's diff section: change the file and its tick clears, while other files
   keep theirs.
8. **Generated files hidden.** ✅ Lockfiles, `__snapshots__/`, `dist/`, `vendor/`, minified
   bundles and protobuf output leave the items array exactly as viewed files do, and
   `.gitattributes` overrides the rules in both directions (`linguist-generated` to add,
   `-linguist-generated` to rescue). Still listed in the tree, marked `gen`, one click from
   coming back. The rule list is kept narrow on purpose: a file wrongly hidden is a file
   the reader never learns to look for.

## 5. Known traps

- **`CodeView` needs an explicit height.** It creates its own scroller; without
  `height: 100%` it measures 0 and mounts no items — silently, with no error.
- **`CodeView` must scroll itself — `overflowY: auto` goes on the component, not on a
  parent.** The `style` prop lands on its own scroller, and it recomputes the virtual
  window only from the element *it* scrolls. Scrolling an ancestor instead produces a
  particularly deceptive failure: the scrollbar moves, but the content freezes on the
  window rendered at load, and the sticky container drags that frozen block along so it
  still looks alive. Verify with `scratchpad/bench/test-scroll.mjs`, which compares which
  files are on screen at 0/25/50/75/98%. Counting visible characters is not enough — the
  frozen viewport returned the exact same count at four positions and looked healthy.
- **Collapsing saturates the virtualisation window.** Quantified in §1: beyond ~87 files,
  `collapsed: true` multiplies cost by 4–5. Hence decision 7. General corollary: **the
  dominant cost is the number of items mounted at once**, not diff size. Any feature that
  shortens items increases how many are on screen.
- **Patches are `isPartial`.** Context expansion needs an endpoint serving both full file
  versions, wired to `loadDiffFiles`. That is what puts it in V2.
- **Untracked files are noise.** 446 of them on prebid-server-proxy against 2 real changes.
  Excluded by default, `--untracked` to include.
- **Repositories are found mid-operation.** prebid-server-proxy sits in an unresolved merge
  (`UU` files). `repoState()` reports it; the UI must surface it rather than show a
  confusing diff.
- **Diff direction.** `difit <target> <base>` inverts the git convention and led us to
  wrongly conclude it had a bug. Base and target must be shown explicitly on screen.
- **`additionLines` / `deletionLines` are not counters.** They hold each side of the hunk,
  **context lines included**. Summing their lengths reported `+388 −377` on a diff that git
  counts as `+172 −161`. Line counts come from `git diff --numstat`, which also gives the
  per-file numbers the file tree needs.
- **A picker renders before its refs arrive.** The target picker shows "this checkout"
  immediately and fetches the refs after, so waiting on `.picker-item` returns while only
  that entry exists. A suite that typed into the gap selected the working tree whatever it
  typed, then asserted against the wrong revision — and passed, because the assertion only
  checked that *something* had changed.
- **`git diff --numstat` renames its own way.** Without `-z` a rename is one line reading
  `0\t0\told => new`, and that arrow is a path nothing else agrees with — not the patch,
  not `--name-status`. The status lookup missed, so every renamed file showed as *modified*
  with no line counts. Found by the fixture, not by the real repositories: the assertion
  there only required more than one distinct status, and `renamed` never appeared.
- **Library options**: `diffStyle: 'unified' | 'split'` (not `layout`), `disableLineNumbers`
  (not `lineNumbers`). Unknown options are ignored silently.
- **The tree's `select()` adds to the selection**, it does not replace it. Without an
  explicit `deselect()` of the previous row, every file visited with `j` stays lit.
- **`resetPaths` notifies subscribers before it returns.** The listener that tracks folds
  runs on that notification, sees every directory back open, and empties the set of folded
  paths — so the set has to be copied *before* the reset, or folds never survive a rebuild.
  The first test written for this passed anyway: an unchanged file list is reused as is, so
  `resetPaths` never ran. It only goes red when the revision under review changes. **A test
  that never reaches the code it covers is worse than no test** — this is the fourth time
  on this project, see issue #1.
- **Measuring at first frame gives wrong numbers.** Content arrives asynchronously. Any
  perf measurement must wait for DOM stabilisation or it reports times 10× too good.
- **Absence from a virtualised pane proves nothing.** "This file is not rendered" has to be
  established across the whole scroll, one step under a viewport, or it only says the file
  sits below the fold. `allDiffFiles()` does that; the count it returns matches the file
  count exactly, which is how we know the walk misses nothing.
- **The suites share one fixture within a run.** `pickers` writes `branch.feature.ghlBase`
  into it, so every suite after it sees a wider diff — 60 files instead of 58. Harmless
  while assertions stay relative, and a trap the day one of them hardcodes a number.

## 6. V2

`.git` watcher + WebSocket · context expansion · exportable comments (JSON/markdown, to
paste back to an agent) · daemon · multi-level stack view.

## References

- Benchmark: `scratchpad/bench/` (fixtures are real PRs; `run-bench.mjs`,
  `repro-collapsed.mjs`, `test-hypothese.mjs`)
- Library: `@pierre/diffs` 1.3.5, Apache-2.0 — docs at diffs.com, agent skill via
  `npx skills add pierrecomputer/pierre --skill diffs`
