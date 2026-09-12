/**
 * Postgres SessionStore for the frozen M1 contract subset. Session mutation
 * serializes on a per-session advisory transaction lock; append requires a
 * live lease and extends it (qm semantics). Translated from qm's
 * postgres-session-store minus tape, LLM records, search and admin listings.
 */
import { randomUUID } from 'node:crypto'
import type {
  GetEntriesOptions,
  Lease,
  LeaseAttempt,
  LeaseHolder,
  NewEntry,
  ScopeId,
  Session,
  SessionEntry,
  SessionStore,
  SessionType,
} from '@qm/types'
import { createPgPool, withPgTransaction, type PgPool, type PoolClient } from './pg-pool.ts'
import { SESSION_SCHEMA_STATEMENTS } from './schema.ts'

export interface PostgresStoreOptions {
  now?: () => number
  leaseTtlMs?: number
}

function rowToSession(r: Record<string, unknown>): Session {
  return {
    id: r.id as string,
    type: r.type as SessionType,
    scopeId: r.scope_id as ScopeId,
    threadRef: r.thread_ref as string,
    surface: (r.surface as string | null) ?? '',
    createdAt: Number(r.created_at),
    ...(r.title != null ? { title: r.title as string } : {}),
    ...(r.channel_name != null ? { channelName: r.channel_name as string } : {}),
    ...(r.last_activity != null ? { lastActivityAt: Number(r.last_activity) } : {}),
  }
}

function rowToEntry(r: Record<string, unknown>): SessionEntry {
  return {
    sessionId: r.session_id as string,
    seq: Number(r.seq),
    parentSeq: r.parent_seq === null ? null : Number(r.parent_seq),
    type: r.type as SessionEntry['type'],
    payload: r.payload != null ? JSON.parse(r.payload as string) : null,
    scopeLabel: r.scope_label as ScopeId,
    createdAt: Number(r.created_at),
  }
}

export interface PostgresSessionStore extends SessionStore {
  close(): Promise<void>
}

export function createPostgresSessionStore(
  connectionString: string,
  opts: PostgresStoreOptions = {},
): PostgresSessionStore {
  const now = opts.now ?? (() => Date.now())
  const leaseTtlMs = opts.leaseTtlMs ?? 5 * 60_000
  const store: PgPool = createPgPool(connectionString, SESSION_SCHEMA_STATEMENTS)
  const { q } = store

  const lockSession = (client: PoolClient, sessionId: string) =>
    client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [sessionId])

  const withLease = async <T>(lease: Lease, invalidMsg: string, fn: (client: PoolClient) => Promise<T>): Promise<T> =>
    withPgTransaction(await store.pool(), async (client) => {
      await lockSession(client, lease.sessionId)
      const held = await client.query('SELECT token FROM session_leases WHERE session_id = $1 FOR UPDATE', [
        lease.sessionId,
      ])
      if (held.rows[0]?.token !== lease.token) throw new Error(invalidMsg)
      await client.query('UPDATE session_leases SET expires_at = $2 WHERE session_id = $1', [
        lease.sessionId,
        now() + leaseTtlMs,
      ])
      return fn(client)
    })

  return {
    async getOrCreateByThread(threadRef, type, scopeId, surface, channelName): Promise<Session> {
      const existing = await q('SELECT * FROM sessions WHERE thread_ref = $1', [threadRef])
      if (existing[0]) {
        const s = rowToSession(existing[0])
        if (channelName && s.channelName !== channelName) {
          await q('UPDATE sessions SET channel_name = $2 WHERE id = $1', [s.id, channelName])
          s.channelName = channelName
        }
        if (!s.surface) {
          await q('UPDATE sessions SET surface = $2 WHERE id = $1', [s.id, surface])
          s.surface = surface
        }
        return s
      }
      const createdAt = now()
      await q(
        'INSERT INTO sessions(id, type, scope_id, thread_ref, created_at, channel_name, surface) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (thread_ref) DO NOTHING',
        [randomUUID(), type, scopeId, threadRef, createdAt, channelName ?? null, surface],
      )
      const rows = await q('SELECT * FROM sessions WHERE thread_ref = $1', [threadRef])
      return rowToSession(rows[0]!)
    },

    async getByThread(threadRef): Promise<Session | null> {
      const rows = await q('SELECT * FROM sessions WHERE thread_ref = $1', [threadRef])
      return rows[0] ? rowToSession(rows[0]) : null
    },

    async get(id): Promise<Session | null> {
      const rows = await q('SELECT * FROM sessions WHERE id = $1', [id])
      return rows[0] ? rowToSession(rows[0]) : null
    },

    async updateTitle(sessionId, title): Promise<void> {
      await q('UPDATE sessions SET title = $2 WHERE id = $1', [sessionId, title])
    },

    async acquireLease(sessionId, holder): Promise<LeaseAttempt> {
      const token = randomUUID()
      const t = now()
      return withPgTransaction(await store.pool(), async (client) => {
        await lockSession(client, sessionId)
        const granted = await client.query(
          `INSERT INTO session_leases(session_id, token, expires_at, holder, acquired_at)
             SELECT $1, $2, $3, $5, $4 WHERE EXISTS (SELECT 1 FROM sessions WHERE id = $1)
           ON CONFLICT (session_id) DO UPDATE
             SET token = $2, expires_at = $3, holder = $5, acquired_at = $4
             WHERE session_leases.expires_at <= $4
           RETURNING token`,
          [sessionId, token, t + leaseTtlMs, t, holder ?? null],
        )
        if (granted.rows[0]) return { lease: { sessionId, token } }
        const held = await client.query(
          'SELECT expires_at, holder, acquired_at FROM session_leases WHERE session_id = $1',
          [sessionId],
        )
        const row = held.rows[0]
        if (!row) return { lease: null }
        return {
          lease: null,
          ...(row.holder != null ? { heldBy: row.holder as LeaseHolder } : {}),
          ...(row.acquired_at != null ? { heldSince: Number(row.acquired_at) } : {}),
          heldUntil: Number(row.expires_at),
        }
      })
    },

    async releaseLease(lease): Promise<void> {
      await q('DELETE FROM session_leases WHERE session_id = $1 AND token = $2', [lease.sessionId, lease.token])
    },

    async forceReleaseLease(sessionId): Promise<void> {
      await q('DELETE FROM session_leases WHERE session_id = $1', [sessionId])
    },

    async append(lease, entry: NewEntry): Promise<SessionEntry> {
      return withLease(lease, 'append without a valid session lease', async (client) => {
        const max = await client.query(
          'SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM session_entries WHERE session_id = $1',
          [lease.sessionId],
        )
        const seq = Number(max.rows[0]!.n)
        const stored = JSON.stringify(entry.payload ?? null)
        const full: SessionEntry = {
          sessionId: lease.sessionId,
          seq,
          parentSeq: seq === 0 ? null : seq - 1,
          type: entry.type,
          payload: JSON.parse(stored),
          scopeLabel: entry.scopeLabel as ScopeId,
          createdAt: now(),
        }
        await client.query(
          'INSERT INTO session_entries(session_id, seq, parent_seq, type, payload, scope_label, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [full.sessionId, full.seq, full.parentSeq, full.type, stored, full.scopeLabel, full.createdAt],
        )
        await client.query('UPDATE sessions SET last_activity = GREATEST(COALESCE(last_activity, 0), $2) WHERE id = $1', [
          full.sessionId,
          full.createdAt,
        ])
        return full
      })
    },

    async getEntries(sessionId, opts?: GetEntriesOptions): Promise<SessionEntry[]> {
      const since = opts?.sinceSeq ?? 0
      if (opts?.limit !== undefined) {
        const rows = await q(
          'SELECT * FROM session_entries WHERE session_id = $1 AND seq >= $2 ORDER BY seq DESC LIMIT $3',
          [sessionId, since, opts.limit],
        )
        return rows.map(rowToEntry).reverse()
      }
      const rows = await q('SELECT * FROM session_entries WHERE session_id = $1 AND seq >= $2 ORDER BY seq ASC', [
        sessionId,
        since,
      ])
      return rows.map(rowToEntry)
    },

    async addParticipant(sessionId, principalId): Promise<void> {
      await q(
        `WITH boundary AS (
           SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM session_entries WHERE session_id = $1
         )
         INSERT INTO participants(session_id, principal_id, valid_from, valid_to, valid_from_seq, valid_to_seq)
         SELECT $1,$2,$3,NULL,boundary.seq,NULL FROM boundary
         ON CONFLICT (session_id, principal_id) DO UPDATE
           SET valid_from = EXCLUDED.valid_from,
               valid_from_seq = EXCLUDED.valid_from_seq,
               valid_to = NULL,
               valid_to_seq = NULL
         WHERE participants.valid_to IS NOT NULL`,
        [sessionId, principalId, now()],
      )
    },

    async removeParticipant(sessionId, principalId): Promise<void> {
      await q(
        'UPDATE participants SET valid_to = $3, valid_to_seq = (SELECT COALESCE(MAX(seq) + 1, 0) FROM session_entries WHERE session_id = $1) WHERE session_id = $1 AND principal_id = $2 AND valid_to IS NULL',
        [sessionId, principalId, now()],
      )
    },

    async participantsOf(sessionId): Promise<string[]> {
      const rows = await q(
        'SELECT principal_id FROM participants WHERE session_id = $1 AND valid_to IS NULL',
        [sessionId],
      )
      return rows.map((r) => r.principal_id as string)
    },

    async close(): Promise<void> {
      await store.close()
    },
  }
}
