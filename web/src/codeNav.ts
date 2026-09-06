import type { LspDefinitionPayload, LspHoverPayload } from '../../src/types.ts'

/** Long enough that crossing a line of code does not fire on every word. */
export const HOVER_DELAY_MS = 250
/**
 * Long enough to reach the card with the pointer.
 *
 * Without it there is no way to enter the popover at all — it vanishes in the
 * gap between the token and itself — so a long doc could never be scrolled and
 * nothing in it could ever be clicked.
 */
export const HIDE_DELAY_MS = 120
/** Answers, including the empty ones: "nothing here" is not worth asking twice. */
export const CACHE_LIMIT = 500

/**
 * Wide enough for the languages the registry serves, narrow enough to drop
 * punctuation.
 *
 * A shiki token is not an identifier: operators, string bodies and comment text
 * all carry a `data-char`, and `mergeWhitespaces: 'never'` produces more of them
 * than one would guess. Keywords are deliberately not filtered — the blacklist
 * would be per-grammar, and `this` or `type` in TypeScript do answer something.
 */
const IDENTIFIER = /^[\p{ID_Start}_$][\p{ID_Continue}_$]*$/u

export const isIdentifier = (text: string): boolean => IDENTIFIER.test(text)

export const positionKey = (path: string, line: number, column: number): string =>
  `${path}:${line}:${column}`

export interface TokenAt {
  path: string
  /** 1-based, in the file on disk — which the additions side of a working tree is. */
  line: number
  column: number
  text: string
}

async function ask(
  repoId: string,
  query: string,
  op: 'hover' | 'definition',
  at: TokenAt,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`/r/${repoId}/api/lsp/${op}${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: at.path, line: at.line, column: at.column }),
    signal,
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

export const askHover = (
  repoId: string,
  query: string,
  at: TokenAt,
  signal: AbortSignal,
): Promise<LspHoverPayload> => ask(repoId, query, 'hover', at, signal) as Promise<LspHoverPayload>

export const askDefinition = (
  repoId: string,
  query: string,
  at: TokenAt,
  signal: AbortSignal,
): Promise<LspDefinitionPayload> =>
  ask(repoId, query, 'definition', at, signal) as Promise<LspDefinitionPayload>

/** Nothing to show is not the same as nothing to say; both mean: no card. */
export const isEmpty = (hover: LspHoverPayload): boolean =>
  hover.signature === null && hover.documentation === null

/**
 * Documentation, with inline `code` spans pulled out.
 *
 * The one markdown construct handled by hand, because it is the most common and
 * the ugliest left raw. Bold, links and lists reach the reader as the characters
 * they are — we render what we can prove, and the rest is text.
 */
export function inlineCode(text: string): { code: boolean; text: string }[] {
  return text
    .split('`')
    .map((part, index) => ({ code: index % 2 === 1, text: part }))
    .filter((part) => part.text !== '')
}
