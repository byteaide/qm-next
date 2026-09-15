/**
 * In-memory channel policy store (11.0 tranche 5, lane A) — the qm
 * `surface-cache/channel-policy-store` surface: per-container standing
 * orders, bot ledger, and ambient opt-in with optimistic-lock-friendly
 * `updatedAt`. Production swaps Postgres in behind the same interface
 * (`createPostgresChannelPolicyStore`, 20.0 twin lane).
 */
import { createPgPool } from '@qm/store'

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

const CHANNEL_POLICY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS channel_policy(
      org_id TEXT NOT NULL, container TEXT NOT NULL,
      orders TEXT NOT NULL DEFAULT '', bots JSONB NOT NULL DEFAULT '{}'::jsonb,
      set_by TEXT, updated_at BIGINT NOT NULL,
      PRIMARY KEY(org_id, container)
    )`,
  `ALTER TABLE channel_policy ADD COLUMN IF NOT EXISTS bots JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `ALTER TABLE channel_policy ADD COLUMN IF NOT EXISTS ambient_enabled BOOLEAN`,
  `ALTER TABLE channel_policy ALTER COLUMN ambient_enabled DROP NOT NULL`,
  `ALTER TABLE channel_policy ALTER COLUMN ambient_enabled DROP DEFAULT`,
  `CREATE TABLE IF NOT EXISTS channel_policy_history(
      id BIGSERIAL PRIMARY KEY,
      org_id TEXT NOT NULL, container TEXT NOT NULL,
      orders TEXT NOT NULL, set_by TEXT, session_id TEXT,
      created_at BIGINT NOT NULL
    )`,
  `ALTER TABLE channel_policy_history ADD COLUMN IF NOT EXISTS bots JSONB`,
  `ALTER TABLE channel_policy_history ADD COLUMN IF NOT EXISTS ambient_enabled BOOLEAN`,
  `CREATE INDEX IF NOT EXISTS channel_policy_history_container
      ON channel_policy_history(org_id, container, id DESC)`,
]

/**
 * Postgres twin of the channel-policy store (20.0 twin lane), translated
 * from qm's `surface-cache/channel-policy-store` onto the qm-next
 * interface; every set() appends a history row exactly like qm.
 */
export function createPostgresChannelPolicyStore(
  connectionString: string,
  opts: { orgId?: string } = {},
): ChannelPolicyStore & { history(container: string, limit?: number): Promise<ChannelPolicyRevision[]> } {
  const orgId = opts.orgId ?? 'default'
  const store = createPgPool(connectionString, CHANNEL_POLICY_SCHEMA_STATEMENTS)
  const policyRow = (r: Record<string, unknown>): ChannelPolicy => ({
    container: r.container as string,
    orders: (r.orders as string) ?? '',
    bots: (r.bots as Record<string, BotPolicy>) ?? {},
    ...(r.ambient_enabled != null ? { ambientEnabled: r.ambient_enabled as boolean } : {}),
    ...(r.set_by != null ? { setBy: r.set_by as string } : {}),
    updatedAt: Number(r.updated_at),
  })
  return {
    async get(container) {
      const rows = await store.q('SELECT * FROM channel_policy WHERE org_id = $1 AND container = $2', [orgId, container])
      return rows[0] ? policyRow(rows[0]!) : null
    },
    async set(container, orders, opts2 = {}) {
      const at = Date.now()
      const rows = await store.q(
        `WITH up AS (
           INSERT INTO channel_policy(org_id, container, orders, bots, ambient_enabled, set_by, updated_at)
           VALUES ($1,$2,$3,COALESCE($4::jsonb,'{}'::jsonb),CASE WHEN $7 THEN $6::boolean END,$5,$8)
           ON CONFLICT (org_id, container) DO UPDATE SET orders = EXCLUDED.orders,
             bots = COALESCE($4::jsonb, channel_policy.bots),
             ambient_enabled = CASE WHEN $7 THEN $6::boolean ELSE channel_policy.ambient_enabled END,
             set_by = EXCLUDED.set_by, updated_at = EXCLUDED.updated_at
           RETURNING *
         ), hist AS (
           INSERT INTO channel_policy_history(org_id, container, orders, bots, ambient_enabled, set_by, created_at)
           SELECT $1, $2, $3, up.bots, up.ambient_enabled, $5, $8 FROM up
         )
         SELECT * FROM up`,
        [
          orgId,
          container,
          orders,
          opts2.bots ? JSON.stringify(opts2.bots) : null,
          opts2.setBy ?? null,
          opts2.ambientEnabled === undefined || opts2.ambientEnabled === null ? null : opts2.ambientEnabled,
          opts2.ambientEnabled !== undefined && opts2.ambientEnabled !== null,
          at,
        ],
      )
      return policyRow(rows[0]!)
    },
    async setAmbient(container, enabled, opts2 = {}) {
      const prev = await this.get(container)
      return this.set(container, prev?.orders ?? '', { ...opts2, ambientEnabled: enabled })
    },
    async history(container, limit = 50) {
      const rows = await store.q(
        'SELECT * FROM channel_policy_history WHERE org_id = $1 AND container = $2 ORDER BY id DESC LIMIT $3',
        [orgId, container, Math.max(1, limit)],
      )
      return rows.map((r) => ({
        container: r.container as string,
        orders: (r.orders as string) ?? '',
        ...(r.bots != null ? { bots: r.bots as Record<string, BotPolicy> } : {}),
        ...(r.ambient_enabled != null ? { ambientEnabled: r.ambient_enabled as boolean } : {}),
        ...(r.set_by != null ? { setBy: r.set_by as string } : {}),
        ...(r.session_id != null ? { sessionId: r.session_id as string } : {}),
        createdAt: Number(r.created_at),
      }))
    },
    async close() {
      await store.close()
    },
  }
}

export interface ChannelPolicyRevision {
  container: string
  orders: string
  bots?: Record<string, BotPolicy>
  ambientEnabled?: boolean
  setBy?: string
  sessionId?: string
  createdAt: number
}
