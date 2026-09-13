/**
 * Memory notebook line grammar and fold math, ported from qm's
 * `src/memory/notebook.ts` and the pure half of `memory-service.ts`.
 * Facts are markdown bullets tagged with their capture date; dedup is
 * normalization-based (case/punctuation-insensitive), overflow drops the
 * oldest bullets past MEMORY_MAX_FACTS.
 */
import { MEMORY_MAX_FACTS, MEMORY_RECALL_MAX_CHARS } from './contract.ts'

export const MEMORY_HEADER = '# Memory'

export function isBullet(line: string): boolean {
  const t = line.trimStart()
  return t.startsWith('- ') || t.startsWith('* ')
}

export function bulletText(line: string): string {
  return line
    .trimStart()
    .replace(/^[-*]\s*/, '')
    .trim()
}

export function captureDate(text: string): string | undefined {
  return /^\((\d{4}-\d\d-\d\d)\)/.exec(text)?.[1]
}

export function bullets(body: string): string[] {
  return body.split('\n').filter(isBullet).map(bulletText)
}

export function normalize(line: string): string {
  return line
    .replace(/^[-*]\s*/, '')
    .replace(/^\(\d{4}-\d\d-\d\d\)\s*/, '')
    .trim()
    .toLowerCase()
}

export function dateStr(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

export function capTail(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(text.length - maxChars) : text
}

export function recallBody(body: string, maxChars = MEMORY_RECALL_MAX_CHARS): string {
  const trimmed = body.trim()
  return trimmed ? capTail(trimmed, maxChars) : ''
}

export function normalizeReplace(content: string): string {
  const trimmed = content.replace(/\s+$/, '')
  return trimmed ? `${trimmed}\n` : ''
}

export function foldCapture(
  existing: string,
  facts: string[],
  at: number,
  trustedProvenance = false,
): { body: string; added: number } {
  const clean = facts
    .map((f) => {
      let text = f
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[-*]\s+/, '')
      if (!trustedProvenance) {
        text = text
          .replace(/^\((\d{4}-\d\d-\d\d)\)\s*/, 'on $1: ')
          .replace(/\s+\(said in ([^)]+)\)\s*$/i, ' [claimed source: $1]')
      }
      return text
    })
    .filter(Boolean)
  if (!clean.length) return { body: existing, added: 0 }

  const seen = new Set(existing.split('\n').filter(isBullet).map(normalize))
  const date = dateStr(at)
  const added: string[] = []
  for (const f of clean) {
    const key = normalize(f)
    if (!key || seen.has(key)) continue
    seen.add(key)
    added.push(`- (${date}) ${f}`)
  }
  if (!added.length) return { body: existing, added: 0 }

  let body = existing.trim() ? `${existing.replace(/\s+$/, '')}\n${added.join('\n')}` : `${MEMORY_HEADER}\n\n${added.join('\n')}`

  const lines = body.split('\n')
  const bulletIdx = lines.flatMap((l, i) => (isBullet(l) ? [i] : []))
  const overflow = bulletIdx.length - MEMORY_MAX_FACTS
  if (overflow > 0) {
    const drop = new Set(bulletIdx.slice(0, overflow))
    body = lines.filter((_, i) => !drop.has(i)).join('\n')
  }
  return { body, added: added.length }
}

export function queryBullets(body: string, q: string, limit: number): string[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  return bullets(body)
    .filter((l) => terms.every((t) => l.toLowerCase().includes(t)))
    .slice(0, limit)
}
