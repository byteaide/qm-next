/**
 * Postgres intake stores: the durable twins of `memory-intake-store.ts`
 * (plan §Phase 5, ADR-0008/0015). Dedup on UNIQUE (provider, event_id),
 * monotonic seq from an atomic counter row, monotonic cursors via
 * GREATEST, idempotent dead letters on UNIQUE (subscriber, intake_id).
 * Semantics mirror the memory twin so callers swap by constructor alone.
 */
import { randomUUID } from 'node:crypto'
import { createPgPool, type PgPool } from '@qm/store'
import type { InboundEvent } from '../inbound.ts'
import type {
  ImIntakeCursorStore,
  ImIntakeDeadLetterStore,
  ImIntakeInbox,
  IntakeAcceptResult,
  IntakeDeadLetter,
  IntakeRecord,
} from '../intake.ts'

export const INTAKE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS im_intake(
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      seq BIGINT NOT NULL UNIQUE,
      event JSONB NOT NULL,
      accepted_at BIGINT NOT NULL,
      turn_id TEXT,
      UNIQUE (provider, event_id)
    )`,
  `CREATE INDEX IF NOT EXISTS idx_im_intake_seq ON im_intake (seq)`,
  `CREATE TABLE IF NOT EXISTS im_intake_counters(
      k TEXT PRIMARY KEY,
      v BIGINT NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS im_intake_cursors(
      subscriber TEXT PRIMARY KEY,
      seq BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS im_intake_dead_letters(
      id TEXT PRIMARY KEY,
      subscriber TEXT NOT NULL,
      intake_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      seq BIGINT NOT NULL,
      attempts INT NOT NULL,
      last_error TEXT NOT NULL,
      failed_at BIGINT NOT NULL,
      redelivery_url TEXT NOT NULL,
      redelivered_at BIGINT,
      redelivered_by TEXT,
      UNIQUE (subscriber, intake_id)
    )`,
]

function rowToRecord(r: Record<string, unknown>): IntakeRecord {
  return {
    id: r.id as string,
    provider: r.provider as string,
    eventId: r.event_id as string,
    seq: Number(r.seq),
    event: r.event as IntakeRecord['event'],
    acceptedAt: Number(r.accepted_at),
    ...(r.turn_id != null ? { turnId: r.turn_id as string } : {}),
  }
}

function rowToLetter(r: Record<string, unknown>): IntakeDeadLetter {
  return {
    id: r.id as string,
    subscriber: r.subscriber as string,
    intakeId: r.intake_id as string,
    provider: r.provider as string,
    eventId: r.event_id as string,
    seq: Number(r.seq),
    attempts: Number(r.attempts),
    lastError: r.last_error as string,
    failedAt: Number(r.failed_at),
    redeliveryUrl: r.redelivery_url as string,
    ...(r.redelivered_at != null ? { redeliveredAt: Number(r.redelivered_at) } : {}),
    ...(r.redelivered_by != null ? { redeliveredBy: r.redelivered_by as string } : {}),
  }
}

export function createPostgresIntakeInbox(connectionString: string): ImIntakeInbox & { close(): Promise<void> } {
  const store: PgPool = createPgPool(connectionString, INTAKE_SCHEMA_STATEMENTS)
  const inbox: ImIntakeInbox & { close(): Promise<void> } = {
    async accept(event: InboundEvent, at?: number): Promise<IntakeAcceptResult> {
      const now = at ?? Date.now()
      const seqRows = await store.query(
        `INSERT INTO im_intake_counters (k, v) VALUES ('im_intake', 1)
         ON CONFLICT (k) DO UPDATE SET v = im_intake_counters.v + 1
         RETURNING v`,
        [],
      )
      const seq = Number(seqRows.rows[0]!.v)
      const inserted = await store.query(
        `INSERT INTO im_intake (id, provider, event_id, seq, event, accepted_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (provider, event_id) DO NOTHING
         RETURNING *`,
        [randomUUID(), event.provider, event.eventId, seq, JSON.stringify(event), now],
      )
      const row = inserted.rows[0]
      if (row) return { record: rowToRecord(row), duplicate: false }
      const existing = await store.q('SELECT * FROM im_intake WHERE provider = $1 AND event_id = $2', [
        event.provider,
        event.eventId,
      ])
      if (!existing[0]) throw new Error(`intake accept lost a race for ${event.provider}:${event.eventId}`)
      return { record: rowToRecord(existing[0]!), duplicate: true }
    },
    async get(id) {
      const rows = await store.q('SELECT * FROM im_intake WHERE id = $1', [id])
      return rows[0] ? rowToRecord(rows[0]!) : null
    },
    async latestSeq() {
      // Highest seq actually attached to a record: the counter may run
      // ahead when an accept loses the dedup insert race, and cursors
      // must only chase records that exist.
      const rows = await store.q('SELECT COALESCE(MAX(seq), 0) AS seq FROM im_intake', [])
      return Number(rows[0]!.seq)
    },
    async listAfterSeq(after, limit) {
      const rows = await store.q(
        'SELECT * FROM im_intake WHERE seq > $1 ORDER BY seq ASC' + (limit !== undefined ? ' LIMIT $2' : ''),
        limit !== undefined ? [after, limit] : [after],
      )
      return rows.map(rowToRecord)
    },
    async list(options) {
      const limit = Math.max(1, options?.limit ?? 100)
      const rows = await store.q('SELECT * FROM im_intake ORDER BY seq DESC LIMIT $1', [limit])
      return rows.map(rowToRecord)
    },
    async markTurn(id, turnId) {
      const won = await store.query(
        'UPDATE im_intake SET turn_id = $2 WHERE id = $1 AND turn_id IS NULL RETURNING id',
        [id, turnId],
      )
      return won.rows.length > 0
    },
    async close() {
      await store.close()
    },
  }
  return inbox
}

export function createPostgresIntakeCursorStore(connectionString: string): ImIntakeCursorStore & { close(): Promise<void> } {
  const store: PgPool = createPgPool(connectionString, INTAKE_SCHEMA_STATEMENTS)
  return {
    async get(subscriber) {
      const rows = await store.q('SELECT seq FROM im_intake_cursors WHERE subscriber = $1', [subscriber])
      return rows[0] ? Number(rows[0]!.seq) : null
    },
    async advance(subscriber, seq, at) {
      await store.query(
        `INSERT INTO im_intake_cursors (subscriber, seq, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (subscriber) DO UPDATE
           SET seq = GREATEST(im_intake_cursors.seq, EXCLUDED.seq), updated_at = EXCLUDED.updated_at`,
        [subscriber, seq, at ?? Date.now()],
      )
    },
    async close() {
      await store.close()
    },
  }
}

export function createPostgresIntakeDeadLetterStore(
  connectionString: string,
): ImIntakeDeadLetterStore & { close(): Promise<void> } {
  const store: PgPool = createPgPool(connectionString, INTAKE_SCHEMA_STATEMENTS)
  return {
    async record(letter) {
      await store.query(
        `INSERT INTO im_intake_dead_letters
           (id, subscriber, intake_id, provider, event_id, seq, attempts, last_error, failed_at, redelivery_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (subscriber, intake_id) DO NOTHING`,
        [
          letter.id,
          letter.subscriber,
          letter.intakeId,
          letter.provider,
          letter.eventId,
          letter.seq,
          letter.attempts,
          letter.lastError,
          letter.failedAt,
          letter.redeliveryUrl,
        ],
      )
    },
    async get(id) {
      const rows = await store.q('SELECT * FROM im_intake_dead_letters WHERE id = $1', [id])
      return rows[0] ? rowToLetter(rows[0]!) : null
    },
    async list(options) {
      const limit = Math.max(1, options?.limit ?? 100)
      const rows = options?.subscriber !== undefined
        ? await store.q(
            'SELECT * FROM im_intake_dead_letters WHERE subscriber = $1 ORDER BY failed_at DESC LIMIT $2',
            [options.subscriber, limit],
          )
        : await store.q('SELECT * FROM im_intake_dead_letters ORDER BY failed_at DESC LIMIT $1', [limit])
      return rows.map(rowToLetter)
    },
    async markRedelivered(id, opts) {
      const won = await store.query(
        `UPDATE im_intake_dead_letters
            SET redelivered_at = $2, redelivered_by = $3
          WHERE id = $1 AND redelivered_at IS NULL
          RETURNING id`,
        [id, opts.at ?? Date.now(), opts.actor],
      )
      return won.rows.length > 0
    },
    async close() {
      await store.close()
    },
  }
}
