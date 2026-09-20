/**
 * Slice 2.4 — Approval decision + Continuation Attempt wiring.
 *
 * The `approvals` package owns the request/decision state machine
 * (`ApprovalStore.decide`); the `runs` package owns Run and Attempt
 * state. This module is the glue that bridges the two: it observes the
 * decision outcome and routes Run lifecycle accordingly.
 *
 * Rules (ADR-0010 + ADR-0012 + plan §2.4):
 *   - `approved` → create a Continuation Attempt in the SAME Run
 *     (no successor Run); transition Run back to `running`.
 *   - `rejected` → fail the same Run with `failureReason:
 *     'approval_denied'`. The rejected command never executes.
 *   - `expired`  → fail the same Run with `failureReason:
 *     'approval_expired'`. The expired command never executes. (Wired
 *     in slice 2.5; this helper accepts the outcome defensively.)
 *   - `forbidden` / `not_found` / `already_decided` are no-ops on Run
 *     state — the existing row stays.
 *   - Web and IM submit decisions only — they MUST NOT create successor
 *     Runs. The helper is the single entry point that mutates Run
 *     state on a decision.
 *
 * Linked ADRs: 0010 (Approval suspends the same Run),
 * 0012 (Approvals are requester-scoped and expire).
 */
import { randomUUID } from 'node:crypto'
import type {
  ApprovalDecisionOutcome,
  ApprovalRequest,
  ApprovalStore,
  RunState,
  RunStore,
} from '@qm/types'
import {
  isTerminalAttemptState,
  isTerminalRunState,
  type AttemptRef,
} from '@qm/types'

/**
 * Lifecycle outcome after a decision is applied. The runtime uses
 * this to drive the next UI / observation frame.
 */
export type ApprovalDecisionLifecycle =
  | { outcome: 'continuation_started'; runId: string; attemptId: string; approval: ApprovalRequest }
  | { outcome: 'run_failed'; runId: string; failureReason: 'approval_denied' | 'approval_expired'; approval: ApprovalRequest }
  | { outcome: 'noop'; reason: 'forbidden' | 'not_found' | 'already_decided' | 'pending'; approval?: ApprovalRequest }

export interface ApprovalContinuationDeps {
  approvals: ApprovalStore
  runs: RunStore
  /**
   * Injectable Attempt id allocator. The Continuation Attempt must
   * be unique per Run and must NOT collide with the Suspended Attempt
   * id. Default: `randomUUID()`.
   */
  attemptIdAllocator?: () => string
}

/**
 * Apply a decision from `ApprovalStore.decide` to the Run lifecycle.
 *
 * This is the single entry point that mutates Run state on an
 * approval decision. The orchestrator surfaces this helper to both
 * the web-ui and IM decision paths so neither creates a successor Run.
 */
export async function applyApprovalDecision(
  deps: ApprovalContinuationDeps,
  requestId: string,
  decision: { approved: boolean; decidedBy: string; now?: number },
): Promise<{ decision: ApprovalDecisionOutcome; lifecycle: ApprovalDecisionLifecycle }> {
  const decisionResult = await deps.approvals.decide(requestId, decision)
  const lifecycle = await routeDecision(deps, decisionResult)
  return { decision: decisionResult, lifecycle }
}

async function routeDecision(
  deps: ApprovalContinuationDeps,
  decisionResult: ApprovalDecisionOutcome,
): Promise<ApprovalDecisionLifecycle> {
  if (decisionResult.outcome === 'forbidden') {
    return { outcome: 'noop', reason: 'forbidden', approval: decisionResult.request }
  }
  if (decisionResult.outcome === 'not_found') {
    return { outcome: 'noop', reason: 'not_found' }
  }
  if (decisionResult.outcome === 'already_decided') {
    return { outcome: 'noop', reason: 'already_decided', approval: decisionResult.request }
  }
  if (decisionResult.outcome === 'expired') {
    // Defensive: the durable sweep (slice 2.5) is the only authority
    // for expiry, but if `decide` ever surfaces expired (it does NOT
    // — lazy expiry is forbidden — `decide` returns expired only when
    // the absoluteExpiry has already passed) we still fail the Run.
    return failRunForOutcome(deps, decisionResult.request, 'approval_expired')
  }
  // `decided`
  if (decisionResult.approved) {
    return startContinuation(deps, decisionResult.request)
  }
  return failRunForOutcome(deps, decisionResult.request, 'approval_denied')
}

async function startContinuation(
  deps: ApprovalContinuationDeps,
  approval: ApprovalRequest,
): Promise<ApprovalDecisionLifecycle> {
  // Defensive: the same Run must not be in a terminal state at this
  // point — a fresh Run is required for a Continuation Attempt.
  const run = await deps.runs.get(approval.runId)
  if (!run) {
    return { outcome: 'noop', reason: 'forbidden', approval }
  }
  if (isTerminalRunState(run.targetState)) {
    // Decision arrived after terminal — record no-op, leave row alone.
    return { outcome: 'noop', reason: 'already_decided', approval }
  }
  const allocate = deps.attemptIdAllocator ?? (() => randomUUID())
  const newAttemptId = allocate()
  // The continuation must reuse the commandRequestId from the
  // ApprovalContinuation so the resumer replays the saved command
  // point (ADR-0010) — NOT a blind replay of the original input.
  const applied = await deps.runs.beginContinuationAttempt?.(
    approval.runId,
    newAttemptId,
    approval.continuation.commandRequestId,
  )
  if (applied === false) {
    return { outcome: 'noop', reason: 'forbidden', approval }
  }
  return {
    outcome: 'continuation_started',
    runId: approval.runId,
    attemptId: newAttemptId,
    approval,
  }
}

async function failRunForOutcome(
  deps: ApprovalContinuationDeps,
  approval: ApprovalRequest,
  failureReason: 'approval_denied' | 'approval_expired',
): Promise<ApprovalDecisionLifecycle> {
  const applied = await deps.runs.failFromApproval?.(approval.runId, failureReason)
  if (applied === false) {
    return { outcome: 'noop', reason: 'already_decided', approval }
  }
  return { outcome: 'run_failed', runId: approval.runId, failureReason, approval }
}

/**
 * Pure helper that describes the Attempt state machine for the
 * Approval lifecycle: `suspended` is a non-terminal Attempt state;
 * terminal Attempt states are `succeeded` / `failed` / `cancelled`.
 *
 * Exported for tests so the orchestrator's invariants stay visible.
 */
export function isSuspendedAttempt(state: AttemptRef['state']): boolean {
  return state === 'suspended' || (typeof state === 'string' && !isTerminalAttemptState(state) && state !== 'queued' && state !== 'running')
}

/**
 * Pure helper: `awaiting_approval` is non-terminal; `queued`,
 * `running` are non-terminal; `succeeded` / `failed` / `cancelled`
 * are terminal.
 */
export function isAwaitingApproval(state: RunState): boolean {
  return state === 'awaiting_approval'
}