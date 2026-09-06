import { decodeFrames, encodeMessage, type RpcMessage } from '../src/jsonrpc.ts'

/**
 * A language server that only pretends, driven by its first argument.
 *
 * The real ones cannot produce the failures worth testing — a message torn
 * across two writes, a server that goes quiet, one that will not answer until
 * its own request is answered — and they make a suite depend on what is
 * installed and how long it takes to index. This one produces exactly those, in
 * milliseconds, and speaks the real framing while doing it.
 *
 * Its one honest imitation: like tsserver, it answers `{ contents: [] }` about a
 * document it was never handed. That is what makes "was `didOpen` sent first"
 * an assertion about behaviour rather than about our own bookkeeping.
 */

const mode = process.argv[2] ?? 'normal'
const opened = new Set<string>()
let answeredOurRequest = false
let buffered: Buffer = Buffer.alloc(0)

const write = (message: RpcMessage) => {
  const frame = encodeMessage(message)

  if (mode === 'split-every-byte') {
    for (const byte of frame) process.stdout.write(Buffer.from([byte]))
    return
  }

  if (mode === 'two-per-write') {
    // A log line and the answer in a single write, which is what a real server
    // does whenever it has something to say just before it replies.
    const chatter = encodeMessage({
      jsonrpc: '2.0',
      method: 'window/logMessage',
      params: { type: 3, message: 'thinking' },
    })
    process.stdout.write(Buffer.concat([chatter, frame]))
    return
  }

  process.stdout.write(frame)
}

const HOVERS: Record<string, unknown> = {
  legacy: [
    { language: 'typescript', value: 'const answer: 42' },
    'The number, as an older server would say it.',
  ],
  empty: [],
  multibyte: {
    kind: 'markdown',
    value: '```typescript\nconst café: "où ça"\n```\n\nUn caractère à cheval sur deux writes.',
  },
  normal: {
    kind: 'markdown',
    value: '```typescript\nconst answer: 42\n```\n\nThe answer to everything.',
  },
}

const hoverFor = (uri: string): unknown => {
  // The imitation that matters: a document nobody opened has nothing to say.
  if (!opened.has(uri)) return { contents: [] }
  if (mode === 'legacy-marked-string') return { contents: HOVERS.legacy }
  if (mode === 'empty-contents') return { contents: HOVERS.empty }
  if (mode === 'multibyte') return { contents: HOVERS.multibyte }
  return { contents: HOVERS.normal }
}

const definitionFor = (uri: string): unknown => {
  const target = process.env.GHL_FAKE_TARGET
  return {
    uri: target ? `file://${target}` : uri,
    range: { start: { line: 1, character: 6 }, end: { line: 1, character: 12 } },
  }
}

const handle = (message: RpcMessage) => {
  const { id, method, params } = message

  if (method === 'initialize') {
    if (mode === 'never-starts') return // the caller is meant to give up on us
    write({ jsonrpc: '2.0', id, result: { capabilities: {} } })
    if (mode === 'dies-after-initialize') process.exit(1)
    return
  }

  if (method === 'initialized') {
    if (mode === 'needs-a-reply') {
      // Sent the way gopls asks for a progress token: nothing else is answered
      // until this is, so a client that ignores it hangs on every later call.
      write({ jsonrpc: '2.0', id: 9001, method: 'window/workDoneProgress/create', params: {} })
    }
    return
  }

  if (method === 'textDocument/didOpen') {
    const uri = (params as { textDocument?: { uri?: string } })?.textDocument?.uri
    if (uri) opened.add(uri)
    return
  }

  if (method === 'shutdown') return write({ jsonrpc: '2.0', id, result: null })
  if (method === 'exit') process.exit(0)

  if (method === 'textDocument/hover' || method === 'textDocument/definition') {
    if (mode === 'never-answers') return
    if (mode === 'needs-a-reply' && !answeredOurRequest) return
    const uri = (params as { textDocument?: { uri?: string } })?.textDocument?.uri ?? ''
    const result = method === 'textDocument/hover' ? hoverFor(uri) : definitionFor(uri)
    return write({ jsonrpc: '2.0', id, result })
  }

  // Our own request, answered: everything held back may go now.
  if (id === 9001 || (id !== undefined && method === undefined)) answeredOurRequest = true
}

process.stdin.on('data', (chunk: Buffer) => {
  buffered = Buffer.concat([buffered, chunk])
  const { frames, rest } = decodeFrames(buffered)
  buffered = rest
  for (const frame of frames) {
    try {
      handle(JSON.parse(frame))
    } catch {
      // A frame we cannot read is one we have nothing to answer.
    }
  }
})
