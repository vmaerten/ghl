# Throwaway desktop envelope benchmark

Question: what does a desktop window cost when it displays the existing Go +
React review UI? This is a measurement prototype, not a production desktop app.
Keep it on its prototype branch; there is no CI or publication task.

Run on macOS ARM64 with the project's Go/Node/pnpm/Task tools, Rust/Cargo and
Xcode Command Line Tools:

```bash
task desktop:bench
```

Dependencies and tools are downloaded locally; apps live in
`.task/desktop-bench/apps/` (TinyJS uses its ignored `dist/` directory). Nothing
is installed globally, no real repository is opened and the normal `ghl` daemon
is not used. Windows open briefly in the foreground during measurement.
TinyJS is extracted from its checksummed v0.50.1 release without running its
global installer. Electron's pinned runtime is downloaded through its official
installer. Go and Rust dependencies have lockfiles.

To rerun only measurement after building:

```bash
python3 poc/desktop-bench/run.py
python3 poc/desktop-bench/run.py --runtimes wails tinyjs --rounds 1 --modes review
```

Results and diagnostic logs are in `.task/desktop-bench/`. The report starts
with `complete: false`; a finished three-pass run has 24 observations and
`complete: true`. See [the measured report](../../docs/desktop-benchmark.md).

## Protocol

- Electron 44.7.0, Tauri 2.12.3, Wails v2.16.0 and TinyJS v0.50.1.
- Release/production builds, locally signed ad hoc. No devtools or HMR servers.
- Identical visible 1280×720 web content; actual dimensions are checked. Tauri's
  macOS title bar needs a 32px compensation in this build.
- Empty window and the real embedded React app, with one temporary repository:
  100 TypeScript files, 200 lines each before and after, all lines changed.
- Three passes; reverse the framework order on the middle pass. New application
  processes and origins each time; existing OS/file/driver caches are retained.
- The same Go backend runs in a separate foreground process for each review.
  Its startup and memory are reported separately and included in review totals.
  No backend is needed for the empty case. This measures envelopes; an optimized
  Wails app with in-process Go bindings is outside this first experiment.
- A local proxy injects identical measurement JavaScript before React. Startup
  ends when the tree, diff lines and syntax colors are present. Scroll proceeds
  top to bottom for five seconds, followed by one second to settle. The final
  file and virtualization are checked. API patch hash, file count and line
  counts must match Git before each review launch.
- Idle sampling occurs after three seconds, over two seconds. The common probe
  polls its control route every 200ms; idle CPU includes that instrumentation.
- RSS and macOS physical footprint cover the app, descendants and processes
  attributed to the app by `responsibility_get_pid_responsible_for_pid`. This
  includes WebKit WebContent, Networking and GPU tasks hosted under launchd.
  Root attribution and renderer inclusion are checked. The attribution lookup
  is an undocumented macOS API; it is not a portable production dependency.
- `proc_pid_rusage` gives memory and CPU. CPU ticks are converted using the
  machine's Mach timebase, verified against BSD rusage. Per-process rows remain
  in the raw JSON. Shared WindowServer/system services are outside these totals.
- Physical footprint is the primary memory measure. Summed RSS includes shared
  pages and is not a measure of additional system RAM. Neither metric is a
  system-wide before/after delta.
- Frame callback intervals describe this synthetic workload, not compositor
  FPS or input latency. Median, p95, mean, maximum, slow-frame count and raw
  intervals are retained. ResizeObserver loop notifications are counted as
  warnings; fatal JS errors fail the run. Performance itself has no pass limit.
- Bundle size counts regular-file bytes once without following symlinks, before
  archive compression. The full estimate adds the Go executable with its
  embedded React assets to each envelope; libraries supplied by macOS are absent.

Wails normally expects its bridge in its own page. For this external-page
envelope the native context-menu disabling script must be turned off; otherwise
it accesses a missing `window.wails` object. That constraint and the initial
Wails-to-HTTP navigation do not apply to a direct in-process integration.

The placeholder Tauri icon comes from the MIT-licensed TinyJS v0.50.1 template.
No framework selection or production migration is implied by this experiment.

Primary references: [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model),
[Tauri process model](https://v2.tauri.app/concept/process-model/),
[Wails manual builds](https://wails.io/docs/guides/manual-builds/),
[TinyJS docs](https://tinyjs.app/docs.html).

## Chrome and the cost of another tab

The browser baseline reuses the same fixture, Go binary, probe and memory
sampler. It controls a separate Chrome for Testing with Puppeteer; it never
connects to the user's Chrome. Install the pinned browser used by the existing
acceptance suite, then run:

```bash
node scripts/test-browser.ts
task desktop:chrome -- --chrome '.task/browser/chrome/mac_arm-154.0.8037.92/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
```

To measure without rebuilding Go, use `python3 poc/desktop-bench/chrome.py`
with the same `--chrome` argument. Three fresh temporary profiles are created.
Each keeps its initial blank tab, opens and traverses the first review tab,
opens and traverses a duplicate review tab, then navigates that second review
tab again. Tab counts must be 2, 3, 3. Each phase checks rendering, visible
1280×720 content and the final file; idle/load timings match the desktop probe.
No personal tabs, extensions, settings or default-browser association change.

The whole browser family is measured before and after each phase. First-tab
incremental memory adds Go to the browser-family delta over the warmed blank
browser. Duplicate/reuse deltas add no second backend. These are paired app
footprint deltas, not system-wide RAM changes. A warmed blank browser is only
a controlled proxy for an already-running daily browser. Chrome toolbar and
UI overhead are included; Puppeteer emulates a 1280×720 viewport in a
1280×820 window. Automation launch flags, Chrome version and exact binary
hashes are recorded. Chrome and Electron have different Chromium versions.
Chrome helpers are descendants of its owned root process; the driver is
excluded. Output is `.task/desktop-bench/chrome-results.json`, separate from
the four-framework results.

Navigating an existing tab in the harness demonstrates a bounded tab count.
It does not implement production tab discovery/focus. The current Go CLI
calls macOS `open <URL>` and has no existing-tab coordination. A production
desktop shell would also need single-instance/window-reuse behavior.
