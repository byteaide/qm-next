/**
 * Postgres ImDeliveryQueue: the durable twin of the memory queue (20.0
 * twin-gap lane). Claim atomicity via FOR UPDATE SKIP LOCKED; TTL leases,
 * retry-backoff and park semantics mirror `memory-delivery-queue.ts` so
 * callers swap by constructor alone. The `deliveries` table is drained
 * before a migration cutover (runbook), so no qm row-shape coupling.
 */
import { randomUUID } from 'node:crypto'
import type { ImDelivery, ImDeliveryQueue } from '../delivery.ts'
import { createPgPool, type PgPool } from '@qm/store'

export const DELIVERIES_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS deliveries(
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      op JSONB NOT NULL,
      origin JSONB,
      created_at BIGINT NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      delivered_at BIGINT,
      parked_at BIGINT,
      lease_expires_at BIGINT,
      next_claimable_at BIGINT,
      last_error TEXT
    )`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_pending
      ON deliveries (provider, created_at) WHERE delivered_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_parked
      ON deliveries (created_at) WHERE parked_at IS NOT NULL`,
]

function rowToDelivery(r: Record<string, unknown>): ImDelivery {
  return {
    id: r.id as string,
    idempotencyKey: r.idempotency_key as string,
    provider: r.provider as string,
    op: r.op as ImDelivery['op'],
    ...(r.origin != null ? { origin: r.origin as NonNullable<ImDelivery['origin']> } : {}),
    createdAt: Number(r.created_at),
    ...(r.lease_expires_at != null ? { leaseExpiresAt: Number(r.lease_expires_at) } : {}),
    attempts: Number(r.attempts),
    deliveredAt: r.delivered_at === null || r.delivered_at === undefined ? null : Number(r.delivered_at),
    ...(r.parked_at != null ? { parkedAt: Number(r.parked_at) } : {}),
    ...(r.last_error != null ? { lastError: r.last_error as string } : {}),
  }
}

export interface PostgresDeliveryQueue extends ImDeliveryQueue {
  close(): Promise<void>
}

export function createPostgresDeliveryQueue(connectionString: string): PostgresDeliveryQueue {
  const store: PgPool = createPgPool(connectionString, DELIVERIES_SCHEMA_STATEMENTS)
  const listeners = new Set<() => void>()
  const now = () => Date.now()

  async function getRow(id: string): Promise<Record<string, unknown> | null> {
    const rows = await store.q('SELECT * FROM deliveries WHERE id = $1', [id])
    return rows[0] ?? null
  }

  const queue: PostgresDeliveryQueue = {
    async enqueue(input) {
      const id = randomUUID()
      const at = now()
      const inserted = await store.query(
        `INSERT INTO deliveries (id, idempotency_key, provider, op, origin, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [
          id,
          input.idempotencyKey,
          input.provider,
          JSON.stringify(input.op),
          input.origin ? JSON.stringify(input.origin) : null,
          at,
        ],
      )
      if (inserted.rows[0]) {
        for (const listener of listeners) listener()
        return rowToDelivery(inserted.rows[0]!)
      }
      const existing = await store.q('SELECT * FROM deliveries WHERE idempotency_key = $1', [input.idempotencyKey])
      if (!existing[0]) throw new Error(`delivery enqueue lost a race for key ${input.idempotencyKey}`)
      return rowToDelivery(existing[0]!)
    },
    async claim(provider, options) {
      const at = now()
      const max = Math.max(1, options.max ?? 10)
      const rows = await store.q(
        `UPDATE deliveries
            SET attempts = attempts + 1, lease_expires_at = $3
          WHERE id IN (
            SELECT id FROM deliveries
             WHERE provider = $1
               AND delivered_at IS NULL
               AND parked_at IS NULL
               AND (lease_expires_at IS NULL OR lease_expires_at <= $2)
               AND (next_claimable_at IS NULL OR next_claimable_at <= $2)
             ORDER BY created_at
             LIMIT $4
             FOR UPDATE SKIP LOCKED
          )
          RETURNING *`,
        [provider, at, at + options.ttlMs, max],
      )
      return rows.map(rowToDelivery).sort((a, b) => a.createdAt - b.createdAt)
    },
    async ack(id, at) {
      await store.query(
        'UPDATE deliveries SET delivered_at = $2, lease_expires_at = NULL WHERE id = $1 AND delivered_at IS NULL',
        [id, at ?? now()],
      )
    },
    async fail(id, error, options = {}) {
      if (options.park) {
        await store.query(
          'UPDATE deliveries SET last_error = $2, parked_at = $3, lease_expires_at = NULL WHERE id = $1',
          [id, error, now()],
        )
        return
      }
      await store.query(
        'UPDATE deliveries SET last_error = $2, next_claimable_at = $3, lease_expires_at = NULL WHERE id = $1',
        [id, error, now() + (options.retryInMs ?? 0)],
      )
    },
    async get(id) {
      const row = await getRow(id)
      return row ? rowToDelivery(row) : null
    },
    async list(options) {
      const limit = Math.max(1, options?.limit ?? 100)
      const rows = await store.q('SELECT * FROM deliveries ORDER BY created_at DESC, id DESC LIMIT $1', [limit])
      return rows.map(rowToDelivery)
    },
    onEnqueued(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async close() {
      await store.close()
    },
  }
  return queue
}
