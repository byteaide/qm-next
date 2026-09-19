/**
 * Slice 2.3 + 2.5 — In-memory `ApprovalStore` implementation.
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
  ApprovalRenewalOutcome,
  ApprovalRequest,
  ApprovalRequestInput,
  ApprovalStore,
} from '@qm/types'
import { APPROVAL_DEFAULT_TTL_MS } from '@qm/types'
import {
  bumpApprovalRequestOutcome,
  bumpApprovalRenewal,
  bumpApprovalTtlSweep,
} from '@qm/runs'

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

  function ttlFromInput(input: ApprovalRequestInput): number {
    return input.ttlMs ?? APPROVAL_DEFAULT_TTL_MS
  }

  function maxTtlFromInput(input: ApprovalRequestInput, ttlMs: number): number {
    return input.maxTtlMs ?? ttlMs
  }

  function buildRequest(input: ApprovalRequestInput, id: string): ApprovalRequest {
    const now = clock.now()
    const ttlMs = ttlFromInput(input)
    const maxTtlMs = maxTtlFromInput(input, ttlMs)
    const absoluteExpiry = now + maxTtlMs
    return {
      id,
      runId: input.runId,
      attemptId: input.attemptId,
      requesterPrincipalId: input.requesterPrincipalId,
      ttlMs,
      maxTtlMs,
      absoluteExpiry,
      status: 'pending',
      createdAt: now,
      continuation: { ...buildContinuation(input, now), approvalRequestId: id },
    }
  }

  function snapshot(rec: StoredRecord): ApprovalRequest {
    return { ...rec.request, continuation: { ...rec.request.continuation } }
  }

  function isCurrentlyExpired(rec: StoredRecord, now: number): boolean {
    // Slice 2.5 — `decide` does NOT perform lazy expiry. The sweep is
    // the only authority for the `expired` status; we use this helper
    // only inside the sweep itself to detect past-due pending records.
    return rec.request.status === 'pending' && rec.request.absoluteExpiry <= now
  }

  return {
    async create(input: ApprovalRequestInput): Promise<ApprovalRequest> {
      const id = input.id ?? allocate()
      if (records.has(id)) {
        throw new Error(`ApprovalRequest '${id}' already exists`)
      }
      const request = buildRequest(input, id)
      records.set(id, { request })
      // Slice 2.7 — count every newly created Approval Request.
      bumpApprovalRequestOutcome('requested')
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
      // Slice 2.5 — durable sweep is the only authority for expiry. If
      // the record is past `absoluteExpiry` but the sweep has not yet
      // marked it `expired`, `decide` returns `expired` defensively
      // without mutating state; the next sweep will mark it. This
      // keeps the lazy-expiry invariant intact while still surfacing
      // a coherent outcome to the caller.
      if (rec.request.status === 'pending' && rec.request.absoluteExpiry <= (decision.now ?? clock.now())) {
        return { outcome: 'expired', request: snapshot(rec) }
      }
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
      rec.request = {
        ...rec.request,
        status: decision.approved ? 'approved' : 'rejected',
        approved: decision.approved,
        decidedAt: decision.now ?? clock.now(),
        decidedBy: decision.decidedBy,
      }
      // Slice 2.7 — count approved/rejected decisions.
      bumpApprovalRequestOutcome(decision.approved ? 'approved' : 'rejected')
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
      // Slice 2.7 — count expirations driven by the durable sweep.
      bumpApprovalRequestOutcome('expired')
      return { outcome: 'decided', approved: false, request: snapshot(rec) }
    },

    /**
     * Slice 2.5 — extend the TTL on a pending request. The new
     * `ttlMs` is clamped at the absolute expiry (`createdAt +
     * maxTtlMs`); renewals never extend past it (ADR-0010 §2.5). A
     * renewal attempt after absolute expiry returns `expired`. A
     * renewal that would not move the absolute expiry returns
     * `no_op` with `reason: 'ttl_already_at_max'` so the audit log
     * records a benign attempt.
     */
    async renew(requestId, renewal): Promise<ApprovalRenewalOutcome> {
      const rec = records.get(requestId)
      if (!rec) return { outcome: 'not_found' }
      const now = renewal.now ?? clock.now()
      if (rec.request.status !== 'pending') {
        return {
          outcome: 'already_decided',
          approved: rec.request.approved ?? false,
          request: snapshot(rec),
        }
      }
      if (rec.request.requesterPrincipalId !== renewal.renewedBy) {
        return { outcome: 'forbidden', request: snapshot(rec) }
      }
      if (now >= rec.request.absoluteExpiry) {
        return { outcome: 'expired', request: snapshot(rec) }
      }
      const currentExpiry = rec.request.createdAt + rec.request.ttlMs
      const newExpiry = Math.min(rec.request.createdAt + renewal.newTtlMs, rec.request.absoluteExpiry)
      if (newExpiry <= currentExpiry) {
        return { outcome: 'no_op', reason: 'ttl_already_at_max', request: snapshot(rec) }
      }
      rec.request = {
        ...rec.request,
        ttlMs: newExpiry - rec.request.createdAt,
        renewalCount: (rec.request.renewalCount ?? 0) + 1,
      }
      // Slice 2.7 — count accepted renewals.
      bumpApprovalRenewal('accepted')
      return { outcome: 'renewed', request: snapshot(rec) }
    },
  }
}

/**
 * Slice 2.5 — durable TTL sweep. The sweep is the only authority for
 * the `expired` status (ADR-0010 §2.5); lazy expiry during a decision
 * attempt is forbidden. Returns the number of requests transitioned
 * to `expired`.
 *
 * The sweep does NOT itself fail the corresponding Run — that wiring
 * lives in slice 2.6 (reservation release order). Each expired
 * request returns its durable record so the caller can drive the
 * downstream Run failure (failureReason: 'approval_expired') in the
 * same transaction as the durable expiry event (slice 2.6 §durable
 * transition → event → release).
 */
export interface ApprovalTTLSweepOptions {
  /** Injectable wall-clock; tests use a deterministic clock. */
  now?: number
  /** Max records to expire per sweep tick; default `Number.POSITIVE_INFINITY`. */
  limit?: number
}

export async function runApprovalTTLSweep(
  store: ApprovalStore,
  opts: ApprovalTTLSweepOptions = {},
): Promise<readonly ApprovalRequest[]> {
  const limit = opts.limit ?? Number.POSITIVE_INFINITY
  const now = opts.now ?? Date.now()
  const pending = await store.listPending({ now, limit: Number.POSITIVE_INFINITY })
  const expired: ApprovalRequest[] = []
  for (const request of pending) {
    if (request.absoluteExpiry > now) continue
    if (expired.length >= limit) break
    const outcome = await store.expire(request.id, now)
    if (outcome.outcome === 'decided') {
      expired.push(outcome.request)
    }
  }
  if (expired.length === 0) {
    // Slice 2.7 — track the no-op tick so the runbook alert (§10) can
    // detect a dead sweep: "approval_ttl_sweep_total{outcome=no_op}
    // sustained over more than 2× the sweep interval".
    bumpApprovalTtlSweep('no_op')
  } else {
    bumpApprovalTtlSweep('expired')
  }
  return expired
}