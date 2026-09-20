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
  /** Current TTL the request carries; renewable up to but not past `absoluteExpiry`. */
  ttlMs: number
  /**
   * Slice 2.5 — `maxTtlMs` is the deployment's hard upper bound,
   * recorded on the Approval Request at creation time and never
   * mutated. `absoluteExpiry` derives from this value:
   * `absoluteExpiry = createdAt + maxTtlMs`.
   */
  maxTtlMs: number
  /** Wall-clock absolute expiry; renewal never extends past this. */
  absoluteExpiry: number
  /** Cumulative number of renewals applied to this request (audit). */
  renewalCount?: number
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

/** Outcome of a renewal attempt (slice 2.5). */
export type ApprovalRenewalOutcome =
  | { outcome: 'renewed'; request: ApprovalRequest }
  | { outcome: 'forbidden'; request: ApprovalRequest }
  | { outcome: 'expired'; request: ApprovalRequest }
  | { outcome: 'already_decided'; request: ApprovalRequest }
  | { outcome: 'not_found' }
  | { outcome: 'no_op'; reason: 'ttl_already_at_max'; request: ApprovalRequest }

/** Input for creating an Approval Request (slice 2.3). */
export interface ApprovalRequestInput {
  /** Stable id; default allocator in `ApprovalStore.create`. */
  id?: string
  runId: string
  attemptId: string
  /** Original requester principal id — only they may decide (ADR-0012). */
  requesterPrincipalId: string
  /**
   * TTL the request is created with; default `APPROVAL_DEFAULT_TTL_MS`.
   * `absoluteExpiry = createdAt + maxTtlMs`, where `maxTtlMs` defaults
   * to this same value when not specified. Slice 2.5 separates the
   * two so renewal can extend `ttlMs` up to but not past the recorded
   * `maxTtlMs` / `absoluteExpiry`.
   */
  ttlMs?: number
  /**
   * Slice 2.5 — explicit deployment-max TTL. Defaults to `ttlMs` when
   * absent. Recorded at creation time; never mutated.
   */
  maxTtlMs?: number
  /** Snapshot of the Suspended Attempt the Approval resumes (ADR-0010). */
  attemptState: AttemptState
  /** Stable command-request id; the resumer MUST replay by `commandRequestId`, not raw text. */
  commandRequestId: string
  /** Identifier of the pending tool call (if the command is a tool invocation). */
  pendingToolCallId?: string
  /** Agent/Session context reference for the Continuation Attempt. */
  sessionRef: string
  /** Command class the gate evaluated; preserved for audit. */
  commandClass: string
  /** Raw command text, when one exists; absent for purely structured calls. */
  commandRawText?: string
}

/**
 * Slice 2.3 — durable Approval Request registry.
 *
 * Implements ADR-0010 (Approval suspends the same Run) and ADR-0012
 * (Approvals are requester-scoped and expire). The store MUST:
 *
 *   - allocate a stable `requestId` per request (idempotent on input.id);
 *   - record the absolute expiry at creation time and never mutate it
 *     except on a successful decision (slice 2.5);
 *   - reject decisions from anyone other than `requesterPrincipalId`;
 *   - dedupe duplicate decisions to `already_decided`.
 *
 * `decide` lives on this port even though slice 2.4 is the deliverable;
 * placing it on the port now keeps the parity contract stable across
 * memory and Postgres implementations.
 */
export interface ApprovalStore {
  /** Create a new Approval Request. Returns the persisted record. */
  create(input: ApprovalRequestInput): Promise<ApprovalRequest>
  /** Fetch by id; null when missing. */
  get(requestId: string): Promise<ApprovalRequest | null>
  /** List pending requests whose effective expiry (`createdAt + ttlMs`) is still in the future. */
  listPending(opts?: { limit?: number; now?: number }): Promise<readonly ApprovalRequest[]>
  /**
   * Slice 2.5 — list pending requests whose effective expiry
   * (`createdAt + ttlMs`) has passed but whose status is still
   * `pending`. The durable TTL sweep enumerates exactly these; lazy
   * expiry anywhere else is forbidden (ADR-0010 §2.5).
   */
  listExpired?(opts?: { limit?: number; now?: number }): Promise<readonly ApprovalRequest[]>
  /**
   * Apply a decision. Only the original requester may decide.
   * Decisions are idempotent — duplicate calls return `already_decided`.
   * `now` defaults to wall-clock; tests inject a deterministic clock.
   */
  decide(requestId: string, decision: { approved: boolean; decidedBy: string; now?: number }): Promise<ApprovalDecisionOutcome>
  /**
   * Mark a pending request as expired. Called exclusively by the durable
   * TTL sweep (slice 2.5); lazy expiry during a decision attempt is
   * forbidden (ADR-0010 §2.5).
   */
  expire(requestId: string, now?: number): Promise<ApprovalDecisionOutcome>
  /**
   * Slice 2.5 — extend the current TTL on a pending request. The new
   * `ttlMs` is clamped at `absoluteExpiry`; renewals never extend past
   * the absolute expiry (which is `createdAt + maxTtlMs`). Only the
   * original requester may renew. A renewal after `absoluteExpiry`
   * returns `expired`; a renewal that would not change anything
   * returns `no_op`.
   */
  renew(requestId: string, renewal: { newTtlMs: number; renewedBy: string; now?: number }): Promise<ApprovalRenewalOutcome>
  close?(): Promise<void>
}
