import {
  countCommits,
  currentBranch,
  diffFromMergeBase,
  listRefs,
  mergeBase,
  nameStatus,
  numstat,
  originHead,
  readConfig,
  revExists,
  revParse,
  untrackedPaths,
  untrackedPatch,
  writeConfig,
} from './git.ts'
import { detectGenerated } from './generated.ts'
import type { BaseResolution, FileStat, PatchResult, Totals } from './types.ts'

// Remote first: it is the shared truth. Local names cover repositories with no
// remote at all, of which there are two here.
const TRUNK_FALLBACKS = [
  'origin/main',
  'origin/master',
  'origin/develop',
  'main',
  'master',
  'develop',
]

const baseConfigKey = (branch: string) => `branch.${branch}.ghlBase`

/**
 * The repository's trunk.
 *
 * `origin/HEAD` is authoritative but absent on 22 of the 86 repositories
 * measured here; hardcoding "main" would be wrong on 29 of them.
 */
export async function detectTrunk(repoPath: string): Promise<string | null> {
  const fromOriginHead = await originHead(repoPath)
  if (fromOriginHead && (await revExists(repoPath, fromOriginHead))) return fromOriginHead

  for (const candidate of TRUNK_FALLBACKS) {
    if (await revExists(repoPath, candidate)) return candidate
  }
  return null
}

/**
 * Guess which ref a branch was created from: the one whose merge-base sits
 * closest, since git records no parent.
 *
 * The trunk wins ties, and that rule is load-bearing. Siblings cut from the same
 * commit score exactly like the trunk, and a sibling is not a parent — without
 * it, `adessi/pren-322-input` resolves to an unrelated branch.
 */
export async function guessParent(
  repoPath: string,
  head: string,
  trunk: string | null,
): Promise<{ ref: string; distance: number; reason: 'trunk' | 'stacked-branch' } | null> {
  // The ref being analysed, not HEAD: reading HEAD here silently guessed the
  // base of whatever branch happened to be checked out.
  const headRev = await revParse(repoPath, head)
  if (!headRev) return null
  const refs = await listRefs(repoPath)

  let best: string | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  let trunkDistance: number | null = null

  for (const ref of refs) {
    if (ref === head) continue

    const base = await mergeBase(repoPath, headRev, ref)
    if (!base) continue
    if (base === headRev) continue // descends from HEAD, so not its parent

    const distance = await countCommits(repoPath, base, headRev)
    if (distance === 0) continue

    if (ref === trunk) trunkDistance = distance
    if (distance < bestDistance) {
      bestDistance = distance
      best = ref
    }
  }

  if (trunk && trunkDistance !== null && bestDistance >= trunkDistance) {
    return { ref: trunk, distance: trunkDistance, reason: 'trunk' }
  }
  if (!best) return null
  return { ref: best, distance: bestDistance, reason: 'stacked-branch' }
}

/**
 * Resolve the base to diff against, most trustworthy source first.
 *
 * The result carries how it was obtained, and the UI has to show it: a wrong
 * base produces a misleading diff without ever looking wrong.
 */
export async function resolveBase(
  repoPath: string,
  { override, target }: { override?: string | null; target?: string | null } = {},
): Promise<BaseResolution> {
  // Guessed for what is under review, so another branch does not inherit the
  // base of the checkout.
  const branch = target ?? (await currentBranch(repoPath))
  const trunk = await detectTrunk(repoPath)

  if (override) {
    if (!(await revExists(repoPath, override))) {
      throw new Error(`base "${override}" does not resolve to a revision`)
    }
    return { ref: override, source: 'override', branch, trunk }
  }

  if (branch) {
    const remembered = await readConfig(repoPath, baseConfigKey(branch))
    if (remembered && (await revExists(repoPath, remembered))) {
      return { ref: remembered, source: 'remembered', branch, trunk }
    }
  }

  // On the trunk itself there is nothing to guess.
  const onTrunk = trunk && (branch === trunk.replace('origin/', '') || branch === trunk)
  if (!onTrunk && branch) {
    const guessed = await guessParent(repoPath, branch, trunk)
    if (guessed && guessed.reason === 'stacked-branch') {
      return { ref: guessed.ref, source: 'guessed', branch, trunk, distance: guessed.distance }
    }
  }

  if (trunk) return { ref: trunk, source: 'trunk', branch, trunk }
  throw new Error('no base found: set one with --base, or define origin/HEAD')
}

/** Persist a base choice so it is never guessed again for this branch. */
export async function rememberBase(
  repoPath: string,
  branch: string | null,
  base: string,
): Promise<void> {
  if (!branch) throw new Error('cannot remember a base while HEAD is detached')
  await writeConfig(repoPath, baseConfigKey(branch), base)
}

/**
 * The "virtual PR": everything not in the base, committed or not.
 *
 * Untracked files are listed but kept out of the patch by default. One repo here
 * has 2 modified files against 446 untracked ones — real, unignored, and enough
 * to drown the diff. Callers opt in with `includeUntracked`.
 */
export async function buildPatch(
  repoPath: string,
  base: string,
  { target, includeUntracked = false }: { target?: string | null; includeUntracked?: boolean } = {},
): Promise<PatchResult> {
  const tracked = await diffFromMergeBase(repoPath, base, { target })
  const counts = await numstat(repoPath, base, target)
  const statuses = await nameStatus(repoPath, base, target)
  const generated = await detectGenerated(
    repoPath,
    counts.map((file) => file.path),
  )
  const files: FileStat[] = counts.map((file) => ({
    ...file,
    status: statuses.get(file.path) ?? 'modified',
    generated: generated.has(file.path),
  }))

  // Uncommitted work belongs to the checkout, not to some other ref.
  const paths = target ? [] : await untrackedPaths(repoPath)

  const totals: Totals = files.reduce(
    (acc: Totals, f) => ({
      files: acc.files + 1,
      additions: acc.additions + f.additions,
      deletions: acc.deletions + f.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  )

  if (!includeUntracked || paths.length === 0) {
    return { patch: tracked, untracked: paths, untrackedIncluded: false, files, totals }
  }

  const extra = await untrackedPatch(repoPath, paths)
  return { patch: tracked + extra, untracked: paths, untrackedIncluded: true, files, totals }
}
