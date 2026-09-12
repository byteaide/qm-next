/**
 * In-memory ApprovalStore: dev/test twin of the Postgres implementation.
 * Keep-first `record`, single-transition `decide` — the semantics the pg
 * implementation mirrors with `ON CONFLICT DO NOTHING` + a conditional
 * `UPDATE ... WHERE status = 'pending'`.
 */
import type { ApprovalDecisionOutcome, ApprovalRecord, ApprovalRecordInput, ApprovalStore } from './contract.ts'

export function createMemoryApprovalStore(): ApprovalStore {
  const records = new Map<string, ApprovalRecord>()
  return {
    async record(input: ApprovalRecordInput): Promise<ApprovalRecord> {
      const existing = records.get(input.requestId)
      if (existing) return existing
      const record: ApprovalRecord = {
        requestId: input.requestId,
        runId: input.runId,
        sessionId: input.sessionId,
        command: input.command,
        reason: input.reason,
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        kind: input.kind ?? 'approval',
        requesterId: input.requester.id,
        destination: input.destination,
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        status: 'pending',
        createdAt: Date.now(),
      }
      records.set(input.requestId, record)
      return record
    },
    async get(requestId: string): Promise<ApprovalRecord | null> {
      return records.get(requestId) ?? null
    },
    async decide(requestId: string, decision: { approved: boolean; decidedBy: string }): Promise<ApprovalDecisionOutcome> {
      const record = records.get(requestId)
      if (!record) return { outcome: 'not_found' }
      if (record.requesterId !== decision.decidedBy) return { outcome: 'forbidden', record }
      if (record.status !== 'pending') {
        return { outcome: 'already_decided', approved: record.status === 'approved', record }
      }
      const approved = decision.approved
      const decided: ApprovalRecord = {
        ...record,
        status: approved ? 'approved' : 'rejected',
        decidedBy: decision.decidedBy,
        decidedAt: Date.now(),
      }
      records.set(requestId, decided)
      return { outcome: 'decided', approved, record: decided }
    },
    async listPending(opts?: { limit?: number }): Promise<ApprovalRecord[]> {
      const pending = [...records.values()]
        .filter((record) => record.status === 'pending')
        .sort((a, b) => b.createdAt - a.createdAt)
      return opts?.limit !== undefined ? pending.slice(0, opts.limit) : pending
    },
    async close(): Promise<void> {},
  }
}
