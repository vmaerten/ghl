/**
 * The shapes that cross the HTTP boundary.
 *
 * They live apart from the modules that build them so the front end can import
 * them in one go rather than restate them — see #19.
 */

/** What `git diff --name-status` reports, plus the one git cannot: untracked. */
export type GitStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked'

/** A file's line counts, straight from `git diff --numstat`. */
export interface FileCounts {
  path: string
  additions: number
  deletions: number
  binary: boolean
}

export interface FileStat extends FileCounts {
  status: GitStatus
}

/** As served: the hash identifies the diff section a viewed tick was set on. */
export interface ServedFileStat extends FileStat {
  hash: string | null
}

/**
 * Where a base came from. The UI shows it, because a wrong base produces a
 * misleading diff without ever looking wrong.
 */
export type BaseSource = 'override' | 'remembered' | 'stack' | 'guessed' | 'trunk'

export interface BaseResolution {
  ref: string
  source: BaseSource
  branch: string | null
  trunk: string | null
  distance?: number
  /**
   * The chain the branch belongs to, or null when it belongs to none.
   *
   * Carried here because resolving the base is what reads it: the UI shows both,
   * and computing them apart is how the two come to disagree.
   */
  stack: StackChain | null
}

export interface Totals {
  files: number
  additions: number
  deletions: number
}

/** One branch of a `gh stack` chain, and what it should be diffed against. */
export interface StackLayer {
  branch: string
  /** The branch this layer sits on: the nearest live layer below, or the trunk. */
  base: string
  pr: { number: number; url: string } | null
  merged: boolean
  /** False once the branch is pruned: the layer can be shown, not opened. */
  exists: boolean
}

export interface StackChain {
  trunk: string
  /** Bottom (closest to the trunk) first, the order `gh stack` records. */
  layers: StackLayer[]
  /** Index in `layers` of what is under review; the chain was found by it. */
  current: number
}

export type RepoOperation = 'merge' | 'rebase' | 'cherry-pick'

export interface RepoState {
  operation: RepoOperation | null
  conflicted: string[]
}

export interface RefDetail {
  name: string
  when: string
}

/** One commit of the range under review, as the picker lists it. */
export interface CommitDetail {
  sha: string
  short: string
  subject: string
  author: string
  /** Relative, as `RefDetail.when` is: the pickers show the two the same way. */
  when: string
  /** More than one means a merge, which is read against the first. */
  parents: string[]
  /**
   * null when git reported no counts — a merge, or a commit that changes
   * nothing. `--shortstat` says nothing about either, and 0 would be a claim.
   */
  additions: number | null
  deletions: number | null
  files: number | null
}

/** path -> hash of the diff section that was marked as read, or null. */
export type ViewedMap = Record<string, string | null>

/**
 * Which version of a file a line number counts in.
 *
 * The names are the diff pane's, so the two never need translating: deletions
 * are the old file, additions the new one.
 */
export type DiffSide = 'deletions' | 'additions'

/**
 * A remark on a range of lines, written to be handed to an agent.
 *
 * Anchored on a path and a side rather than on a diff item's id: those embed the
 * head sha and change on every commit. Anchored on the lines' own text too, so a
 * remark can say it no longer describes what it was written against.
 */
export interface Comment {
  id: string
  /** The b-side path, as the keys of `sectionHashes` are. */
  path: string
  side: DiffSide
  /** 1-based in that side's version of the file. `end === start` for one line. */
  start: number
  end: number
  body: string
  /** Lines `start`..`end` as they read when it was written. */
  anchor: string[]
  /**
   * What was being compared when it was written.
   *
   * Provenance, never a key. Filing comments by range would hide them whenever
   * `resolveBase` changed its mind on its own — a guessed base, or a `gh stack`
   * chain that moved — which is the tool erasing written text, not the user.
   */
  range: string
  createdAt: string
}

/**
 * As served: whether the lines it was written against still read the same.
 *
 * In the nominal case this is a completion signal rather than a warning — an
 * agent was handed the remark and changed the lines. So it is shown next to what
 * they used to say, and cleared by hand.
 */
export interface ServedComment extends Comment {
  stale: boolean
  /**
   * Lines `start`..`end` as the current patch has them, or empty when the patch
   * no longer carries them.
   *
   * Served rather than re-derived by each reader: cutting them needs the patch,
   * and the export has to quote the code as it is *now* — the anchor is what it
   * was. Both the CLI and the copy button read this, so they cannot disagree.
   */
  code: string[]
}

/** `.git/ghl/state.json` as written. */
export interface StoredState {
  version: number
  viewed: Record<string, ViewedMap>
  /** Flat: a comment belongs to the code it points at, not to a comparison. */
  comments: Comment[]
}

/** The state, and anything reading it had to report. */
export interface StateRead {
  state: StoredState
  /** Set when the file had to be moved aside. Shown, not swallowed. */
  notice: string | null
}

export interface PatchResult {
  patch: string
  untracked: string[]
  untrackedIncluded: boolean
  files: FileStat[]
  totals: Totals
}

/** The body of `GET /r/:repoId/api/diff`. */
export interface DiffPayload {
  repo: { id: string; path: string }
  base: BaseResolution
  head: { branch: string | null; sha: string }
  /** What is under review, and whether uncommitted work is part of it. */
  target: { ref: string; workingTree: boolean }
  /**
   * The one commit being shown, or null for the whole range.
   *
   * Carried so the topbar can name it without opening the picker first, and
   * served rather than echoed back: a sha that no longer resolves falls back to
   * the range, and this field is how the UI learns which of the two it got.
   */
  commit: CommitDetail | null
  range: string
  state: RepoState
  untracked: string[]
  untrackedIncluded: boolean
  files: ServedFileStat[]
  totals: Totals
  viewed: ViewedMap
  /** Only those on a file this diff contains; the rest are for another diff. */
  comments: ServedComment[]
  /**
   * Which files here could be navigated, if any.
   *
   * Carried by the diff rather than fetched on its own: it changes exactly when
   * the diff changes, and a separate endpoint would need a loading state, an
   * error state and a not-known-yet state to answer one boolean. It says what is
   * installed, never what is running — starting a language server to fill this
   * in would make the first page load pay seconds for a hover nobody asked for.
   */
  lsp: LspInfo
  /**
   * Something about the stored state the reader should know, or null.
   *
   * The server runs detached, so its stderr reaches nobody: a state file moved
   * aside has to travel with the payload or it is not reported at all.
   */
  notice: string | null
  patch: string
}

/** The body of `GET /r/:repoId/api/refs`. */
export interface RefsPayload {
  refs: RefDetail[]
  trunk: string | null
  branch: string | null
}

/** The body of `GET /r/:repoId/api/commits`. */
export interface CommitsPayload {
  commits: CommitDetail[]
}

/**
 * Why a navigation question went unanswered.
 *
 * Named rather than reported as a bare null: every one of these is a state the
 * reader can legitimately be in for a frame — switching to a commit while a
 * hover is in flight — so none of them is an error, and a null alone would
 * leave nothing to look at when hovers go quiet.
 */
/** What the pool itself can run into; the two below are the HTTP layer's own guards. */
export type LspSilence = 'no-server-for-this-file' | 'server-unavailable' | 'timed-out'

export type LspRefusal = LspSilence | 'target-is-not-the-working-tree' | 'not-in-the-diff'

/** A stretch of one file, 1-based on both axes: the diff's coordinates, not LSP's. */
export interface LspSpan {
  line: number
  column: number
  endLine: number
  endColumn: number
}

/** A location as the language server gave it, before the diff is consulted. */
export interface LspFound extends LspSpan {
  /** Relative to the repository when `inRepo`, absolute otherwise. */
  path: string
  inRepo: boolean
}

export interface LspLocation extends LspFound {
  /** Whether the diff carries this file: the reader can be taken there, or only told. */
  inDiff: boolean
  /** A few lines around the target, for the one case the diff cannot show. */
  preview: string[]
  /** 1-based number of `preview[0]`, without which the excerpt cannot be numbered. */
  previewStart: number
}

/**
 * A hover, already cut in two.
 *
 * Split here rather than in the browser because the front end has no markdown
 * renderer and is not getting one: a TypeScript hover is a fenced block followed
 * by prose, and two regexes on this side are cheaper than a dependency on that
 * one.
 */
export interface LspHoverPayload {
  refusal: LspRefusal | null
  /** The first fenced block, fences removed. */
  signature: string | null
  /** That block's info string, kept so it can be coloured later. */
  language: string | null
  /** Whatever prose was left. */
  documentation: string | null
}

export interface LspDefinitionPayload {
  refusal: LspRefusal | null
  targets: LspLocation[]
}

/** What navigation this diff supports, announced with the diff itself. */
export interface LspInfo {
  /** Extensions a server is installed for, ".ts" shaped. Empty means stay quiet. */
  extensions: string[]
}
