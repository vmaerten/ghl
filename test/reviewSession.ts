import { waitForWrites, writeRequest } from '../web/src/reviewSession.ts'
import type { Check } from './harness.ts'

const write = (id: string, body: string) =>
  writeRequest('/r/test/api/comments?base=main', {
    method: 'PATCH',
    body: JSON.stringify({ id, body }),
  })

export async function runReviewSession(check: Check) {
  const original = globalThis.fetch
  const calls: string[] = []
  let fail = true
  globalThis.fetch = async (_url, options) => {
    calls.push(String(options?.body ?? options?.method))
    return new Response('{}', { status: fail ? 503 : 200 })
  }
  try {
    await write('one', 'old text').catch(() => {})
    let blocked = false
    try {
      await waitForWrites()
    } catch {
      blocked = true
    }
    check('failed writes prevent checkout navigation', blocked)
    fail = false
    await write('one', 'latest text')
    const before = calls.length
    await waitForWrites(true)
    check(
      'a newer edit supersedes a failed edit without replaying old text',
      calls.length === before,
    )
    fail = true
    await write('deleted', 'failed creation').catch(() => {})
    fail = false
    await writeRequest('/r/test/api/comments?id=deleted', { method: 'DELETE' })
    const afterDelete = calls.length
    await waitForWrites(true)
    check(
      'successful deletion cannot be undone by retrying an old creation',
      calls.length === afterDelete,
    )
    fail = true
    await writeRequest('/r/test/api/viewed', {
      method: 'POST',
      body: JSON.stringify({ range: 'main..feature', path: 'file', viewed: true }),
    }).catch(() => {})
    fail = false
    await writeRequest('/r/test/api/viewed', {
      method: 'POST',
      body: JSON.stringify({ range: 'main..feature', clear: true }),
    })
    const afterReset = calls.length
    await waitForWrites(true)
    check('resetting Viewed supersedes failed individual ticks', calls.length === afterReset)
    let finish!: (response: Response) => void
    globalThis.fetch = () =>
      new Promise<Response>((resolve) => {
        finish = resolve
      })
    const pending = write('slow', 'text')
    await Promise.resolve()
    let settled = false
    const barrier = waitForWrites().then(() => {
      settled = true
      return undefined
    })
    await Promise.resolve()
    check('the navigation barrier waits for pending writes', !settled)
    finish(new Response('{}'))
    await pending
    await barrier
    check('the barrier releases after acknowledgement', settled)
  } finally {
    globalThis.fetch = original
  }
}
