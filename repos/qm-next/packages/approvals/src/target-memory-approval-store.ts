/**
 * Slice 2.3 — In-memory `ApprovalStore` implementation.
 *
 * Implements the durable Approval Request registry port from
 * `@qm/types/approval-continuation.ts` for tests and single-process
 * deployments. The Postgres twin (slice 2.6) uses the same contract.
 *
 * Linked ADRs: ADR-0010 (Approval suspends the same Run),
 * ADR-0012 (Approvals are requester-scoped and expire).
 */
import { randomUUID } from 'node:crypto'
import type {
  ApprovalContinuation,
  ApprovalDecisionOutcome,
  ApprovalRequest,
  ApprovalRequestInput,
  ApprovalStore,
  AttemptState,
} from '@qm/types'
import { APPROVAL_DEFAULT_TTL_MS } from '@qm/types'

/** Optional Clock injection so tests stay deterministic. */
export interface MemoryTargetApprovalStoreOptions {
  clock?: { now: () => number }
  /** Optional id allocator (test injection). */
  idAllocator?: () => string
}

interface StoredRecord {
  request: ApprovalRequest
}

function buildContinuation(input: ApprovalRequestInput, suspendedAt: number): ApprovalContinuation {
  const continuation: ApprovalContinuation = {
    runId: input.runId,
    attemptId: input.attemptId,
    commandRequestId: input.commandRequestId,
    attemptState: input.attemptState,
    sessionRef: input.sessionRef,
    approvalRequestId: input.id ?? 'pending',
    suspendedAt,
  }
  if (input.pendingToolCallId !== undefined) {
    continuation.pendingToolCallId = input.pendingToolCallId
  }
  return continuation
}

/**
 * Construct an in-process ApprovalStore. `now()` is wall-clock by
 * default; tests inject a deterministic clock so the TTL sweep suite
 * can advance time without sleeping.
 */
export function createMemoryTargetApprovalStore(
  opts: MemoryTargetApprovalStoreOptions = {},
): ApprovalStore {
  const clock = opts.clock ?? { now: () => Date.now() }
  const allocate = opts.idAllocator ?? (() => randomUUID())
  const records = new Map<string, StoredRecord>()

  function effectiveTtlMs(input: ApprovalRequestInput): number {
    return input.ttlMs ?? APPROVAL_DEFAULT_TTL_MS
  }

  function buildRequest(input: ApprovalRequestInput, id: string): ApprovalRequest {
    const now = clock.now()
    const ttlMs = effectiveTtlMs(input)
    const absoluteExpiry = now + ttlMs
    return {
      id,
      runId: input.runId,
      attemptId: input.attemptId,
      requesterPrincipalId: input.requesterPrincipalId,
      ttlMs,
      absoluteExpiry,
      status: 'pending',
      createdAt: now,
      continuation: { ...buildContinuation(input, now), approvalRequestId: id },
    }
  }

  function snapshot(rec: StoredRecord): ApprovalRequest {
    return { ...rec.request, continuation: { ...rec.request.continuation } }
  }

  return {
    async create(input: ApprovalRequestInput): Promise<ApprovalRequest> {
      const id = input.id ?? allocate()
      if (records.has(id)) {
        throw new Error(`ApprovalRequest '${id}' already exists`)
      }
      const request = buildRequest(input, id)
      records.set(id, { request })
      return snapshot(records.get(id)!)
    },

    async get(requestId: string): Promise<ApprovalRequest | null> {
      const rec = records.get(requestId)
      return rec ? snapshot(rec) : null
    },

    async listPending(opts?: { limit?: number; now?: number }): Promise<readonly ApprovalRequest[]> {
      const now = opts?.now ?? clock.now()
      const limit = opts?.limit ?? Number.POSITIVE_INFINITY
      const out: ApprovalRequest[] = []
      for (const rec of records.values()) {
        if (rec.request.status !== 'pending') continue
        if (rec.request.absoluteExpiry <= now) continue
        out.push(snapshot(rec))
        if (out.length >= limit) break
      }
      return out
    },

    async decide(requestId, decision): Promise<ApprovalDecisionOutcome> {
      const rec = records.get(requestId)
      if (!rec) return { outcome: 'not_found' }
      const now = decision.now ?? clock.now()
      if (rec.request.status !== 'pending') {
        return {
          outcome: 'already_decided',
          approved: rec.request.approved ?? false,
          request: snapshot(rec),
        }
      }
      if (rec.request.requesterPrincipalId !== decision.decidedBy) {
        return { outcome: 'forbidden', request: snapshot(rec) }
      }
      if (rec.request.absoluteExpiry <= now) {
        return { outcome: 'expired', request: snapshot(rec) }
      }
      rec.request = {
        ...rec.request,
        status: decision.approved ? 'approved' : 'rejected',
        approved: decision.approved,
        decidedAt: now,
        decidedBy: decision.decidedBy,
      }
      return { outcome: 'decided', approved: decision.approved, request: snapshot(rec) }
    },

    async expire(requestId, now): Promise<ApprovalDecisionOutcome> {
      const rec = records.get(requestId)
      if (!rec) return { outcome: 'not_found' }
      const t = now ?? clock.now()
      if (rec.request.status !== 'pending') {
        return {
          outcome: 'already_decided',
          approved: rec.request.approved ?? false,
          request: snapshot(rec),
        }
      }
      rec.request = { ...rec.request, status: 'expired', decidedAt: t }
      return { outcome: 'decided', approved: false, request: snapshot(rec) }
    },
  }
}

/** Re-export for ergonomic single-import from tests. */
export type { ApprovalStore, ApprovalRequest, ApprovalContinuation, AttemptState }
export { APPROVAL_DEFAULT_TTL_MS }