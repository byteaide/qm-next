/**
 * X3b per-scope command-policy store (qm `resolution/config-store`
 * commandPolicyStore surface parity): one validated `CommandPolicy`
 * record per scope id, resolved at sandbox provision and by the admin
 * simulate surface. In memory by default; the Postgres twin keeps the
 * same interface (20.0 twin lane, channel-policy-store template).
 */
import type { CommandPolicy } from '@qm/types'
import { createPgPool } from '@qm/store'

export interface CommandPolicyRecord {
  scopeId: string
  policy: CommandPolicy
  setBy?: string
  updatedAt: number
}

export interface CommandPolicyStore {
  get(scopeId: string): Promise<CommandPolicyRecord | null>
  set(scopeId: string, policy: CommandPolicy, opts?: { setBy?: string }): Promise<CommandPolicyRecord>
  delete(scopeId: string): Promise<boolean>
  close(): Promise<void>
}

export function createMemoryCommandPolicyStore(opts: { now?: () => number } = {}): CommandPolicyStore {
  const now = opts.now ?? Date.now
  const records = new Map<string, CommandPolicyRecord>()
  return {
    async get(scopeId) {
      const r = records.get(scopeId)
      return r ? { ...r, policy: { ...r.policy, rules: [...r.policy.rules] } } : null
    },
    async set(scopeId, policy, opts2 = {}) {
      const r: CommandPolicyRecord = {
        scopeId,
        policy,
        ...(opts2.setBy ? { setBy: opts2.setBy } : {}),
        updatedAt: now(),
      }
      records.set(scopeId, r)
      return { ...r, policy: { ...r.policy, rules: [...r.policy.rules] } }
    },
    async delete(scopeId) {
      return records.delete(scopeId)
    },
    async close() {},
  }
}

export const COMMAND_POLICY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS command_policy(
      org_id TEXT NOT NULL, scope_id TEXT NOT NULL,
      policy JSONB NOT NULL, set_by TEXT, updated_at BIGINT NOT NULL,
      PRIMARY KEY(org_id, scope_id)
    )`,
  `CREATE TABLE IF NOT EXISTS command_policy_history(
      id BIGSERIAL PRIMARY KEY,
      org_id TEXT NOT NULL, scope_id TEXT NOT NULL,
      policy JSONB NOT NULL, set_by TEXT, deleted BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS command_policy_history_scope
      ON command_policy_history(org_id, scope_id, id DESC)`,
]

/**
 * Postgres twin of the command-policy store (channel-policy-store
 * template): every set/delete appends a history row so operators can
 * audit policy lifecycle per scope.
 */
export function createPostgresCommandPolicyStore(
  connectionString: string,
  opts: { orgId?: string } = {},
): CommandPolicyStore {
  const orgId = opts.orgId ?? 'default'
  const store = createPgPool(connectionString, COMMAND_POLICY_SCHEMA_STATEMENTS)
  const policyRow = (r: Record<string, unknown>): CommandPolicyRecord => ({
    scopeId: r.scope_id as string,
    policy: r.policy as CommandPolicy,
    ...(r.set_by != null ? { setBy: r.set_by as string } : {}),
    updatedAt: Number(r.updated_at),
  })
  return {
    async get(scopeId) {
      const rows = await store.q('SELECT * FROM command_policy WHERE org_id = $1 AND scope_id = $2', [orgId, scopeId])
      return rows[0] ? policyRow(rows[0]!) : null
    },
    async set(scopeId, policy, opts2 = {}) {
      const at = Date.now()
      const rows = await store.q(
        `WITH up AS (
           INSERT INTO command_policy(org_id, scope_id, policy, set_by, updated_at)
           VALUES ($1,$2,$3::jsonb,$4,$5)
           ON CONFLICT (org_id, scope_id) DO UPDATE SET policy = EXCLUDED.policy,
             set_by = EXCLUDED.set_by, updated_at = EXCLUDED.updated_at
           RETURNING *
         ), hist AS (
           INSERT INTO command_policy_history(org_id, scope_id, policy, set_by, deleted, created_at)
           SELECT $1, $2, up.policy, $4, FALSE, $5 FROM up
         )
         SELECT * FROM up`,
        [orgId, scopeId, JSON.stringify(policy), opts2.setBy ?? null, at],
      )
      return policyRow(rows[0]!)
    },
    async delete(scopeId) {
      const at = Date.now()
      const rows = await store.q(
        `WITH gone AS (
           DELETE FROM command_policy WHERE org_id = $1 AND scope_id = $2 RETURNING scope_id
         ), hist AS (
           INSERT INTO command_policy_history(org_id, scope_id, policy, set_by, deleted, created_at)
           SELECT $1, $2, '{}'::jsonb, NULL, TRUE, $3 FROM gone
         )
         SELECT scope_id FROM gone`,
        [orgId, scopeId, at],
      )
      return rows.length > 0
    },
    async close() {
      await store.close()
    },
  }
}
