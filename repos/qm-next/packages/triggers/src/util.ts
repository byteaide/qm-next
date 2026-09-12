/**
 * Small shared helpers for the triggers package.
 */
import { createHash } from 'node:crypto'

/** Deterministic content hash: sha256 of the JSON-stable join, hex-sliced. */
export function hashId(parts: readonly unknown[], length = 24): string {
  const digest = createHash('sha256')
  for (const part of parts) digest.update(`${JSON.stringify(part) ?? ''}\u0000`)
  return digest.digest('hex').slice(0, length)
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function truncate(s: string, maxChars: number): string {
  return s.length <= maxChars ? s : `${s.slice(0, maxChars - 3)}...`
}
