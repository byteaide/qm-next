/**
 * Ack-emoji pick observability (14.0 tranche 2): qm's ack_emoji_picks
 * surface — one record per reaction-as-ack decision (model picked or
 * declined, final emoji applied), feeding the admin picks view.
 */
import type { AckPickCounts, AckEmojiPick, AckEmojiPickSummary, AckEmojiPickStore, AckPickOutcome } from './contract.ts'

const emptyCounts = (): AckPickCounts => ({ picked: 0, declined: 0 })

export function createMemoryAckEmojiPickStore(): AckEmojiPickStore {
  const picks: AckEmojiPick[] = []
  let seq = 0
  const filtered = (opts?: { channel?: string }) =>
    picks.filter((p) => !opts?.channel || p.channel === opts.channel)
  return {
    async record(p) {
      picks.push({ ...p, id: ++seq })
      if (picks.length > 5000) picks.splice(0, picks.length - 5000)
    },
    async list(opts) {
      const limit = Math.max(1, Math.min(1000, opts?.limit ?? 50))
      const all = filtered(opts)
        .filter(
          (p) =>
            (!opts?.outcome?.length || opts.outcome.includes(p.outcome)) &&
            (opts?.before == null ||
              (opts.beforeId != null
                ? p.createdAt < opts.before || (p.createdAt === opts.before && (p.id ?? 0) < opts.beforeId)
                : p.createdAt < opts.before)),
        )
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt || (b.id ?? 0) - (a.id ?? 0))
      return all.slice(0, limit).map(({ candidates: _c, ...rest }): AckEmojiPickSummary => rest)
    },
    async get(id) {
      return picks.find((p) => p.id === id) ?? null
    },
    async counts(opts) {
      const out = emptyCounts()
      for (const p of filtered(opts)) if (p.outcome in out) out[p.outcome as AckPickOutcome] += 1
      return out
    },
    async close() {},
  }
}

export type { AckEmojiPick, AckEmojiPickStore, AckPickCounts, AckPickOutcome }
