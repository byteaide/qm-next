/**
 * Playground artifacts (T5 small port): self-contained HTML documents the
 * agent creates for interactive explanations. Byte-parity with qm
 * `src/playgrounds/playground.ts` (49 lines) minus the store-specific
 * artifact-id minting — qm-next storage goes through the api
 * `FileStoreService`, which owns ids.
 */
const MAX_PLAYGROUND_HTML_BYTES = 512_000
const PLAYGROUND_TITLE_MAX = 80

/** qm `util/text.ts` headSlice: codepoint-safe prefix cut. */
function headSlice(s: string, n: number): string {
  if (n <= 0) return ''
  if (s.length <= n) return s
  const cut = s.slice(0, n)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

/** Collapse whitespace runs, default to "Playground", cap at 80 chars with an ellipsis. */
export function normalizePlaygroundTitle(raw: string): string {
  const title = raw.replace(/\s+/g, ' ').trim() || 'Playground'
  return title.length > PLAYGROUND_TITLE_MAX ? `${headSlice(title, PLAYGROUND_TITLE_MAX - 1)}…` : title
}

/** Reject empty or oversized documents (512 KB utf8 ceiling, qm parity). */
export function validatePlaygroundHtml(html: string): void {
  const bytes = Buffer.byteLength(html, 'utf8')
  if (bytes > MAX_PLAYGROUND_HTML_BYTES) {
    throw new Error(`playground HTML is ${bytes} bytes; keep it under ${MAX_PLAYGROUND_HTML_BYTES}`)
  }
  if (!html.trim()) throw new Error('playground HTML is empty')
}

export const PLAYGROUND_MIMETYPE = 'text/html'
