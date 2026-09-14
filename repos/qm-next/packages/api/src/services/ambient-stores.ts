/**
 * Durable ambient stores (14.0): the Postgres ambient-judgment store over
 * @qm/store's pool (qm `ambient_judgments` table, org-scoped), and the
 * ambient-cursor adapter over a DurableMap (qm `ambient_cursors` artifact
 * map). Memory twins live in @qm/approvals; both satisfy the same ports.
 */
import {
  createMemoryMap,
  createPostgresMap,
  createPgPool,
  type DurableMap,
} from '@qm/store'
import type {
  AckEmojiPick,
  AckEmojiPickStore,
  AckPickOutcome,
  AgentRequestRecord,
  AgentRequestStore,
  AgentRequestStatus,
  AmbientCursorStore,
  AmbientDecisionKind,
  AmbientJudgment,
  AmbientJudgmentCounts,
  AmbientJudgmentStore,
} from '@qm/approvals'
import type { Destination } from '@qm/types'

const emptyCounts = (): AmbientJudgmentCounts => ({ act: 0, ignore: 0, fastlane: 0 })
const emptyPickCounts = (): { picked: number; declined: number } => ({ picked: 0, declined: 0 })

export function createPostgresAmbientJudgmentStore(connectionString: string, orgId: string): AmbientJudgmentStore {
  const { q, close } = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS ambient_judgments(
        id BIGSERIAL PRIMARY KEY,
        org_id TEXT NOT NULL, surface TEXT NOT NULL, container TEXT NOT NULL,
        decision TEXT NOT NULL, reason TEXT, asked_by TEXT, prompt TEXT, model TEXT,
        latency_ms INT, ts_from TEXT, ts_to TEXT, created_at BIGINT NOT NULL
      )`,
    `ALTER TABLE ambient_judgments ADD COLUMN IF NOT EXISTS asked_by TEXT`,
    `CREATE INDEX IF NOT EXISTS ambient_judgments_org_container_created
        ON ambient_judgments(org_id, container, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ambient_judgments_org_created
        ON ambient_judgments(org_id, created_at DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS ambient_judgments_org_decision
        ON ambient_judgments(org_id, decision)`,
  ])
  const row = (r: Record<string, unknown>): AmbientJudgment => ({
    id: Number(r.id),
    surface: r.surface as string,
    container: r.container as string,
    decision: r.decision as AmbientDecisionKind,
    ...(r.reason != null ? { reason: r.reason as string } : {}),
    ...(r.asked_by != null ? { askedBy: r.asked_by as string } : {}),
    ...(r.prompt != null ? { prompt: r.prompt as string } : {}),
    ...(r.model != null ? { model: r.model as string } : {}),
    ...(r.latency_ms != null ? { latencyMs: Number(r.latency_ms) } : {}),
    ...(r.ts_from != null ? { tsFrom: r.ts_from as string } : {}),
    ...(r.ts_to != null ? { tsTo: r.ts_to as string } : {}),
    createdAt: Number(r.created_at),
  })
  return {
    async record(j) {
      await q(
        `INSERT INTO ambient_judgments(org_id, surface, container, decision, reason, asked_by, prompt, model, latency_ms, ts_from, ts_to, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          orgId,
          j.surface,
          j.container,
          j.decision,
          j.reason ?? null,
          j.askedBy ?? null,
          j.prompt ?? null,
          j.model ?? null,
          j.latencyMs ?? null,
          j.tsFrom ?? null,
          j.tsTo ?? null,
          j.createdAt,
        ],
      )
    },
    async list(opts) {
      const limit = Math.max(1, Math.min(1000, opts?.limit ?? 100))
      const where = ['org_id = $1']
      const args: unknown[] = [orgId]
      if (opts?.container) {
        args.push(opts.container)
        where.push(`container = $${args.length}`)
      }
      if (opts?.decision?.length) {
        const ph = opts.decision.map((d) => {
          args.push(d)
          return `$${args.length}`
        })
        where.push(`decision IN (${ph.join(',')})`)
      }
      if (opts?.before != null) {
        args.push(opts.before)
        const c = `$${args.length}`
        if (opts.beforeId != null) {
          args.push(opts.beforeId)
          where.push(`(created_at < ${c} OR (created_at = ${c} AND id < $${args.length}))`)
        } else {
          where.push(`created_at < ${c}`)
        }
      }
      args.push(limit)
      const rows = await q(
        `SELECT id, org_id, surface, container, decision, reason, asked_by, model, latency_ms, ts_from, ts_to, created_at
         FROM ambient_judgments WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${args.length}`,
        args,
      )
      return rows.map(row)
    },
    async get(id) {
      const rows = await q('SELECT * FROM ambient_judgments WHERE org_id = $1 AND id = $2', [orgId, id])
      return rows[0] ? row(rows[0]) : null
    },
    async counts(opts) {
      const args: unknown[] = [orgId]
      let where = 'org_id = $1'
      if (opts?.container) {
        args.push(opts.container)
        where += ` AND container = $${args.length}`
      }
      const rows = await q(
        `SELECT decision, COUNT(*)::int AS n FROM ambient_judgments WHERE ${where} GROUP BY decision`,
        args,
      )
      const out = emptyCounts()
      for (const r of rows) if ((r.decision as string) in out) out[r.decision as AmbientDecisionKind] = Number(r.n)
      return out
    },
    close,
  }
}

/** Adapter: any DurableMap (memory or PG jsonb) satisfies the cursor port. */
export function ambientCursorStoreFrom(map: DurableMap<{ lastJudgedTs: string; lastJudgedAt?: number }>): AmbientCursorStore {
  return {
    get: (key) => map.get(key),
    put: (key, value) => map.put(key, value),
  }
}

export function createAmbientCursorStore(databaseUrl: string | undefined, orgId: string): AmbientCursorStore {
  if (!databaseUrl) return ambientCursorStoreFrom(createMemoryMap())
  const pool = createPgPool(databaseUrl, [])
  const map = createPostgresMap<{ lastJudgedTs: string; lastJudgedAt?: number }>(pool, 'ambient_cursors')
  return {
    get: (key) => map.get(`${orgId}:${key}`),
    put: (key, value) => map.put(`${orgId}:${key}`, value),
  }
}

export function createPostgresAckEmojiPickStore(connectionString: string, orgId: string): AckEmojiPickStore {
  const { q, close } = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS ack_emoji_picks(
        id BIGSERIAL PRIMARY KEY,
        org_id TEXT NOT NULL, surface TEXT NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL,
        outcome TEXT NOT NULL, picked TEXT, icon TEXT, message TEXT, candidates TEXT, model TEXT,
        latency_ms INT, created_at BIGINT NOT NULL
      )`,
    `CREATE INDEX IF NOT EXISTS ack_emoji_picks_org_channel_created
        ON ack_emoji_picks(org_id, channel, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ack_emoji_picks_org_outcome
        ON ack_emoji_picks(org_id, outcome)`,
  ])
  const row = (r: Record<string, unknown>): AckEmojiPick => ({
    id: Number(r.id),
    surface: r.surface as string,
    channel: r.channel as string,
    ts: r.ts as string,
    outcome: r.outcome as AckPickOutcome,
    ...(r.picked != null ? { picked: r.picked as string } : {}),
    ...(r.icon != null ? { icon: r.icon as string } : {}),
    ...(r.message != null ? { message: r.message as string } : {}),
    ...(r.candidates != null ? { candidates: r.candidates as string } : {}),
    ...(r.model != null ? { model: r.model as string } : {}),
    ...(r.latency_ms != null ? { latencyMs: Number(r.latency_ms) } : {}),
    createdAt: Number(r.created_at),
  })
  return {
    async record(p) {
      await q(
        `INSERT INTO ack_emoji_picks(org_id, surface, channel, ts, outcome, picked, icon, message, candidates, model, latency_ms, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          orgId,
          p.surface,
          p.channel,
          p.ts,
          p.outcome,
          p.picked ?? null,
          p.icon ?? null,
          p.message ?? null,
          p.candidates ?? null,
          p.model ?? null,
          p.latencyMs ?? null,
          p.createdAt,
        ],
      )
    },
    async list(opts) {
      const limit = Math.max(1, Math.min(1000, opts?.limit ?? 50))
      const where = ['org_id = $1']
      const args: unknown[] = [orgId]
      if (opts?.channel) {
        args.push(opts.channel)
        where.push(`channel = $${args.length}`)
      }
      if (opts?.outcome?.length) {
        const ph = opts.outcome.map((o) => {
          args.push(o)
          return `$${args.length}`
        })
        where.push(`outcome IN (${ph.join(',')})`)
      }
      if (opts?.before != null) {
        args.push(opts.before)
        const c = `$${args.length}`
        if (opts.beforeId != null) {
          args.push(opts.beforeId)
          where.push(`(created_at < ${c} OR (created_at = ${c} AND id < $${args.length}))`)
        } else {
          where.push(`created_at < ${c}`)
        }
      }
      args.push(limit)
      const rows = await q(
        `SELECT id, org_id, surface, channel, ts, outcome, picked, icon, message, model, latency_ms, created_at
         FROM ack_emoji_picks WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${args.length}`,
        args,
      )
      return rows.map(row)
    },
    async get(id) {
      const rows = await q('SELECT * FROM ack_emoji_picks WHERE org_id = $1 AND id = $2', [orgId, id])
      return rows[0] ? row(rows[0]) : null
    },
    async counts(opts) {
      const args: unknown[] = [orgId]
      let where = 'org_id = $1'
      if (opts?.channel) {
        args.push(opts.channel)
        where += ` AND channel = $${args.length}`
      }
      const rows = await q(
        `SELECT outcome, COUNT(*)::int AS n FROM ack_emoji_picks WHERE ${where} GROUP BY outcome`,
        args,
      )
      const out = emptyPickCounts()
      for (const r of rows) if ((r.outcome as string) in out) out[r.outcome as AckPickOutcome] = Number(r.n)
      return out
    },
    close,
  }
}

interface AgentRequestRow extends Record<string, unknown> {
  request_id: string
  origin_run_id: string
  origin_session_id: string
  provider: string
  target_user_id: string
  task: string
  requester_id: string
  requester_name: string | null
  destination: Destination
  thread_id: string | null
  reply_to_message_id: string | null
  status: AgentRequestStatus
  decided_by: string | null
  decided_at: number | null
  created_at: number
}

export function createPostgresAgentRequestStore(connectionString: string, orgId: string): AgentRequestStore {
  const { q, close } = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS agent_requests(
        request_id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL, origin_run_id TEXT NOT NULL, origin_session_id TEXT NOT NULL,
        provider TEXT NOT NULL, target_user_id TEXT NOT NULL, task TEXT NOT NULL,
        requester_id TEXT NOT NULL, requester_name TEXT,
        destination JSONB NOT NULL, thread_id TEXT, reply_to_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_at BIGINT,
        created_at BIGINT NOT NULL
      )`,
    `CREATE INDEX IF NOT EXISTS agent_requests_org_status
        ON agent_requests(org_id, status, created_at DESC)`,
  ])
  const row = (r: AgentRequestRow): AgentRequestRecord => ({
    requestId: r.request_id,
    originRunId: r.origin_run_id,
    originSessionId: r.origin_session_id,
    provider: r.provider,
    targetUserId: r.target_user_id,
    task: r.task,
    requesterId: r.requester_id,
    ...(r.requester_name != null ? { requesterName: r.requester_name } : {}),
    destination: r.destination,
    ...(r.thread_id != null ? { threadId: r.thread_id } : {}),
    ...(r.reply_to_message_id != null ? { replyToMessageId: r.reply_to_message_id } : {}),
    status: r.status,
    ...(r.decided_by != null ? { decidedBy: r.decided_by } : {}),
    ...(r.decided_at != null ? { decidedAt: Number(r.decided_at) } : {}),
    createdAt: Number(r.created_at),
  })
  return {
    async record(input) {
      const existing = await q('SELECT * FROM agent_requests WHERE org_id = $1 AND request_id = $2', [
        orgId,
        input.requestId,
      ])
      if (existing[0]) return row(existing[0] as AgentRequestRow)
      await q(
        `INSERT INTO agent_requests(request_id, org_id, origin_run_id, origin_session_id, provider, target_user_id, task, requester_id, requester_name, destination, thread_id, reply_to_message_id, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13)`,
        [
          input.requestId,
          orgId,
          input.originRunId,
          input.originSessionId,
          input.provider,
          input.targetUserId,
          input.task,
          input.requesterId,
          input.requesterName ?? null,
          JSON.stringify(input.destination),
          input.threadId ?? null,
          input.replyToMessageId ?? null,
          input.createdAt,
        ],
      )
      return { ...input, status: 'pending' }
    },
    async get(requestId) {
      const rows = await q('SELECT * FROM agent_requests WHERE org_id = $1 AND request_id = $2', [orgId, requestId])
      return rows[0] ? row(rows[0] as AgentRequestRow) : null
    },
    async decide(requestId, decision) {
      const current = await q('SELECT * FROM agent_requests WHERE org_id = $1 AND request_id = $2', [orgId, requestId])
      if (!current[0]) return { outcome: 'not_found' as const }
      const record = current[0] as AgentRequestRow
      if (record.status !== 'pending') {
        return { outcome: 'already_decided' as const, approved: record.status === 'approved', record: row(record) }
      }
      if (decision.decidedBy !== `${record.provider}:${record.target_user_id}`) {
        return { outcome: 'forbidden' as const, record: row(record) }
      }
      const status: AgentRequestStatus = decision.approved ? 'approved' : 'declined'
      const updated = await q(
        `UPDATE agent_requests SET status = $3, decided_by = $4, decided_at = $5
         WHERE org_id = $1 AND request_id = $2 AND status = 'pending'
         RETURNING *`,
        [orgId, requestId, status, decision.decidedBy, Date.now()],
      )
      if (!updated[0]) {
        return { outcome: 'already_decided' as const, approved: decision.approved, record: row(record) }
      }
      return { outcome: 'decided' as const, approved: decision.approved, record: row(updated[0] as AgentRequestRow) }
    },
    async listPending(opts) {
      const limit = Math.max(1, Math.min(1000, opts?.limit ?? 100))
      const rows = await q(
        `SELECT * FROM agent_requests WHERE org_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT $2`,
        [orgId, limit],
      )
      return rows.map((r) => row(r as AgentRequestRow))
    },
    close,
  }
}
