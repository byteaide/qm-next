/**
 * Postgres SequenceAllocator: durable twin of the memory allocator.
 *
 * Schema:
 *   CREATE TABLE concurrency_seq (
 *     run_id text PRIMARY KEY,
 *     max_seq bigint NOT NULL DEFAULT -1
 *   )
 *
 * Linked ADRs: ADR-0001 (Run owns terminal events and observation).
 */
import type { RunId, SequenceAllocation, SequenceAllocator } from '@qm/types'
import { createPgPool, type PgPool } from '@qm/store'

export interface PostgresSequenceAllocatorOptions {
  connectionString: string
  pool?: PgPool
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS concurrency_seq (
     run_id text PRIMARY KEY,
     max_seq bigint NOT NULL DEFAULT -1
   )`,
]

export function createPostgresSequenceAllocator(
  opts: PostgresSequenceAllocatorOptions,
): SequenceAllocator {
  const pool = opts.pool ?? createPgPool(opts.connectionString, SCHEMA)
  return {
    async next(runId: RunId): Promise<SequenceAllocation> {
      const result = await pool.query(
        `INSERT INTO concurrency_seq (run_id, max_seq) VALUES ($1, 0)
         ON CONFLICT (run_id) DO UPDATE SET max_seq = concurrency_seq.max_seq + 1
         RETURNING max_seq`,
        [runId],
      )
      const row = result.rows[0] as { max_seq: number } | undefined
      if (!row) return { ok: false, reason: 'run_not_found' }
      return { ok: true, seq: Number(row.max_seq) }
    },
    async current(runId: RunId): Promise<number | null> {
      const result = await pool.query(
        `SELECT max_seq FROM concurrency_seq WHERE run_id = $1`,
        [runId],
      )
      const row = result.rows[0] as { max_seq: number } | undefined
      return row ? Number(row.max_seq) : null
    },
  }
}
