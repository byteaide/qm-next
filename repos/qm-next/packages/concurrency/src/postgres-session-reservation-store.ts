/**
 * Postgres SessionReservationStore: durable twin of the memory store.
 *
 * Schema:
 *   CREATE TABLE concurrency_session_reservation (
 *     session_id   text PRIMARY KEY,
 *     run_id       text NOT NULL,
 *     acquired_at  bigint NOT NULL,
 *     expires_at   bigint NOT NULL
 *   )
 *
 * Linked ADRs: ADR-0010 (Approval suspends the same Run).
 */
import type { Clock } from './fake-clock.ts'
import { wallClock } from './fake-clock.ts'
import type {
  ReservationReleaseResult,
  ReservationResult,
  ReservationSnapshot,
  RunId,
  SessionReservationStore,
} from '@qm/types'
import { createPgPool, type PgPool } from '@qm/store'

export interface PostgresSessionReservationStoreOptions {
  connectionString: string
  clock?: Clock
  pool?: PgPool
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS concurrency_session_reservation (
     session_id  text PRIMARY KEY,
     run_id      text NOT NULL,
     acquired_at bigint NOT NULL,
     expires_at  bigint NOT NULL
   )`,
]

export function createPostgresSessionReservationStore(
  opts: PostgresSessionReservationStoreOptions,
): SessionReservationStore {
  const clock = opts.clock ?? wallClock
  const pool = opts.pool ?? createPgPool(opts.connectionString, SCHEMA)

  function now(): number {
    return clock.now()
  }

  return {
    async reserve(sessionId, runId, ttlMs, at): Promise<ReservationResult> {
      if (ttlMs <= 0) return { ok: false, reason: 'ttl_invalid' }
      const t = at ?? now()
      const expiresAt = t + ttlMs
      // Single statement: insert if absent or expired; otherwise keep
      // existing and report it.
      const result = await pool.query(
        `INSERT INTO concurrency_session_reservation (session_id, run_id, acquired_at, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (session_id) DO UPDATE
           SET run_id = EXCLUDED.run_id,
               acquired_at = EXCLUDED.acquired_at,
               expires_at = EXCLUDED.expires_at
           WHERE concurrency_session_reservation.expires_at <= $3
         RETURNING run_id, expires_at, (xmax = 0) AS inserted`,
        [sessionId, runId, t, expiresAt],
      )
      const row = result.rows[0] as { run_id: string; expires_at: number; inserted: boolean } | undefined
      if (!row) {
        const existing = await pool.query(
          `SELECT run_id, expires_at FROM concurrency_session_reservation WHERE session_id = $1`,
          [sessionId],
        )
        const ex = existing.rows[0] as { run_id: string; expires_at: number } | undefined
        if (!ex) return { ok: false, reason: 'ttl_invalid' }
        return { ok: true, acquired: false, currentRunId: ex.run_id, expiresAt: Number(ex.expires_at) }
      }
      if (Boolean(row.inserted)) {
        return { ok: true, acquired: true, expiresAt: Number(row.expires_at) }
      }
      // The ON CONFLICT WHERE clause did not fire (existing row not expired).
      return {
        ok: true,
        acquired: false,
        currentRunId: row.run_id,
        expiresAt: Number(row.expires_at),
      }
    },

    async inspect(sessionId): Promise<ReservationSnapshot | null> {
      const result = await pool.query(
        `SELECT run_id, expires_at, acquired_at FROM concurrency_session_reservation WHERE session_id = $1`,
        [sessionId],
      )
      const row = result.rows[0] as
        | { run_id: string; expires_at: number; acquired_at: number }
        | undefined
      if (!row) return null
      return {
        runId: row.run_id,
        expiresAt: Number(row.expires_at),
        acquiredAt: Number(row.acquired_at),
      }
    },

    async release(
      sessionId,
      runId,
      releaseOpts,
    ): Promise<ReservationReleaseResult> {
      void releaseOpts?.now
      if (!releaseOpts?.terminalStateConfirmed) {
        return { ok: false, reason: 'terminal_not_confirmed' }
      }
      const result = await pool.query(
        `DELETE FROM concurrency_session_reservation WHERE session_id = $1 AND run_id = $2 RETURNING session_id`,
        [sessionId, runId],
      )
      if (result.rows[0]) return { ok: true }
      const exists = await pool.query(
        `SELECT run_id FROM concurrency_session_reservation WHERE session_id = $1`,
        [sessionId],
      )
      const ex = exists.rows[0] as { run_id: string } | undefined
      if (!ex) return { ok: false, reason: 'not_found' }
      return { ok: false, reason: 'run_mismatch' }
    },

    async listActiveForSession(sessionId): Promise<readonly RunId[]> {
      const result = await pool.query(
        `SELECT run_id FROM concurrency_session_reservation WHERE session_id = $1 AND expires_at > $2`,
        [sessionId, now()],
      )
      return (result.rows as Array<{ run_id: string }>).map((r) => r.run_id)
    },
  }
}
