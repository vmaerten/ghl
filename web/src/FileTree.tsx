import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { resolveTheme } from '@pierre/diffs'
import {
  themeToTreeStyles,
  type FileTreeDirectoryHandle,
  type FileTreeItemHandle,
  type FileTreeRowDecoration,
  type TreeThemeStyles,
} from '@pierre/trees'
import { FileTree as TreeView, useFileTree } from '@pierre/trees/react'

import type { GitStatus } from '../../src/types.ts'

/** The root of `@pierre/trees` does not re-export this one. */
interface DecorationPart {
  text: string
  color?: string
}

/** One row's worth of what App knows about a file. */
export interface TreeEntry {
  id: string
  path: string
  additions: number
  deletions: number
  binary: boolean
  status: GitStatus
  viewed: boolean
  generated: boolean
}

/** What App drives the tree with, since folding and revealing live in here. */
export interface FileTreeHandle {
  reveal: (path: string) => void
  expandAll: () => void
  collapseAll: () => void
}

interface FileTreeProps {
  entries: TreeEntry[]
  activePath: string | undefined
  onSelect: (path: string) => void
}

/**
 * `isDirectory()` is declared `: true` / `: false` on the two members of the
 * handle union, not as a type predicate, and TypeScript will not narrow a union
 * on a method's return type. This is that narrowing, by hand.
 */
const asDirectory = (item: FileTreeItemHandle | null): FileTreeDirectoryHandle | null =>
  item?.isDirectory() ? (item as FileTreeDirectoryHandle) : null

interface DirectoryTotals {
  files: number
  additions: number
  deletions: number
}

/** Same palette as the diff pane, so counts read identically on both sides. */
const ADDED = '#3fb950'
const DELETED = '#f85149'
const MUTED = '#8b949e'

/**
 * Every directory a file sits under, as the tree addresses them: with a trailing
 * slash, and a folded chain named after its deepest segment (`web/src/`).
 */
const ancestorDirs = (path: string): string[] => {
  const parts = path.split('/').slice(0, -1)
  return parts.map((_: string, i: number) => `${parts.slice(0, i + 1).join('/')}/`)
}

/** Aggregate counts per directory: the renderer only ever sees one row at a time. */
function directoryTotals(entries: TreeEntry[]): Map<string, DirectoryTotals> {
  const totals = new Map<string, DirectoryTotals>()
  for (const entry of entries) {
    for (const dir of ancestorDirs(entry.path)) {
      const current = totals.get(dir) ?? { files: 0, additions: 0, deletions: 0 }
      current.files += 1
      current.additions += entry.additions
      current.deletions += entry.deletions
      totals.set(dir, current)
    }
  }
  return totals
}

/** Join coloured parts into the plain string the row also needs. */
const asText = (parts: DecorationPart[]): FileTreeRowDecoration => ({
  text: parts.map((part) => part.text).join(''),
  parts,
})

/**
 * The changed-file tree, over `@pierre/trees`. Two of its constraints shape this
 * whole file:
 *
 *  - `useFileTree` reads its options once, at construction. Anything that
 *    changes later reaches the model imperatively or through a ref, never as a
 *    prop.
 *  - one decoration per row, text or icon, never a node — so the viewed tick and
 *    the +/- counts share a single string.
 */
function FileTree(
  { entries, activePath, onSelect }: FileTreeProps,
  ref: React.ForwardedRef<FileTreeHandle>,
) {
  const [themeStyles, setThemeStyles] = useState<TreeThemeStyles | null>(null)

  // Read by callbacks the model captured at construction.
  const entriesRef = useRef(new Map<string, TreeEntry>())
  const onSelectRef = useRef(onSelect)
  const totalsRef = useRef(new Map<string, DirectoryTotals>())
  /** Directories the reader folded, so a refresh does not unfold them all. */
  const collapsedRef = useRef(new Set<string>())
  /** Set while we drive the selection ourselves, to not echo it back to App. */
  const syncingRef = useRef(false)

  const byPath = useMemo(() => new Map(entries.map((e) => [e.path, e] as const)), [entries])
  entriesRef.current = byPath
  onSelectRef.current = onSelect
  totalsRef.current = useMemo(() => directoryTotals(entries), [entries])

  const { model } = useFileTree({
    paths: entries.map((e) => e.path),
    icons: { set: 'complete', colored: true },
    density: 'compact',
    flattenEmptyDirectories: true,
    initialExpansion: 'open',
    onSelectionChange: (paths) => {
      if (syncingRef.current) return
      const path = paths.at(-1)
      if (path && !model.getItem(path)?.isDirectory()) onSelectRef.current?.(path)
    },
    renderRowDecoration: ({ row }) => {
      if (row.kind === 'directory') {
        if (row.isExpanded) return null // nothing hidden, nothing to say
        const totals = totalsRef.current.get(row.path)
        if (!totals) return null
        const label = `${totals.files} ${totals.files > 1 ? 'files' : 'file'}`
        return asText([{ text: label, color: MUTED }])
      }

      const entry = entriesRef.current.get(row.path)
      if (!entry) return null

      const parts = []
      if (entry.viewed) parts.push({ text: '✓ ', color: ADDED })
      // The tree lists them even though the diff pane does not render them, so
      // the row has to say why it leads nowhere.
      if (entry.generated) parts.push({ text: 'gen ', color: MUTED })
      if (entry.binary) parts.push({ text: 'bin', color: MUTED })
      else {
        if (entry.additions > 0) parts.push({ text: `+${entry.additions}`, color: ADDED })
        if (entry.deletions > 0) parts.push({ text: ` −${entry.deletions}`, color: DELETED })
      }
      return parts.length > 0 ? asText(parts) : null
    },
  })

  // The same resolved theme the diff pane uses, so both agree on every colour.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const theme = await resolveTheme('github-dark')
        if (!cancelled) setThemeStyles(themeToTreeStyles(theme))
      } catch {
        // Falls back to the tree's own dark palette, close enough to live with.
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  /** Expand every directory on the way to `path`, or scrollToPath finds nothing. */
  const reveal = useCallback(
    (path: string) => {
      for (const dir of ancestorDirs(path)) {
        const item = asDirectory(model.getItem(dir))
        if (item && !item.isExpanded()) {
          item.expand()
          collapsedRef.current.delete(dir)
        }
      }
      model.scrollToPath(path, { focus: false, offset: 'nearest' })
    },
    [model],
  )

  /**
   * Fold or unfold everything. Folding runs backwards so children close first,
   * or unfolding one directory later spills its whole subtree.
   */
  const setAllExpanded = useCallback(
    (expanded: boolean) => {
      for (let pass = 0; pass < 64; pass++) {
        const rows = model.getVisibleRows(0, model.getVisibleCount())
        const dirs = rows.filter((row) => row.kind === 'directory' && row.isExpanded !== expanded)
        if (dirs.length === 0) break
        for (const row of expanded ? dirs : dirs.toReversed()) {
          const item = asDirectory(model.getItem(row.path))
          if (!item) continue
          if (expanded) {
            item.expand()
            collapsedRef.current.delete(row.path)
          } else {
            item.collapse()
            collapsedRef.current.add(row.path)
          }
        }
        // Folding needs a single pass: closing a parent cannot reveal anything.
        if (!expanded) break
      }
    },
    [model],
  )

  useImperativeHandle(
    ref,
    () => ({
      reveal,
      expandAll: () => setAllExpanded(true),
      collapseAll: () => setAllExpanded(false),
    }),
    [reveal, setAllExpanded],
  )

  // Tracked live: a directory inside a folded one is no longer visible, so the
  // set cannot be read back after the fact.
  useEffect(
    () =>
      model.subscribe(() => {
        for (const row of model.getVisibleRows(0, model.getVisibleCount())) {
          if (row.kind !== 'directory') continue
          if (row.isExpanded) collapsedRef.current.delete(row.path)
          else collapsedRef.current.add(row.path)
        }
      }),
    [model],
  )

  // Keyed by content: `entries` is rebuilt on every viewed toggle, and resetting
  // the tree there would throw away every fold.
  const pathKey = entries.map((e) => e.path).join('\n')
  const paths = useMemo(() => (pathKey ? pathKey.split('\n') : []), [pathKey])

  // Reset only accepts expanded paths, so folds are restored by hand — and from
  // a copy, because reset notifies the subscriber above, which sees every
  // directory back open and empties the set before we can read it.
  useEffect(() => {
    const folded = [...collapsedRef.current]
    model.resetPaths(paths)
    for (const path of folded) {
      asDirectory(model.getItem(path))?.collapse()
    }
  }, [model, paths])

  useEffect(() => {
    model.setGitStatus(entries.map((e) => ({ path: e.path, status: e.status ?? 'modified' })))
  }, [model, entries])

  // The model cannot know a decoration changed, so a tick or a count needs this.
  useEffect(() => {
    model.setComposition(model.getComposition())
  }, [model, entries])

  // `select()` adds to the selection rather than replacing it, so the previous
  // row has to be dropped by hand or every visited file stays lit.
  useEffect(() => {
    syncingRef.current = true
    try {
      for (const path of model.getSelectedPaths()) {
        if (path !== activePath) model.getItem(path)?.deselect()
      }
      if (activePath) model.getItem(activePath)?.select()
    } finally {
      syncingRef.current = false
    }
  }, [model, activePath])

  const style = useMemo(
    () => ({
      flex: 1,
      minHeight: 0,
      ...themeStyles,
      // github-dark's sidebar colour is a shade off ours, and the gap shows as a
      // seam under the header.
      '--trees-theme-sidebar-bg': 'var(--bg-raised)',
    }),
    [themeStyles],
  )

  return <TreeView model={model} className="tree" style={style} aria-label="Changed files" />
}

export default forwardRef(FileTree)
