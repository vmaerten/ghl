import { useEffect, useMemo, useSyncExternalStore } from 'react'

interface SelectionAdapter {
  replaceUrl: (url: URL) => void
  rememberBase: (base: string, target: string | null) => Promise<void>
}

function describe(url: URL) {
  const params = url.searchParams
  const query = new URLSearchParams()
  for (const key of ['base', 'target', 'commit']) {
    const value = params.get(key)
    if (value) query.set(key, value)
  }
  for (const key of ['committed', 'untracked']) {
    if (params.has(key)) query.set(key, '1')
  }
  return {
    target: params.get('target'),
    commit: params.get('commit'),
    committed: params.has('committed'),
    withUntracked: params.has('untracked'),
    query: query.size ? `?${query}` : '',
  }
}

function pick(params: URLSearchParams, key: string, value: string | null) {
  if (value) params.set(key, value)
  else params.delete(key)
}

/** URL transitions and request scope have one owner, including remembered bases. */
export function createReviewSelection(initialUrl: URL, adapter: SelectionAdapter) {
  let url = new URL(initialUrl)
  let snapshot = describe(url)
  let baseRequest = 0
  let active = true
  let baseWrite = Promise.resolve()
  const listeners = new Set<() => void>()
  const update = (change: (params: URLSearchParams) => void) => {
    if (!active) return
    const next = new URL(url)
    change(next.searchParams)
    adapter.replaceUrl(next)
    url = next
    snapshot = describe(url)
    for (const listener of listeners) listener()
  }
  const toggle = (key: string) =>
    update((params) => {
      if (params.has(key)) params.delete(key)
      else params.set(key, '1')
    })

  return {
    setActive: (value: boolean) => {
      active = value
      if (!value) baseRequest++
    },
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    pickTarget: (target: string | null) => {
      baseRequest++
      update((params) => {
        pick(params, 'target', target)
        params.delete('commit')
      })
    },
    pickCommit: (commit: string | null) => update((params) => pick(params, 'commit', commit)),
    toggleCommitted: () => toggle('committed'),
    toggleUntracked: () => toggle('untracked'),
    pickBase: async (base: string | null, currentBase: string | undefined) => {
      if (!base || base === currentBase) return
      const request = ++baseRequest
      const target = snapshot.target
      const write = baseWrite.then(() => adapter.rememberBase(base, target))
      baseWrite = write.catch(() => {})
      await write
      if (request !== baseRequest) return
      // Publish even without an override: the remembered base changes the request's meaning.
      update((params) => params.delete('base'))
    },
  }
}

export function useReviewSelection(repoId: string | null) {
  const selection = useMemo(
    () =>
      createReviewSelection(new URL(location.href), {
        replaceUrl: (url) => history.replaceState(null, '', url),
        rememberBase: async (base, target) => {
          const response = await fetch(`/r/${repoId}/api/base`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ base, target }),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
        },
      }),
    [repoId],
  )
  useEffect(() => {
    selection.setActive(true)
    return () => selection.setActive(false)
  }, [selection])
  return [useSyncExternalStore(selection.subscribe, selection.getSnapshot), selection] as const
}
