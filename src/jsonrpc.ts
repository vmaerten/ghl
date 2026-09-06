/**
 * JSON-RPC 2.0 over a byte stream, which is how a language server is spoken to.
 *
 * Hand-rolled rather than built on `vscode-jsonrpc`: `scripts/install.ts` copies
 * `bin/ + src/ + web-dist/` as plain files and nothing else, so everything here
 * imports `node:` or nothing at all. This module imports nothing.
 *
 * It knows no LSP and spawns no process — it is handed a `send` and fed chunks —
 * which is what lets the transport be tested against a scripted server without
 * a language server anywhere in sight.
 */

const HEADER_END = '\r\n\r\n'

export interface RpcMessage {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

export function encodeMessage(message: RpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  // `body.length` is a byte count because it is a Buffer. The same expression on
  // the string would count characters, and every accented identifier in a hover
  // would shift the frame by one.
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}${HEADER_END}`, 'ascii'), body])
}

/**
 * Cut whole messages out of what has arrived so far.
 *
 * A chunk is not a message. The stream splits one message across two `data`
 * events as readily as it packs three into one — a server logging just before it
 * answers is the nominal case, not the edge one — so all three shapes are the
 * same loop here.
 *
 * The slicing stays on the buffer: `Content-Length` counts bytes, and decoding
 * before cutting would both mis-count and tear a multi-byte character in half.
 */
export function decodeFrames(buffer: Buffer): { frames: string[]; rest: Buffer } {
  const frames: string[] = []
  let rest = buffer

  for (;;) {
    const headerEnd = rest.indexOf(HEADER_END)
    if (headerEnd === -1) break

    const header = rest.subarray(0, headerEnd).toString('ascii')
    const length = /content-length:\s*(\d+)/i.exec(header)?.[1]
    // No length is no way to know where this message ends, and so no way to find
    // the next one: the stream is desynchronised for good. Keeping the bytes
    // would only hand the same garbage to the next call.
    if (length === undefined) return { frames, rest: Buffer.alloc(0) }

    const start = headerEnd + HEADER_END.length
    const end = start + Number(length)
    if (rest.length < end) break

    frames.push(rest.subarray(start, end).toString('utf8'))
    rest = rest.subarray(end)
  }

  return { frames, rest }
}

export interface RpcConnection {
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>
  notify(method: string, params: unknown): void
  /** Fed from the child's stdout, chunk by chunk, in order. */
  receive(chunk: Buffer): void
  /** Fail everything in flight and refuse what comes after. */
  fail(why: string): void
  readonly failed: string | null
}

export interface RpcOptions {
  send: (chunk: Buffer) => void
  /**
   * Answer a request coming the other way.
   *
   * Defaults to `null`, which is the point: a server request left unanswered
   * blocks the server's own queue, and the symptom is that every call after the
   * first one times out.
   */
  onRequest?: (method: string, params: unknown) => unknown
}

export function createRpcConnection({ send, onRequest }: RpcOptions): RpcConnection {
  const waiting = new Map<
    number,
    { settle: (value: unknown) => void; fail: (why: Error) => void }
  >()
  let buffered: Buffer = Buffer.alloc(0)
  let nextId = 1
  let failed: string | null = null

  const dispatch = (frame: string) => {
    let message: RpcMessage
    try {
      message = JSON.parse(frame)
    } catch {
      return // not JSON, so not an answer to anything asked here
    }

    if (message.id !== undefined && message.id !== null && message.method !== undefined) {
      const result = onRequest ? onRequest(message.method, message.params) : null
      return send(encodeMessage({ jsonrpc: '2.0', id: message.id, result: result ?? null }))
    }
    // A notification: logs, progress, diagnostics. Nothing here acts on them.
    if (typeof message.id !== 'number') return

    const pending = waiting.get(message.id)
    if (!pending) return // an answer to a request that already timed out
    waiting.delete(message.id)

    if (message.error) pending.fail(new Error(message.error.message ?? 'rpc error'))
    else pending.settle(message.result)
  }

  return {
    get failed() {
      return failed
    },

    receive(chunk) {
      buffered = Buffer.concat([buffered, chunk])
      const { frames, rest } = decodeFrames(buffered)
      buffered = rest
      for (const frame of frames) dispatch(frame)
    },

    notify(method, params) {
      if (failed !== null) return
      send(encodeMessage({ jsonrpc: '2.0', method, params }))
    },

    request(method, params, timeoutMs) {
      return new Promise((resolve, reject) => {
        if (failed !== null) return reject(new Error(failed))

        const id = nextId++
        const timer = setTimeout(() => {
          waiting.delete(id)
          // Telling the server to stop is not politeness: it would otherwise
          // keep working on an answer nobody is waiting for, on a process that
          // stays up for half an hour.
          send(encodeMessage({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }))
          reject(new Error(`${method} timed out`))
        }, timeoutMs)
        // A question in flight is not a reason for the daemon to stay alive.
        timer.unref()

        waiting.set(id, {
          settle: (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          fail: (why) => {
            clearTimeout(timer)
            reject(why)
          },
        })

        try {
          send(encodeMessage({ jsonrpc: '2.0', id, method, params }))
        } catch (cause) {
          // A dead stdin throws EPIPE on write. It is the end of this
          // connection, not an exception for the HTTP handler above to carry.
          waiting.delete(id)
          clearTimeout(timer)
          reject(cause instanceof Error ? cause : new Error(String(cause)))
        }
      })
    },

    fail(why) {
      if (failed !== null) return
      failed = why
      for (const pending of waiting.values()) pending.fail(new Error(why))
      waiting.clear()
    },
  }
}
