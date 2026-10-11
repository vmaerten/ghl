# Go release acceptance

The initial supported platform is **macOS ARM64**. Pull requests and branch
pushes do not run CI. Stable version tags run the hosted release job; maintainers
run the
locked toolchain and Chrome for Testing 154.0.8037.92 locally, with static checks,
Go race tests, hot reload, the Node reference suite, installation tests, archive
validation, production Go acceptance and three-pass runtime measurements.

## Local gate

From the checkout, with the locked tools installed:

```bash
mise install --locked
pnpm install --frozen-lockfile
task test:browser:install
task check
task test:go
task test:dev
task test:install
pnpm test:node:node
task release:check
task release:snapshot
task release:acceptance
task release:mise
task release:bench
```

The browser installer downloads into the ignored `.task/browser/` directory.
The harness prefers this exact build; `CHROME_PATH` can explicitly choose a
different executable. The harness automatically selects the installed pinned browser.
Chrome, Python and the C toolchain used by `-race` are test prerequisites;
they are excluded from the consumer's release archive.

For a checked-out version tag, substitute `RELEASE_TAG=vX.Y.Z task release:build`
for the snapshot step. See [Go releases](./go-releases.md) for tag validation.
Run the measurements after the browser suites have finished.

## Checks against the archive

`release:acceptance` first checks the archive's checksum, exact file list,
regular-file entries, licenses and build identity. It extracts the executable
outside the checkout and passes that path to the production suites; it does not
rebuild the binary. An outdated archive fails the commit/version checks.

| Suite            | Behavior exercised                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goCLI.ts`       | Node/Go summaries and Markdown/JSON exports, scopes, errors, stdout/stderr and relocated executable                                                                          |
| `goState.ts`     | Existing Node state, concurrent Node/Go writers, original anchors/timestamps, Viewed, restart, worktrees, imports, corruption and schema rollback                            |
| `goDaemon.ts`    | Shared repositories, concurrent starts, instance replacement, bookmark stability, preserved comments/Viewed, idle/heartbeat/shutdown, Host/Origin and actual clipboard reads |
| `goPoc.ts go`    | Production diff/context/mutation contracts, renamed/Unicode/untracked files, stale/outside comments and browser review actions                                               |
| `goRevisions.ts` | Automatic and remembered bases, stacks, refs, targets, root/merge/selected commits, fallback and commit anchors                                                              |
| `goImages.ts`    | Node/Go image metadata and bytes, unsafe/oversized sources, browser previews and unavailable-image behavior                                                                  |
| `run.ts --go`    | All fifteen shared browser suites: themes, review panel, tree, resize, Viewed, comments, pickers, scroll, renames, order, stacks, commits, worktree, untracked and search    |

The relocated CLI, standalone HTTP checks, daemon tests and shared Go browser
harness run the executable with a PATH containing only Git. The Node test
driver and Chrome remain separate processes. `--version` is also exercised
with an empty PATH. Clipboard checks grant browser permissions and read the
real clipboard on loopback and `ghl.localhost`; the older UI suites retain
their Markdown transport simulations.

The daemon upgrade test changes executable identity by appending a payload to
a copy of the candidate. It checks a new process/revision, transferred repository
registrations and unchanged comment/Viewed data. This simulates replacement;
there is no previous published Go release to install yet. Node-to-Go state
compatibility and restart are tested separately against actual Node writers.

## Promotion policy

The [mise distribution checks](./go-installation.md#maintainer-verification)
exercise the real client/backend with a local release API before publication
and actual GitHub assets afterward. The local published check verifies installed
bytes, PATH, standalone serving and saved state, then upgrades/rolls back when a
previous compatible release exists. Published download and historical upgrade
validation remain pending until the corresponding checks pass.

Run all relevant local checks before pushing a release tag. The tag-only
workflow enforces archive and native desktop verification through `task release`;
it does not run the full browser/contract/benchmark acceptance suite. Those
remain local maintainer checks. See the [release guide](./go-releases.md).
Measurements check response correctness and record performance; they impose no
RAM or latency threshold. Go is the default runtime, with an explicit Node
fallback during the 0.1.x transition.

Support for other platforms must pass native acceptance before adding or
advertising their release assets:

- [macOS Intel #121](https://github.com/vmaerten/ghl/issues/121)
- [Linux #122](https://github.com/vmaerten/ghl/issues/122)
- [Windows #123](https://github.com/vmaerten/ghl/issues/123)

See [production runtime measurements](./go-runtime-benchmark.md) for the
fixtures, results and limits of the performance comparison. Earlier minimal
prototype and isolated PoC reports remain separate.
