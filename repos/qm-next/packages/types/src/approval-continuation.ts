/**
 * Target Approval contracts — implements ADR-0010 (Approval suspends the
 * same Run) and ADR-0012 (Approvals are requester-scoped and expire).
 *
 * Phase 0 freeze: types compile. The legacy `ApprovalRecord` in
 * `packages/approvals/src/contract.ts` remains the runtime record during
 * the migration window; Phase 2 reconciles legacy records into the
 * Approval Continuation shape below.
 */
import type { AttemptState } from './run-lifecycle.ts'

/** TTL lifecycle constants — see §2.5 of `docs/implementation-plan.md`. */
export const APPROVAL_DEFAULT_TTL_MS = 24 * 60 * 60_000

/**
 * `max_ttl` is configurable per deployment but is recorded on the
 * Approval Request so historical replay remains correct.
 */
export interface ApprovalTtlPolicy {
  /** Default TTL when the request is created without an explicit value. */
  defaultMs: number
  /** Hard upper bound — renewals never extend past `createdAt + maxMs`. */
  maxMs: number
}

/**
 * Stable identity pointing at the suspended Attempt the Approval resumes.
 * Survives process restarts and is the durable link from the Approval
 * Request to the work it gates.
 */
export interface ApprovalContinuation {
  runId: string
  attemptId: string
  /** Stable command-request id; the resumer MUST replay by `commandRequestId`, not raw text. */
  commandRequestId: string
  /** Snapshot of the Attempt state when suspended. */
  attemptState: AttemptState
  /** Identifier of the pending tool call (if the command is a tool invocation). */
  pendingToolCallId?: string
  /** Agent/Session context references for the Continuation Attempt. */
  sessionRef: string
  approvalRequestId: string
  /** Wall-clock epoch ms when the suspension began. */
  suspendedAt: number
}

/** Status of an Approval Request. Decisions are one-way. */
export type ApprovalRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface ApprovalRequest {
  id: string
  runId: string
  attemptId: string
  /** Strict principal equality check on decision; only the requester may decide. */
  requesterPrincipalId: string
  /** TTL the request was created with. */
  ttlMs: number
  /** Wall-clock absolute expiry; renewal never extends past this. */
  absoluteExpiry: number
  status: ApprovalRequestStatus
  /** Wall-clock creation time; recorded so replay can verify the absolute expiry. */
  createdAt: number
  decidedAt?: number
  decidedBy?: string
  approved?: boolean
  /** Continuation record; present from creation onward. */
  continuation: ApprovalContinuation
}

/** Outcome returned by an Approval decision attempt. */
export type ApprovalDecisionOutcome =
  | { outcome: 'decided'; approved: boolean; request: ApprovalRequest }
  | { outcome: 'already_decided'; approved: boolean; request: ApprovalRequest }
  | { outcome: 'forbidden'; request: ApprovalRequest }
  | { outcome: 'expired'; request: ApprovalRequest }
  | { outcome: 'not_found' }
