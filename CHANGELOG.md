# Changelog

## 0.1.0

The default `ghl` runtime moves from Node to Go. The React interface is embedded
in the executable; users need only Git and a browser. The initial release target
is macOS Apple Silicon (ARM64), distributed through GitHub Releases and mise.

- Preserve existing comments, anchors, timestamps and Viewed state directly in
  each checkout's version-1 `.git/ghl/state.json`, with a shared transaction lock.
- Retain text/image review, context expansion, untracked files, base and revision
  selection, stacks, themes, search, shortcuts and comment exports.
- Reuse a shared local daemon and stable `ghl.localhost:7777` repository URLs;
  newer Go executables replace it while preserving registered repositories.
- Add `ghl-desktop`, a Wails application with review tabs and restoration of
  drafts, selection and scroll between tabs; share saved comments and Viewed
  with the browser CLI. Distribute an ad hoc signed macOS app ZIP alongside it.
- Build, verify and publish both archives through `task release`, automatically
  invoked by GitHub Actions only for stable release tags.
- Use native Task, Air and Vite for build, installation and hot reload.
- Keep Node as the explicit `ghl-node` fallback during the 0.1.x transition.
- Fix search input replacement during delayed opening frames and skip nested
  untracked Git repositories/worktrees rather than aborting the entire review.

Stop an old Node daemon before starting Go on the same port. Read the
[migration guide](./docs/go-migration.md) for PATH precedence, backups and rollback,
and the [installation guide](./docs/go-installation.md) for mise commands.
Other platforms and the optional URL without a port remain follow-up work.
