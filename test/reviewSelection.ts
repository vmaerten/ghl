import { createReviewSelection } from '../web/src/reviewSelection.ts'
import type { Check } from './harness.ts'

export async function runReviewSelection(check: Check): Promise<void> {
  let url = new URL(
    'http://localhost/r/test?base=release&target=feature&commit=abc&committed&untracked&extra=keep#file',
  )
  const remembered: { base: string; target: string | null }[] = []
  let fail = false
  let delay: Promise<void> | undefined
  const selection = createReviewSelection(url, {
    replaceUrl: (next) => {
      url = next
    },
    rememberBase: async (base, target) => {
      remembered.push({ base, target })
      await delay
      if (fail) throw new Error('write failed')
    },
  })
  const initial = selection.getSnapshot()
  check(
    'selection carries the explicit base and all scope controls',
    initial.query === '?base=release&target=feature&commit=abc&committed=1&untracked=1',
  )
  let publications = 0
  const unsubscribe = selection.subscribe(() => {
    publications++
  })
  selection.pickTarget('other/ref')
  const target = selection.getSnapshot()
  check(
    'changing target clears the old commit in state and URL',
    target.target === 'other/ref' && target.commit === null && !url.searchParams.has('commit'),
  )
  check(
    'target changes preserve base, scope flags, unrelated parameters and fragment',
    target.query === '?base=release&target=other%2Fref&committed=1&untracked=1' &&
      url.searchParams.get('extra') === 'keep' &&
      url.hash === '#file',
  )
  selection.pickCommit('def')
  check(
    'commit selection reaches both the URL and request scope',
    url.searchParams.get('commit') === 'def' &&
      selection.getSnapshot().query.includes('commit=def'),
  )
  selection.pickCommit(null)
  selection.pickTarget(null)
  check(
    'whole-range checkout selection removes parameters instead of remembering defaults',
    !url.searchParams.has('target') && !url.searchParams.has('commit'),
  )
  selection.toggleCommitted()
  selection.toggleUntracked()
  check(
    'scope toggles clear flags in the URL and request',
    selection.getSnapshot().query === '?base=release' &&
      !url.searchParams.has('committed') &&
      !url.searchParams.has('untracked'),
  )
  selection.toggleCommitted()
  selection.toggleCommitted()
  check('consecutive toggles read the latest selection', !selection.getSnapshot().committed)

  fail = true
  const beforeFailure = selection.getSnapshot()
  await selection.pickBase('main', 'release').catch(() => {})
  check(
    'failed base persistence preserves the override and loaded selection',
    selection.getSnapshot() === beforeFailure && url.searchParams.get('base') === 'release',
  )
  fail = false
  await selection.pickBase('main', 'release')
  check(
    'remembered base replaces the explicit override only after success',
    !url.searchParams.has('base') &&
      selection.getSnapshot().query === '' &&
      remembered.at(-1)?.target === null,
  )
  const beforeRemember = selection.getSnapshot()
  await selection.pickBase('release', 'main')
  check(
    'remembering a base triggers a fresh selection even when the query stays empty',
    selection.getSnapshot() !== beforeRemember && selection.getSnapshot().query === '',
  )
  const beforeNoop = selection.getSnapshot()
  await selection.pickBase('release', 'release')
  check('picking the displayed base does not reload', selection.getSnapshot() === beforeNoop)

  let release!: () => void
  delay = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = selection.pickBase('main', 'release')
  await Promise.resolve()
  selection.pickTarget('feature')
  const afterNavigation = selection.getSnapshot()
  release()
  await pending
  check(
    'late base persistence cannot change another target selection',
    selection.getSnapshot() === afterNavigation && remembered.at(-1)?.target === null,
  )
  delay = undefined
  await selection.pickBase('release', 'main')
  check('base persistence belongs to the reviewed target', remembered.at(-1)?.target === 'feature')
  check('selection changes notify subscribers', publications > 0)
  unsubscribe()
  const beforeUnsubscribe = publications
  selection.pickCommit('last')
  check('unsubscribed readers receive no further notifications', publications === beforeUnsubscribe)
  delay = new Promise<void>((resolve) => {
    release = resolve
  })
  const pendingFromClosedTab = selection.pickBase('main', 'release')
  await Promise.resolve()
  selection.setActive(false)
  const beforeClose = url.href
  release()
  await pendingFromClosedTab
  check(
    'a closed review cannot replace the next tab URL after a late base write',
    url.href === beforeClose,
  )
  selection.setActive(true)
  selection.toggleCommitted()
  check(
    'StrictMode effect reactivation keeps selection controls functional',
    url.href !== beforeClose,
  )
}
