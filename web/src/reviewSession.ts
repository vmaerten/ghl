import type { SelectedLineRange } from '@pierre/diffs'
import type { Composer } from './CommentThread.tsx'

/** Only reading/editing coordinates and text; never a patch, DOM or viewer. */
export interface ReviewSession {
  version: 1
  diffStyle: 'unified' | 'split'
  commentsOpen: boolean
  panelEditor: { editing: string | null; draft: string }
  activePath?: string
  scrollTop: number
  composer: Composer | null
  drafts: [string, string][]
  selected?: { path: string; range: SelectedLineRange }
  expansions: {
    path: string
    hash: string | null
    index: number
    direction: 'up' | 'down' | 'both'
    count: number
  }[]
}
export interface ReviewSessionHandle {
  capture(): ReviewSession
}
