import { useEffect, useState } from 'react'

const prefix = 'ghl.session.v1:'
const cache = new Map<string, Record<string, unknown>>()
const savers = new Set<() => void>()
let storageError = ''
const failedStorage = new Set<string>()
const pending = new Set<Promise<unknown>>()
const failed = new Map<string, () => Promise<Response>>()
const versions = new Map<string, number>()
const tails = new Map<string, Promise<void>>()

export function readSession(key: string): Record<string, unknown> {
  if (cache.has(key)) return cache.get(key)!
  try {
    const value = JSON.parse(sessionStorage.getItem(prefix + key) ?? '{}')
    const safe = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    cache.set(key, safe)
    return safe
  } catch {
    return {}
  }
}
export function writeSession(key: string, values: Record<string, unknown>) {
  const next = { ...readSession(key), ...values }
  cache.set(key, next)
  try {
    sessionStorage.setItem(prefix + key, JSON.stringify(next))
    failedStorage.delete(key)
    if (!failedStorage.size) storageError = ''
  } catch {
    failedStorage.add(key)
    storageError =
      'Draft storage is unavailable. Keep this tab open and retry before switching repositories.'
  }
  window.dispatchEvent(new Event('ghl-storage'))
}
export function useSessionError() {
  const [error, setError] = useState(storageError)
  useEffect(() => {
    const update = () => setError(storageError)
    window.addEventListener('ghl-storage', update)
    return () => window.removeEventListener('ghl-storage', update)
  }, [])
  return error
}
export function sessionSaver(save: () => void) {
  savers.add(save)
  const handler = () => save()
  window.addEventListener('pagehide', handler)
  return () => {
    save()
    savers.delete(save)
    window.removeEventListener('pagehide', handler)
  }
}
export function flushSession() {
  for (const save of savers) save()
  // Retry every in-memory value, including text whose earlier storage write failed.
  for (const [key, value] of cache) {
    try {
      sessionStorage.setItem(prefix + key, JSON.stringify(value))
      failedStorage.delete(key)
    } catch {
      throw new Error(
        storageError ||
          'Session storage unavailable; navigation cancelled to preserve your drafts.',
      )
    }
  }
  storageError = ''
  window.dispatchEvent(new Event('ghl-storage'))
}
export function reviewUrl(id: string) {
  const url = readSession(id).url
  const path = `/r/${encodeURIComponent(id)}`
  return typeof url === 'string' && (url === path || url.startsWith(`${path}?`)) ? url : path
}
export async function writeRequest(url: string, options: RequestInit): Promise<Response> {
  const address = new URL(url, 'http://localhost')
  const body = typeof options.body === 'string' ? JSON.parse(options.body) : {}
  const collection = address.pathname
  const isViewed = collection.endsWith('/api/viewed')
  const identity = collection.endsWith('/api/comments')
    ? (body.id ?? address.searchParams.get('id'))
    : isViewed
      ? `${body.range}:${body.path ?? '*'}`
      : (body.target ?? '')
  const key = `${collection}:${identity}`
  const group = isViewed ? collection : key
  const version = (versions.get(key) ?? 0) + 1
  versions.set(key, version)
  if (isViewed && body.clear) {
    // A reset supersedes failed ticks in this comparison, including queued ones.
    for (const oldKey of versions.keys())
      if (oldKey.startsWith(`${collection}:${body.range}:`) && oldKey !== key) {
        versions.set(oldKey, versions.get(oldKey)! + 1)
        failed.delete(oldKey)
      }
  }
  const operation = async () => {
    const response = await fetch(url, options)
    if (!response.ok) throw new Error(`Could not save review (HTTP ${response.status})`)
    return response
  }
  const task = (tails.get(group) ?? Promise.resolve()).then(operation)
  const tail = task.then(
    () => undefined,
    () => undefined,
  )
  tails.set(group, tail)
  void tail.then(() => {
    if (tails.get(group) === tail) tails.delete(group)
    return undefined
  })
  pending.add(task)
  try {
    const result = await task
    if (versions.get(key) === version) failed.delete(key)
    return result
  } catch (error) {
    if (versions.get(key) === version) failed.set(key, operation)
    throw error
  } finally {
    pending.delete(task)
  }
}
export async function waitForWrites(retry = false) {
  while (pending.size) await Promise.allSettled(pending)
  if (retry)
    for (const [key, operation] of failed) {
      await operation()
      failed.delete(key)
    }
  if (failed.size)
    throw new Error('Some review changes could not be saved. Retry before switching repositories.')
}

export function guardPageExit(event: BeforeUnloadEvent) {
  try {
    flushSession()
  } catch {
    event.preventDefault()
    return
  }
  if (pending.size || failed.size) event.preventDefault()
}
