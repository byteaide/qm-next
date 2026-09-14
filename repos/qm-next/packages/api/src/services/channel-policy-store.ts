/**
 * In-memory channel policy store (11.0 tranche 5, lane A) — the qm
 * `surface-cache/channel-policy-store` surface: per-container standing
 * orders, bot ledger, and ambient opt-in with optimistic-lock-friendly
 * `updatedAt`. Production swaps Postgres in behind the same interface.
 */

export const BOT_MODES = ['ignore', 'rollup', 'action', 'user'] as const

export type BotPolicy = { mode: (typeof BOT_MODES)[number]; rollupHours?: number }

const MAX_LEDGER_BOTS = 200

export function parseBotLedger(input: unknown): { bots: Record<string, BotPolicy> } | { error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return { error: 'bots must be an object keyed by bot author name' }
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length > MAX_LEDGER_BOTS) return { error: `bot ledger is capped at ${MAX_LEDGER_BOTS} entries` }
  const bots: Record<string, BotPolicy> = Object.create(null)
  const seen = new Set<string>()
  for (const [name, v] of entries) {
    const key = name.trim()
    if (!key) return { error: 'bot name must be non-empty' }
    if (seen.has(key.toLowerCase())) return { error: `duplicate bot "${key}" — names match case-insensitively` }
    seen.add(key.toLowerCase())
    const pv = (v ?? {}) as { mode?: unknown; rollupHours?: unknown }
    if (!BOT_MODES.includes(pv.mode as (typeof BOT_MODES)[number])) {
      return { error: `bot "${key}": mode must be one of ${BOT_MODES.join(' | ')}` }
    }
    if (pv.rollupHours !== undefined && (typeof pv.rollupHours !== 'number' || !Number.isFinite(pv.rollupHours) || pv.rollupHours <= 0)) {
      return { error: `bot "${key}": rollupHours must be a positive number` }
    }
    bots[key] = {
      mode: pv.mode as (typeof BOT_MODES)[number],
      ...(typeof pv.rollupHours === 'number' ? { rollupHours: pv.rollupHours } : {}),
    }
  }
  return { bots }
}

export interface ChannelPolicy {
  container: string
  orders: string
  bots: Record<string, BotPolicy>
  ambientEnabled?: boolean
  setBy?: string
  updatedAt: number
}

export interface ChannelPolicyStore {
  get(container: string): Promise<ChannelPolicy | null>
  set(
    container: string,
    orders: string,
    opts?: { setBy?: string; bots?: Record<string, BotPolicy>; ambientEnabled?: boolean | null },
  ): Promise<ChannelPolicy>
  /** Ambient-only opt-in sugar preserving orders/ledger (satisfies @qm/approvals' ambient port). */
  setAmbient(container: string, enabled: boolean, opts?: { setBy?: string }): Promise<ChannelPolicy>
  close(): Promise<void>
}

export function createMemoryChannelPolicyStore(opts: { now?: () => number } = {}): ChannelPolicyStore {
  const now = opts.now ?? Date.now
  const policies = new Map<string, ChannelPolicy>()
  return {
    async get(container) {
      const p = policies.get(container)
      if (!p) return null
      return { ...p, bots: { ...p.bots } }
    },
    async set(container, orders, opts2 = {}) {
      const prev = policies.get(container)
      const p: ChannelPolicy = {
        container,
        orders,
        bots: opts2.bots ?? prev?.bots ?? {},
        ...(opts2.ambientEnabled === undefined && prev?.ambientEnabled !== undefined
          ? { ambientEnabled: prev.ambientEnabled }
          : opts2.ambientEnabled !== undefined && opts2.ambientEnabled !== null
            ? { ambientEnabled: opts2.ambientEnabled }
            : {}),
        ...(opts2.setBy ? { setBy: opts2.setBy } : prev?.setBy ? { setBy: prev.setBy } : {}),
        updatedAt: now(),
      }
      policies.set(container, p)
      return { ...p, bots: { ...p.bots } }
    },
    async setAmbient(container, enabled, opts2 = {}) {
      const prev = await this.get(container)
      return this.set(container, prev?.orders ?? '', { ...opts2, ambientEnabled: enabled })
    },
    async close() {},
  }
}
