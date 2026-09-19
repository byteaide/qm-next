/**
 * Postgres LeaseStore: durable twin of the memory store used by the
 * Phase 0 contract suite. Both implementations must pass the same
 * suite bit-identically given the same seed.
 *
 * Schema:
 *   CREATE TABLE concurrency_lease (
 *     run_id        text PRIMARY KEY,
 *     token         text NOT NULL,
 *     acquired_at   bigint NOT NULL,
 *     expires_at    bigint NOT NULL,
 *     session_id    text NOT NULL
 *   )
 *
 * Linked ADRs: ADR-0001 (Run owns terminal state via leases).
 */
import type { Clock } from './fake-clock.ts'
import { wallClock } from './fake-clock.ts'
import type {
  LeaseAcquireResult,
  LeaseReapResult,
  LeaseRenewResult,
  LeaseReleaseResult,
  LeaseSnapshot,
  LeaseStore,
  LeaseToken,
  RunId,
} from '@qm/types'
import { createPgPool, type PgPool } from '@qm/store'

export interface PostgresLeaseStoreOptions {
  connectionString: string
  /** Optional clock for deterministic tests. Production uses wall clock. */
  clock?: Clock
  /** Override the default pool (used by the contract suite). */
  pool?: PgPool
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS concurrency_lease (
     run_id      text PRIMARY KEY,
     token       text NOT NULL,
     acquired_at bigint NOT NULL,
     expires_at  bigint NOT NULL,
     session_id  text NOT NULL
   )`,
]

function newToken(runId: RunId, at: number): LeaseToken {
  return `lease-${runId}-${at}-${Math.random().toString(36).slice(2, 10)}`
}

export function createPostgresLeaseStore(opts: PostgresLeaseStoreOptions): LeaseStore {
  const clock = opts.clock ?? wallClock
  const pool = opts.pool ?? createPgPool(opts.connectionString, SCHEMA)

  function now(): number {
    return clock.now()
  }

  return {
    async acquire(runId, ttlMs, at): Promise<LeaseAcquireResult> {
      const t = at ?? now()
      const token = newToken(runId, t)
      const expiresAt = t + ttlMs
      // Insert if absent; otherwise compare and overwrite only if expired.
      const result = await pool.query(
        `INSERT INTO concurrency_lease (run_id, token, acquired_at, expires_at, session_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (run_id) DO UPDATE
           SET token = EXCLUDED.token,
               acquired_at = EXCLUDED.acquired_at,
               expires_at = EXCLUDED.expires_at,
               session_id = EXCLUDED.session_id
           WHERE concurrency_lease.expires_at <= $3
         RETURNING token, expires_at`,
        [runId, token, t, expiresAt, `session-${runId}`],
      )
      const row = result.rows[0]
      if (!row) {
        const existing = await pool.query(
          `SELECT token, expires_at FROM concurrency_lease WHERE run_id = $1`,
          [runId],
        )
        const existingRow = existing.rows[0] as { expires_at: number } | undefined
        return existingRow
          ? {
              ok: false,
              reason: 'held_by_other',
              currentExpiresAt: Number(existingRow.expires_at),
            }
          : { ok: false, reason: 'held_by_other' }
      }
      return { ok: true, token: row.token as LeaseToken, expiresAt: Number(row.expires_at) }
    },

    async renew(runId, token, ttlMs, at): Promise<LeaseRenewResult> {
      const t = at ?? now()
      const expiresAt = t + ttlMs
      const result = await pool.query(
        `UPDATE concurrency_lease
           SET expires_at = $4
         WHERE run_id = $1 AND token = $2 AND expires_at > $3
         RETURNING expires_at`,
        [runId, token, t, expiresAt],
      )
      const row = result.rows[0]
      if (!row) {
        const exists = await pool.query(
          `SELECT token FROM concurrency_lease WHERE run_id = $1`,
          [runId],
        )
        if (!exists.rows[0]) return { ok: false, reason: 'not_found' }
        return { ok: false, reason: 'token_mismatch' }
      }
      return { ok: true, expiresAt: Number(row.expires_at) }
    },

    async release(runId, token, at): Promise<LeaseReleaseResult> {
      void at
      const result = await pool.query(
        `DELETE FROM concurrency_lease WHERE run_id = $1 AND token = $2 RETURNING run_id`,
        [runId, token],
      )
      if (!result.rows[0]) {
        const exists = await pool.query(
          `SELECT token FROM concurrency_lease WHERE run_id = $1`,
          [runId],
        )
        if (!exists.rows[0]) return { ok: false, reason: 'not_found' }
        return { ok: false, reason: 'token_mismatch' }
      }
      return { ok: true }
    },

    async reapExpired(runId, at): Promise<LeaseReapResult> {
      const t = at ?? now()
      // Newer-session detection: a reservation record in
      // concurrency_session_reservation for this Run with a later
      // acquired_at than the lease is the newer-Session lease. The PG
      // twin leaves that check to the SessionReservationStore; here we
      // simply attempt to delete expired rows.
      const result = await pool.query(
        `DELETE FROM concurrency_lease WHERE run_id = $1 AND expires_at <= $2 RETURNING run_id`,
        [runId, t],
      )
      if (result.rows[0]) return { outcome: 'released' }
      const exists = await pool.query(
        `SELECT expires_at FROM concurrency_lease WHERE run_id = $1`,
        [runId],
      )
      const existing = exists.rows[0] as { expires_at: number } | undefined
      if (!existing) return { outcome: 'not_found' }
      return { outcome: 'not_expired' }
    },

    async inspect(runId): Promise<LeaseSnapshot | null> {
      const result = await pool.query(
        `SELECT token, expires_at, acquired_at, session_id FROM concurrency_lease WHERE run_id = $1`,
        [runId],
      )
      const row = result.rows[0] as
        | { token: string; expires_at: number; acquired_at: number; session_id: string }
        | undefined
      if (!row) return null
      return {
        token: row.token,
        expiresAt: Number(row.expires_at),
        acquiredAt: Number(row.acquired_at),
        sessionId: row.session_id,
      }
    },
  }
}
