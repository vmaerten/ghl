import { createHash } from 'node:crypto'
import { basename } from 'node:path'

/** Stable checkout ID; the path hash distinguishes worktrees and independent clones. */
export function repoIdFor(repoPath: string): string {
  const hash = createHash('sha1').update(repoPath).digest('hex').slice(0, 7)
  return `${basename(repoPath)}-${hash}`
}
