/**
 * Postgres SessionStore for the frozen M1 contract subset. Session mutation
 * serializes on a per-session advisory transaction lock; append requires a
 * live lease and extends it (qm semantics). P1 adds the tape and LLM
 * request record groups; search and admin listings remain deferred.
 */
import { createHash, randomUUID } from 'node:crypto'
import type {
  GetEntriesOptions,
  GetTapeOptions,
  Lease,
  LeaseAttempt,
  LeaseHolder,
  LlmRequestRecord,
  ListLlmRequestsOptions,
  NewEntry,
  NewLlmRequest,
  NewTapeRecord,
  ParticipantWindow,
  ScopeId,
  Session,
   SessionEntryHit,
   SessionEntry,
   SessionForkResult,
   SessionPatch,
   SessionRef,
   SessionStore,
   SessionType,
   TapeRecord,
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
    ...(r.archived != null ? { archived: Boolean(r.archived) } : {}),
    ...(r.pinned != null ? { pinned: Boolean(r.pinned) } : {}),
    ...(r.color !== undefined ? { color: (r.color as string | null) ?? null } : {}),
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

function rowToTape(r: Record<string, unknown>): TapeRecord {
  return {
    sessionId: r.session_id as string,
    seq: Number(r.seq),
    createdAt: Number(r.created_at),
    kind: r.kind as TapeRecord['kind'],
    payload: r.payload != null ? JSON.parse(r.payload as string) : null,
    scopeLabel: r.scope_label as ScopeId,
    ...(r.harness != null ? { harness: r.harness as string } : {}),
    ...(r.meta != null ? { meta: JSON.parse(r.meta as string) } : {}),
    ...(r.entry_seq != null ? { entrySeq: Number(r.entry_seq) } : {}),
    ...(r.covers_entry_seq != null ? { coversEntrySeq: Number(r.covers_entry_seq) } : {}),
  }
}

function jsonOrNull(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v)
}

function rowToLlmRequest(r: Record<string, unknown>): LlmRequestRecord {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    turnSeq: r.turn_seq === null || r.turn_seq === undefined ? null : Number(r.turn_seq),
    step: Number(r.step),
    model: r.model as string,
    scopeLabel: r.scope_label as ScopeId,
    createdAt: Number(r.created_at),
    request: r.request != null ? JSON.parse(r.request as string) : null,
    promptHash: (r.prompt_hash as string | null) ?? null,
    promptEnvelope: r.prompt_envelope != null ? JSON.parse(r.prompt_envelope as string) : null,
    truncated: Boolean(r.truncated),
    ttftMs: r.ttft_ms === null || r.ttft_ms === undefined ? null : Number(r.ttft_ms),
    durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
    stepGapMs: r.step_gap_ms === null || r.step_gap_ms === undefined ? null : Number(r.step_gap_ms),
    toolWallMs: r.tool_wall_ms != null ? JSON.parse(r.tool_wall_ms as string) : null,
    gapPhases: r.gap_phases != null ? JSON.parse(r.gap_phases as string) : null,
    usage: r.usage != null ? JSON.parse(r.usage as string) : null,
    transport: r.transport != null ? JSON.parse(r.transport as string) : null,
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

    // --- M-Tape-1 projection readers ---

    async getTranscriptEntries(sessionId, opts?: GetEntriesOptions): Promise<SessionEntry[]> {
      const since = opts?.sinceSeq ?? 0
      const before = opts?.beforeSeq
      const limit = opts?.limit
      if (limit === 0) return []
      const params: unknown[] = [sessionId, since]
      let where = 'WHERE session_id = $1 AND seq >= $2'
      if (before !== undefined) {
        params.push(before)
        where += ` AND seq < $${params.length}`
      }
      let order = 'ORDER BY seq ASC'
      let suffix = ''
      if (limit !== undefined) {
        params.push(limit)
        suffix = ` LIMIT $${params.length}`
      }
      const rows = await q(`SELECT * FROM session_entries ${where} ${order}${suffix}`, params)
      return rows.map(rowToEntry)
    },

    async canReadTranscriptSuffix(sessionId, beforeSeq): Promise<boolean> {
      if (beforeSeq <= 0) return true
      const rows = await q(
        `SELECT seq, type FROM session_entries WHERE session_id = $1 AND seq < $2 ORDER BY seq ASC`,
        [sessionId, beforeSeq],
      )
      if (rows.length !== beforeSeq) return false
      return rows.every((r) => r.type !== 'soul')
    },

    async latestEntrySeq(sessionId): Promise<number> {
      const rows = await q(
        'SELECT COALESCE(MAX(seq), -1) AS m FROM session_entries WHERE session_id = $1',
        [sessionId],
      )
      return Number(rows[0]!.m)
    },

    async appendTape(lease, rec: NewTapeRecord): Promise<TapeRecord> {
      return withLease(lease, 'appendTape without a valid session lease', async (client) => {
        const max = await client.query(
          'SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM session_tape WHERE session_id = $1',
          [lease.sessionId],
        )
        const seq = Number(max.rows[0]!.n)
        const createdAt = now()
        const full: TapeRecord = {
          sessionId: lease.sessionId,
          seq,
          createdAt,
          kind: rec.kind,
          payload: rec.payload,
          scopeLabel: rec.scopeLabel as ScopeId,
          ...(rec.harness ? { harness: rec.harness } : {}),
          ...(rec.meta ? { meta: rec.meta } : {}),
          ...(rec.entrySeq !== undefined ? { entrySeq: rec.entrySeq } : {}),
          ...(rec.coversEntrySeq !== undefined ? { coversEntrySeq: rec.coversEntrySeq } : {}),
        }
        await client.query(
          `INSERT INTO session_tape(session_id, seq, kind, payload, scope_label, harness, meta, entry_seq, covers_entry_seq, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            full.sessionId,
            full.seq,
            full.kind,
            jsonOrNull(full.payload),
            full.scopeLabel,
            full.harness ?? null,
            jsonOrNull(full.meta),
            full.entrySeq ?? null,
            full.coversEntrySeq ?? null,
            full.createdAt,
          ],
        )
        return full
      })
    },

    async getTape(sessionId, opts?: GetTapeOptions): Promise<TapeRecord[]> {
      const since = opts?.sinceSeq ?? 0
      if (opts?.limit !== undefined) {
        const rows = await q(
          'SELECT * FROM session_tape WHERE session_id = $1 AND seq >= $2 ORDER BY seq DESC LIMIT $3',
          [sessionId, since, opts.limit],
        )
        return rows.map(rowToTape).reverse()
      }
      const rows = await q('SELECT * FROM session_tape WHERE session_id = $1 AND seq >= $2 ORDER BY seq ASC', [
        sessionId,
        since,
      ])
      return rows.map(rowToTape)
    },

    async recordLlmRequest(sessionId, rec: NewLlmRequest, _signal?: AbortSignal): Promise<LlmRequestRecord> {
      const id = randomUUID()
      const createdAt = now()
      const request = jsonOrNull(rec.promptEnvelope)
      const promptHash =
        rec.promptEnvelope === undefined || rec.promptEnvelope === null
          ? null
          : createHash('sha256').update(JSON.stringify(rec.promptEnvelope)).digest('hex').slice(0, 16)
      await q(
        `INSERT INTO llm_requests(id, session_id, turn_seq, step, model, scope_label, created_at,
             request, prompt_hash, prompt_envelope, truncated, ttft_ms, duration_ms, step_gap_ms,
             tool_wall_ms, gap_phases, usage, transport)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          id,
          sessionId,
          rec.turnSeq,
          rec.step,
          rec.model,
          rec.scopeLabel,
          createdAt,
          request,
          promptHash,
          request,
          rec.truncated ?? false,
          rec.ttftMs ?? null,
          rec.durationMs ?? null,
          rec.stepGapMs ?? null,
          jsonOrNull(rec.toolWallMs ?? null),
          jsonOrNull(rec.gapPhases ?? null),
          jsonOrNull(rec.usage ?? null),
          jsonOrNull(rec.transport ?? null),
        ],
      )
      return {
        id,
        sessionId,
        turnSeq: rec.turnSeq,
        step: rec.step,
        model: rec.model,
        scopeLabel: rec.scopeLabel as ScopeId,
        createdAt,
        request: rec.promptEnvelope ?? null,
        promptHash,
        promptEnvelope: rec.promptEnvelope,
        truncated: rec.truncated ?? false,
        ttftMs: rec.ttftMs ?? null,
        durationMs: rec.durationMs ?? null,
        stepGapMs: rec.stepGapMs ?? null,
        toolWallMs: rec.toolWallMs ?? null,
        gapPhases: rec.gapPhases ?? null,
        usage: rec.usage ?? null,
        transport: rec.transport ?? null,
      }
    },

    async listLlmRequests(sessionId, opts?: ListLlmRequestsOptions): Promise<LlmRequestRecord[]> {
      const clauses: string[] = ['session_id = $1']
      const params: unknown[] = [sessionId]
      if (opts?.turnSeqs !== undefined) {
        params.push(opts.turnSeqs)
        clauses.push(`turn_seq = ANY($${params.length}::int[])`)
      }
      if (opts?.orphans) clauses.push('turn_seq IS NULL')
      const select = opts?.omitRequest
        ? 'id, session_id, turn_seq, step, model, scope_label, created_at, NULL AS request, prompt_hash, prompt_envelope, truncated, ttft_ms, duration_ms, step_gap_ms, tool_wall_ms, gap_phases, usage, transport'
        : '*'
      const rows = await q(
        `SELECT ${select} FROM llm_requests WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`,
        params,
      )
      return rows.map(rowToLlmRequest)
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

    async visibleEntries(sessionId, principalId): Promise<SessionEntry[]> {
      const winRows = await q(
        `SELECT valid_from, valid_to, valid_from_seq, valid_to_seq
           FROM participants WHERE session_id = $1 AND principal_id = $2`,
        [sessionId, principalId],
      )
      const win = winRows[0]
      if (!win) return []
      const validFrom = Number(win.valid_from)
      const validTo = win.valid_to === null ? null : Number(win.valid_to)
      const validFromSeq = win.valid_from_seq === null ? null : Number(win.valid_from_seq)
      const validToSeq = win.valid_to_seq === null ? null : Number(win.valid_to_seq)
      const params: unknown[] = [sessionId]
      const conds: string[] = ['session_id = $1']
      if (validFromSeq !== null) {
        params.push(validFromSeq)
        conds.push(`seq >= $${params.length}`)
      } else {
        params.push(validFrom)
        conds.push(`created_at >= $${params.length}`)
      }
      if (validToSeq !== null) {
        params.push(validToSeq)
        conds.push(`seq < $${params.length}`)
      } else if (validTo !== null) {
        params.push(validTo)
        conds.push(`created_at < $${params.length}`)
      }
      const rows = await q(
        `SELECT * FROM session_entries WHERE ${conds.join(' AND ')} ORDER BY seq ASC`,
        params,
      )
      return rows.map(rowToEntry)
    },

    async participantWindowsOf(sessionId): Promise<ParticipantWindow[]> {
      const rows = await q(
        `SELECT principal_id, valid_from, valid_to, valid_from_seq, valid_to_seq
           FROM participants WHERE session_id = $1`,
        [sessionId],
      )
      return rows.map((r) => ({
        sessionId,
        principalId: r.principal_id as string,
        validFrom: Number(r.valid_from),
        validTo: r.valid_to === null ? null : Number(r.valid_to),
        validFromSeq: r.valid_from_seq === null ? null : Number(r.valid_from_seq),
        validToSeq: r.valid_to_seq === null ? null : Number(r.valid_to_seq),
      }))
    },

    async listByParticipant(principalId): Promise<Session[]> {
      const rows = await q(
        `SELECT s.* FROM sessions s
           JOIN participants p ON p.session_id = s.id AND p.principal_id = $1 AND p.valid_to IS NULL
          ORDER BY s.created_at DESC`,
        [principalId],
      )
      return rows.map(rowToSession)
    },

    async searchEntries(principalId, query, limit = 20): Promise<SessionEntryHit[]> {
      const term = `%${query.trim().toLowerCase()}%`
      if (query.trim() === '') return []
      const rows = await q(
        `SELECT e.session_id, e.seq, e.type, e.payload, e.created_at
           FROM session_entries e
           JOIN participants p ON p.session_id = e.session_id
                AND p.principal_id = $1 AND p.valid_to IS NULL
          WHERE LOWER(e.payload) LIKE $2
          ORDER BY e.created_at DESC LIMIT $3`,
        [principalId, term, limit],
      )
      return rows.map((r) => {
        const payload = r.payload != null ? JSON.parse(r.payload as string) : null
        const text = typeof payload === 'string' ? payload : typeof (payload as { text?: unknown })?.text === 'string' ? (payload as { text: string }).text : ''
        return {
          sessionId: r.session_id as string,
          seq: Number(r.seq),
          type: r.type as SessionEntryHit['type'],
          text,
          createdAt: Number(r.created_at),
        }
      })
    },

    async patchSession(sessionId, patch: SessionPatch): Promise<Session | null> {
      const sets: string[] = []
      const params: unknown[] = []
      if (patch.title !== undefined) {
        params.push(patch.title)
        sets.push(`title = $${params.length}`)
      }
      if (patch.archived !== undefined) {
        params.push(patch.archived)
        sets.push(`archived = $${params.length}`)
      }
      if (patch.pinned !== undefined) {
        params.push(patch.pinned)
        sets.push(`pinned = $${params.length}`)
      }
      if (patch.color !== undefined) {
        params.push(patch.color)
        sets.push(`color = $${params.length}`)
      }
      if (!sets.length) return this.get(sessionId)
      params.push(sessionId)
      const rows = await q(
        `UPDATE sessions SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params,
      )
      return rows[0] ? rowToSession(rows[0]) : null
    },

    async forkSession(sessionId, by, opts?): Promise<SessionForkResult | null> {
      return withPgTransaction(await store.pool(), async (client) => {
        await lockSession(client, sessionId)
        const origRows = await client.query('SELECT * FROM sessions WHERE id = $1', [sessionId])
        const orig = origRows.rows[0]
        if (!orig) return null
        const upTo = opts?.upToSeq ?? Number((await client.query('SELECT COALESCE(MAX(seq), -1) AS m FROM session_entries WHERE session_id = $1', [sessionId])).rows[0]!.m)
        const copiedRows = await client.query(
          'SELECT seq, parent_seq, type, payload, scope_label, created_at FROM session_entries WHERE session_id = $1 AND seq <= $2 ORDER BY seq',
          [sessionId, upTo],
        )
        const forkId = randomUUID()
        const forkRef = `fork:${sessionId}:${randomUUID().slice(0, 8)}`
        await client.query(
          `INSERT INTO sessions(id, type, scope_id, thread_ref, created_at, title, channel_name, surface, archived, pinned, color)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE,FALSE,$9)`,
          [forkId, orig.type, orig.scope_id, forkRef, now(), orig.title ?? null, orig.channel_name ?? null, orig.surface ?? null, orig.color ?? null],
        )
        for (const row of copiedRows.rows) {
          await client.query(
            'INSERT INTO session_entries(session_id, seq, parent_seq, type, payload, scope_label, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [forkId, Number(row.seq), row.parent_seq === null ? null : Number(row.parent_seq), row.type, row.payload, row.scope_label, Number(row.created_at)],
          )
        }
        await client.query(
          'INSERT INTO participants(session_id, principal_id, valid_from, valid_to, valid_from_seq, valid_to_seq) VALUES ($1,$2,$3,NULL,$4,NULL) ON CONFLICT (session_id, principal_id) DO NOTHING',
          [forkId, by, now(), copiedRows.rows.length],
        )
        const forkRows = await client.query('SELECT * FROM sessions WHERE id = $1', [forkId])
        return { session: rowToSession(forkRows.rows[0]!), entriesCopied: copiedRows.rows.length }
      })
    },

    async discardSession(sessionId, by): Promise<boolean> {
      return withPgTransaction(await store.pool(), async (client) => {
        await lockSession(client, sessionId)
        const member = await client.query(
          'SELECT 1 FROM participants WHERE session_id = $1 AND principal_id = $2 AND valid_to IS NULL',
          [sessionId, by],
        )
        if (!member.rows[0]) return false
        await client.query('DELETE FROM session_entries WHERE session_id = $1', [sessionId])
        await client.query('DELETE FROM session_tape WHERE session_id = $1', [sessionId])
        await client.query('DELETE FROM llm_requests WHERE session_id = $1', [sessionId])
        await client.query('DELETE FROM session_leases WHERE session_id = $1', [sessionId])
        await client.query('DELETE FROM participants WHERE session_id = $1', [sessionId])
        await client.query('DELETE FROM sessions WHERE id = $1', [sessionId])
        return true
      })
    },

    async sessionsByThreadRefs(threadRefs): Promise<SessionRef[]> {
      if (threadRefs.length === 0) return []
      const rows = await q('SELECT id, thread_ref, scope_id, type, title FROM sessions WHERE thread_ref = ANY($1)', [
        [...new Set(threadRefs)],
      ])
      return rows.map((r) => ({
        id: r.id as string,
        threadRef: r.thread_ref as string,
        scopeId: r.scope_id as ScopeId,
        type: r.type as SessionType,
        title: (r.title as string | null) ?? null,
      }))
    },

    async close(): Promise<void> {
      await store.close()
    },
  }
}
