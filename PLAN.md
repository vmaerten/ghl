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
| 1 | ~~**One-shot CLI**, no daemon~~ → **one shared process**, the CLI hands it a repository and returns | The latency argument still holds — a daemon saves 40–80 ms out of ~600 ms — but latency was never the motivation. Going back and forth across 39 repositories was: a process per tab, dying with the terminal that opened it. See §3b |
| 2 | **Node end to end** | One parsing implementation (server and client), and the `./ssr` export stays reachable |
| 3 | Default = **virtual PR**: `merge-base(base, HEAD)` → working tree | "The PR I would open if I pushed right now" |
| 3b | Untracked files **listed but excluded** from the diff | Measured on prebid-server-proxy: 2 modified files against 446 untracked ones. `--untracked` opts in |
| 4 | Base **guessed, displayed, remembered** | A heuristic stays a heuristic: it must be visible and correctable |
| 8 | `cmdk` for the base picker, no design system | 79 KB headless, no provider, no theme competing with the one Shiki imposes. Mantine core is 8.6 MB and brings its own theming |
| 5 | **Manual** refresh (button + `R`) | `.git` watcher deferred; `.git` changes constantly, debouncing is a topic of its own |
| 6 | V1 = file tree + keyboard + persistent viewed | Context expansion and comments in V2 |
| 6b | Comments are filed **per repository**, keyed by path and by the text of their lines — not by revision range like `viewed` | A tick lost when the base changes is correct; a written remark lost is not, and `resolveBase` changes its mind on its own (a guessed base, a `gh stack` chain that moves). What keeps a comment off unrelated lines is its anchor, not a range key. See issue #5 |
| 6c | The anchor is the **text of the commented lines**, not the file's diff-section hash | Reusing `sectionHashes` would stale every comment in a file the moment any hunk in it moves — which is the nominal case, since an agent fixing one remark leaves the others. A signal that always fires says nothing |
| 6d | The tree filter drives `@pierre/trees`' own search model, through **our input in the light DOM** — never `search: true` | The library's input is permanent (its CSS has no closed state) and it claims the keyboard: with it, any letter typed while a row has focus becomes a query, and clicking a file focuses a row — so `j`, `v`, `c` would stop working right after the most common gesture in the tool. `setSearch` lives on the controller and needs none of it. See issue #7 |
| 6e | The filter narrows the **tree and `j`/`k`**, never the items handed to the pane | Filtering the items would change the array on every keystroke, which is decision 7's failure exactly. Keeping the cursor inside the kept set is what stops it landing on a file the sidebar is hiding |
| 7 | ~~A viewed file is **removed from the items**~~ → **`collapsed: true`**, as GitHub does it | Removing it changed the item array on every tick, and the pane rebuilds its virtual window when that happens: the reader was thrown back to the top of the diff, and a file clicked in the tree came back somewhere they never saw (issue #36). The measured cost of collapsing is real but narrower than it looked — see §7 |

### Three disciplines to hold from the first line

They made the later move to a shared process nearly free instead of a refactor — see §3b,
which is what it actually cost:

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
 │     base   : branch.<name>.ghlBase → gh stack chain → heuristic → origin/HEAD
 │              (taken locally) → main|master|develop
 │     target : working tree by default, or any ref (?target=)
 │              the base is guessed FOR the target, not for the checkout
 │
 ├── git diff --merge-base <base> → raw patch
 │
 ├── shared HTTP server, on a fixed port
 │     GET  /api/health           → discovery probe, revision, and the heartbeat
 │     GET  /api/repos            → served repositories
 │     POST /api/repos            → register or update one
 │     POST /api/shutdown         → make way for another build
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
2. The `gh stack` chain, read from `.git/gh-stack`. Not a heuristic: the extension writes
   down which branch each one sits on, which is the single fact git never stores. See
   "Stacked branches" below.
3. "Stacked branch" heuristic: among candidate refs, the one whose merge-base sits closest
   to HEAD. **The trunk wins ties** — two sibling branches cut from the same commit produce
   the same distance as the trunk, and a sibling is not a parent. Verified on a fixture
   where `sister-c` shares `feature-a`'s fork point and still resolves to the trunk.
4. `origin/HEAD` — present on 64 of 86 repositories — taken under its local name, so the
   base is one the picker can offer back.
5. First existing among the local `main`, `master`, `develop`, then `origin/main`,
   `origin/master`, `origin/develop` (57 / 5 / 2 repos; hardcoding `main` would fail on 29,
   and the remote names still cover a clone whose default branch was never checked out).

Short-circuit: when HEAD *is* the trunk, guess nothing.

Covered: 86 of 86 repositories resolve a base.

### Stacked branches

`gh stack` keeps `.git/gh-stack`: a JSON list of stacks, each with its trunk and its
branches bottom-up, with pull request numbers. `src/stack.ts` is the only reader. It never
runs `gh` and never calls GitHub — the file is on disk, so this works offline and without
authentication, and an absent or unknown-schema file simply means "no stack".

Two rules carry the feature:

- **The recorded SHAs are ignored.** `head` and `base` date from the last sync and are stale
  after one local commit. The branch *names* go to `git diff --merge-base`, which is what
  makes the layer's diff match its pull request.
- **A layer sits on the nearest live layer below** — one that still resolves and is not
  merged — falling through to the trunk otherwise. The same rule `gh stack submit` uses to
  pick a PR's base, and the one thing that keeps a stack usable after its bottom merges and
  the branch is pruned.

Switching layer is nothing but switching `?target=`: the base follows, because it is
resolved from the same chain. Viewed ticks are keyed by `<base>..<target>`, so each layer
keeps its own for free.

### Viewed state

`.git/ghl/state.json` (inside `.git`, so never committed, and removed with the repo).
Key: `(base..target, path, content hash)` — if a file changes after being viewed, the tick
clears itself.

**A viewed file stays in the list and folds shut**, as GitHub does it:

```js
const items = allItems.map((item) => ({ ...item, collapsed: item.path in viewed }))
```

It used to leave the array instead, on the measurement in §7 below. That was the wrong
trade: **the item list is the pane's identity**. Change it and the virtual window is rebuilt
from nothing, which put the reader back at the top of the diff every single time a file was
ticked, and made a viewed file clicked in the tree reappear somewhere they never saw — read
as a dead click, and reported as issue #36.

**One condition, and only one:** the item list keeps the same **length and order**, and a
tick only flips one entry's `collapsed` — alongside its `version`, without which the pane
never re-reads the item and the file simply does not fold.

Two further precautions looked obviously necessary and were measured to be worthless —
reusing the object identity of unchanged items, and holding `renderHeaderMetadata` stable
behind refs. The position survives without either. The second is worse than useless: a
render prop that never changes is a header that is never rendered again, so the Viewed box
never ticks and its handler stays closed over the value it was built with, which makes the
file impossible to un-view from there. It shipped for one round of testing before that
surfaced.

The lesson is the general one, and it is why the measurement is written down here: **each
suspected cause has to be removed on its own and measured on its own.** Three plausible
fixes applied together read as one working fix, and two of them were carrying a regression.

Stale entries are filtered on read, not deleted on disk: if the file goes back to what it
was, the tick returns. The file only ever holds one hash per path per range.

Membership decides, not truthiness (`path in viewed`): a stored hash may legitimately be
null, and `Boolean(null)` would silently drop the tick.

### 3b. The shared process

`ghl` in a repository probes `GET /api/health` on the fixed port. Something of ours
answering the same revision gets the repository by `POST /api/repos` and the command
returns; anything else is asked to stop; nothing at all means spawning a detached copy of
`bin/ghl.ts --daemon` and waiting for it to answer. `--no-daemon` keeps the old foreground
behaviour.

**No lock file.** The issue asked for one alongside a stable port; the two turn out to be
the same thing. The bound port *is* the lock, and the OS releases it even after a `kill -9`
— a lock file would outlive the process and need its own staleness check. What remains is
the race: two `ghl` in the same second both find nothing and both spawn. The loser takes
`EADDRINUSE` and exits `0` without a word, and the waiting side polls `/api/health` instead
of assuming its own child won, so both converge on the winner.

**The revision is read once, at import.** Recomputing it per request would make every
instance report the sources currently on disk, so a stale one would always look up to date
— it would never detect the very thing it exists for. Installed, it is the SHA in
`INSTALLED`; from the checkout, the newest mtime across `bin/` and `src/`, so editing the
server takes the port back while rebuilding `web-dist/` does not.

**Replacing an instance hands the repositories over.** The tabs open on the *other*
repositories would otherwise 404 after an upgrade. Per-repo flags do not survive the
handover — they belonged to an invocation whose terminal is long gone.

**The idle timeout needs the heartbeat.** Nothing polls: reading a 200-file diff for half an
hour sends no request at all, and the instance would stop under an open tab. The front end
pings `/api/health` every five minutes while its tab is visible, which is what makes the
threshold mean "no tab" rather than "no click".

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
   local branches ordered by commit date — a plain list was never an option, and
   `origin/<name>` is the same branch under another name, so it is left out. Picking writes
   the choice to `.git/config` and reloads the diff.
6. **Reviewable target.** ✅ Any ref can be reviewed without checking it out, from the CLI
   (`ghl <ref>`), the `t` picker or `?target=`. Uncommitted work is excluded then, since it
   belongs to the working tree.
7. **Persistent viewed.** ✅ Checkbox in each file header (via `renderHeaderMetadata`),
   `v` on the active file, tick in the tree, `Reset`. A viewed file leaves the items array.
   State lives in `.git/ghl/state.json`, keyed by revision range, and each entry stores the
   hash of that file's diff section: change the file and its tick clears, while other files
   keep theirs.

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
- **A tree search that matches nothing filters nothing.** `hide-non-matches` only hides rows
  when at least one path matched (`matchingPaths.length > 0` gates it), so a query no file
  answers puts the whole tree back — under the words "no file matches". The rows are hidden
  from `styles.css` instead, with `!important`, since the library writes `display: flex`
  inline on its host.
- **A tree search rewrites the folds while it is open**, and reopens the ancestors of the
  selected file when it closes. Recording that as the reader's own folding loses every fold
  nested inside another one: the library restores its snapshot, but a fold inside a fold
  never returns to the visible rows, so nothing records it again and the next `resetPaths`
  opens it. `FileTree.tsx` stops its bookkeeping while a filter is in force.
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
- **The item array's length and order are the diff pane's identity.** Change either and the
  virtual window is rebuilt and the reader lands at the top. Any feature that adds, removes
  or reorders files has to reckon with that. Object identity and render-prop identity, on
  the other hand, do not matter — measured, see §"Viewed state".
- **The tree and the diff sort differently, and both are right.** git hands the patch back
  in a flat bytewise sort of whole paths, where `/` beats every letter; the tree groups
  directories first at each level. They disagree from the first row — a file at the root is
  first in one and last in the other — so `j`/`k` walked an order the eye was not following.
  `web/src/fileOrder.ts` reproduces the tree's rule for the diff list.
- **The tree's `sort` option is not a sibling comparator.** Its entries carry `depth` and
  `segments`, and handing it a directories-first-then-name rule reorders the tree into
  something neither pane wanted. The tree keeps its default; the copy lives on our side, with
  `test/suites/order.ts` comparing the two orders row by row — a copy of someone else's rule
  is a copy that can drift.
- **That order is a *natural* sort.** Plain `localeCompare` gives `Widget1, Widget10,
  Widget11` where the tree gives `Widget1, Widget2, Widget3`: `Intl.Collator(_, { numeric:
  true })` is not a nicety here. The two lists agree for nine rows before parting, which is
  exactly the kind of near-miss a spot check at the top of the list confirms as correct.
- **`collapsed` does nothing without `version`.** The pane re-reads an item only when its
  `version` moves, so flipping `collapsed` alone is accepted and then ignored — the box
  ticks, the tree ticks, the file stays wide open, and nothing anywhere says the flag was
  refused. It is written in the type's own doc comment, one line under the field. Same
  family as `diffStyle` vs `layout` below: **this library ignores what it does not
  recognise, and here it ignored what it did.**
- **A render prop held stable is a subtree that never renders again.** Freezing
  `renderHeaderMetadata` behind refs to avoid rebuilding the pane left the Viewed box
  permanently unticked, with a handler closed over its initial value — the file could be
  marked but never unmarked. The suite stayed green: it clicked the box and asserted the
  *counter*, never the box. Assert the control you clicked, not only its consequence.
- **A click on the already-selected row emits nothing.** `onSelectionChange` fires on a
  *change*, so clicking the row you are already on is silent and the click reads as dead.
  That is the whole of issue #36's "you have to click another file first". Listening for the
  click itself is what covers it, reading the path from `composedPath()` since anything
  leaving the shadow root is retargeted to the host.
- **`allDiffFiles` moves the pane and parks it at the top.** Anything asserting *where the
  reader is* must be read before it runs. Asking afterwards measures the helper, not the
  application — which is how a correct fix still showed red, and would just as easily have
  shown green over a broken one.
- **`fetch` silently refuses to send the `Host` you gave it.** undici treats it as a
  forbidden header and substitutes the real one, so a test for the Host allowlist arrives
  looking perfectly legitimate, gets its 200, and passes — while never reaching the code it
  is about. `node:http` honours the override. **The fifth occurrence of a test that never
  reaches its subject**, and the first one caught before it was committed, by checking what
  the request actually carried instead of what it should have.
- **Watching for an idle timeout resets it.** Polling `/api/health` to see when the instance
  gives up counts as activity, so the watching is what keeps it alive. Watch the process,
  not the port.
- **A version stamp recomputed per request is always current.** Reading it at import is the
  whole mechanism: it must say what the process *is running*, not what is on disk now.
- **`mkdtemp` and `git rev-parse` disagree on macOS.** `/var/folders/…` against
  `/private/var/…` for the same directory, and `repoIdFor` hashes the path — so an id
  computed from the temp path addresses a repository the server never registered. Anything
  deriving an id must go through `resolveRepoRoot` first, as the server does.
- **A rename that changes language renders nothing at all.** `@pierre/diffs` preloads the
  grammar of the new name but tokenises with the *old* one, so `App.jsx → App.tsx` throws
  `Language "jsx" not found` and the file is silently absent from the diff — the exact
  shape of a JS→TS migration PR. Fixed by pinning `fileDiff.lang` to the new name. A pure
  rename is safe (no contents, so no grammar) and so is a rename inside one language: only
  renamed **and edited** across languages reaches it.
- **Absence from a virtualised pane proves nothing** — and neither does presence. Both have
  to be established across the whole scroll, one step under a viewport, or the assertion
  only says the file sits below the fold. `allDiffFiles()` does that, and reports coloured
  tokens per file: the failure above rendered a box with nothing in it, which a
  presence-only check would have called a pass.

## 7. What collapsing actually costs

Decision 7 originally ruled out `collapsed: true` on a measurement: 177 files collapsed cost
2,652 ms against 624 ms expanded, 87 files 1,042 ms against 214 ms, and the DOM tripled to a
plateau around 1,350 nodes. Collapsing shortens each item, so more fit in the virtualisation
window, so the library mounts more.

Re-measured on the 54-file fixture, worst case — every file viewed:

| | settle | files mounted | DOM nodes |
|---|---|---|---|
| nothing viewed | 1,767 ms | 3 | 540 |
| every file viewed | 1,787 ms | 23 | 1,347 |

The DOM penalty is confirmed and lands exactly on the plateau the earlier campaign
described. The wall-clock penalty does not appear at this size — and the 4–5× figures were
taken at 87 and 177 files, which are the p99 and beyond: **p50 is 2 files, p90 is 12**.

So the cost was real but priced at the wrong point on the curve. Two things remain honest to
say: this measurement is coarser than the original campaign (it times a page load to DOM
stabilisation, not the render alone), and nothing here says the p99 is free. **Re-measure on
a 177-file PR before assuming it is.** If it bites there, the fallback is to collapse only up
to a threshold and drop to removal beyond it — at the cost of bringing back the bug this
fixed, on exactly the diffs where losing your place hurts most.

## 6. V2

`.git` watcher + WebSocket · context expansion · exportable comments (JSON/markdown, to
paste back to an agent) · a repository switcher in the UI, now that `/api/repos` has more
than one thing to say.

Done since: multi-level stack view (issue #10), see "Stacked branches" in §3.

## References

- Benchmark: `scratchpad/bench/` (fixtures are real PRs; `run-bench.mjs`,
  `repro-collapsed.mjs`, `test-hypothese.mjs`)
- Library: `@pierre/diffs` 1.3.5, Apache-2.0 — docs at diffs.com, agent skill via
  `npx skills add pierrecomputer/pierre --skill diffs`
