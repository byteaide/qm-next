/**
 * Postgres ApprovalStore: restart-safe twin of the memory implementation.
 * `record` keeps the first row per requestId (`ON CONFLICT DO NOTHING`);
 * `decide` transitions exactly once via a conditional
 * `UPDATE ... WHERE status = 'pending'`, so double clicks dedupe and a
 * decision survives a process restart.
 */
import type { Destination } from '@qm/types'
import { createPgPool, type PgPool } from '@qm/store'
import type { ApprovalDecisionOutcome, ApprovalRecord, ApprovalRecordInput, ApprovalStore } from './contract.ts'

export const APPROVALS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS approvals(
      request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, session_id TEXT NOT NULL,
      command TEXT NOT NULL, reason TEXT NOT NULL, purpose TEXT, summary TEXT,
      kind TEXT NOT NULL DEFAULT 'approval', requester_id TEXT NOT NULL,
      destination TEXT NOT NULL, thread_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_at BIGINT,
      created_at BIGINT NOT NULL, seq BIGSERIAL
    )`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals(run_id)`,
]

function row(r: Record<string, unknown>): ApprovalRecord {
  return {
    requestId: r.request_id as string,
    runId: r.run_id as string,
    sessionId: r.session_id as string,
    command: r.command as string,
    reason: r.reason as string,
    ...(r.purpose != null ? { purpose: r.purpose as string } : {}),
    ...(r.summary != null ? { summary: r.summary as string } : {}),
    kind: (r.kind as ApprovalRecord['kind']) ?? 'approval',
    requesterId: r.requester_id as string,
    destination: JSON.parse(String(r.destination)) as Destination,
    ...(r.thread_id != null ? { threadId: r.thread_id as string } : {}),
    status: r.status as ApprovalRecord['status'],
    ...(r.decided_by != null ? { decidedBy: r.decided_by as string } : {}),
    ...(r.decided_at != null ? { decidedAt: Number(r.decided_at) } : {}),
    createdAt: Number(r.created_at),
  }
}

export function createPostgresApprovalStore(connectionString: string, statements: string[] = APPROVALS_SCHEMA_STATEMENTS): ApprovalStore {
  const { q, close }: PgPool = createPgPool(connectionString, statements)

  async function fetch(requestId: string): Promise<ApprovalRecord | null> {
    const rows = await q('SELECT * FROM approvals WHERE request_id = $1', [requestId])
    return rows[0] ? row(rows[0]) : null
  }

  return {
    async record(input: ApprovalRecordInput): Promise<ApprovalRecord> {
      const inserted = await q(
        `INSERT INTO approvals(request_id, run_id, session_id, command, reason, purpose, summary, kind, requester_id, destination, thread_id, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12)
         ON CONFLICT (request_id) DO NOTHING RETURNING *`,
        [
          input.requestId,
          input.runId,
          input.sessionId,
          input.command,
          input.reason,
          input.purpose ?? null,
          input.summary ?? null,
          input.kind ?? 'approval',
          input.requester.id,
          JSON.stringify(input.destination),
          input.threadId ?? null,
          Date.now(),
        ],
      )
      if (inserted[0]) return row(inserted[0])
      const existing = await fetch(input.requestId)
      if (!existing) throw new Error(`approvals: record ${input.requestId} vanished between insert and select`)
      return existing
    },
    async get(requestId: string): Promise<ApprovalRecord | null> {
      return fetch(requestId)
    },
    async decide(requestId: string, decision: { approved: boolean; decidedBy: string }): Promise<ApprovalDecisionOutcome> {
      const record = await fetch(requestId)
      if (!record) return { outcome: 'not_found' }
      if (record.requesterId !== decision.decidedBy) return { outcome: 'forbidden', record }
      if (record.status !== 'pending') {
        return { outcome: 'already_decided', approved: record.status === 'approved', record }
      }
      const updated = await q(
        `UPDATE approvals SET status = $2, decided_by = $3, decided_at = $4
         WHERE request_id = $1 AND status = 'pending' RETURNING *`,
        [requestId, decision.approved ? 'approved' : 'rejected', decision.decidedBy, Date.now()],
      )
      if (updated[0]) {
        return { outcome: 'decided', approved: decision.approved, record: row(updated[0]) }
      }
      const reread = await fetch(requestId)
      if (!reread) return { outcome: 'not_found' }
      return { outcome: 'already_decided', approved: reread.status === 'approved', record: reread }
    },
    async listPending(opts?: { limit?: number }): Promise<ApprovalRecord[]> {
      const sql = `SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC, seq DESC${
        opts?.limit !== undefined ? ' LIMIT $1' : ''
      }`
      const rows = await q(sql, opts?.limit !== undefined ? [opts.limit] : [])
      return rows.map(row)
    },
    close,
  }
}
