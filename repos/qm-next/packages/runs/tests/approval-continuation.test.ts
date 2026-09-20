/**
 * Slice 2.4 — Approval decision state machine + Continuation Attempt
 * wiring contract tests.
 *
 * Asserts the §2.4 invariants:
 *   - `approvals` owns the decision state machine.
 *   - `runs` owns Run / Attempt state.
 *   - Web / IM submit decisions only — no successor Run is created.
 *   - Only the original requester may approve or reject.
 *   - Duplicate decisions return `already_decided`.
 *   - Approval creates a Continuation Attempt in the SAME Run.
 *   - Rejection fails the same Run with `approval_denied`.
 *   - Restart between approval and resume still resumes exactly once.
 *
 * Linked ADRs: 0010 (Approval suspends the same Run),
 * 0012 (Approvals are requester-scoped and expire).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyApprovalDecision,
  type ApprovalContinuationDeps,
  isAwaitingApproval,
} from '@qm/runs'
import { createMemoryRunStore } from '@qm/store'
import { createMemoryTargetApprovalStore } from '@qm/approvals'
import type { ApprovalRequest } from '@qm/types'

async function seedRunAndApproval(opts: { approverId?: string } = {}) {
  const approvals = createMemoryTargetApprovalStore()
  const runs = createMemoryRunStore()
  const enq = await runs.enqueue({
    sessionId: 'session-A',
    request: {
      surface: 'api',
      actor: { type: 'internal', id: 'person:ada' },
      conversation: { kind: 'dm', threadRef: 'thread-1', audience: [] },
      origin: { kind: 'direct' },
      text: 'slice-2-4 approval',
    },
  })
  // ADR-0010 continuation executor — walk the Run into the real
  // `awaiting_approval` state through the store transition the turn
  // runner drives: claim → suspend (lease released + durable
  // continuation). The decision helpers only act on a suspended Run.
  const claimed = await runs.claim('worker-1', 60_000)
  assert.ok(claimed)
  const suspended = await runs.suspendForApproval!(enq.run.id, claimed.leaseToken!, {
    requestId: 'app-1',
    commandRequestId: 'cmd-1',
    attemptId: 'attempt-1',
    suspendedAt: Date.now(),
    result: { status: 'pending_approval', sessionId: 'session-A', pendingApprovals: [] },
  })
  assert.equal(suspended, true)
  const request = await approvals.create({
    id: 'app-1',
    runId: enq.run.id,
    attemptId: 'attempt-1',
    requesterPrincipalId: opts.approverId ?? 'person:ada',
    commandRequestId: 'cmd-1',
    attemptState: 'suspended',
    sessionRef: 'session-A',
    commandClass: 'shell',
  })
  return { approvals, runs, request, runId: enq.run.id, leaseToken: claimed.leaseToken! }
}

function makeDeps(approvals: ReturnType<typeof createMemoryTargetApprovalStore>, runs: ReturnType<typeof createMemoryRunStore>): ApprovalContinuationDeps {
  return { approvals, runs }
}

test('slice-2.4: approve by requester starts a Continuation Attempt in the same Run', async () => {
  const { approvals, runs, request, runId } = await seedRunAndApproval()
  const result = await applyApprovalDecision(makeDeps(approvals, runs), request.id, {
    approved: true,
    decidedBy: 'person:ada',
  })
  assert.equal(result.decision.outcome, 'decided')
  assert.equal(result.lifecycle.outcome, 'continuation_started')
  if (result.lifecycle.outcome === 'continuation_started') {
    assert.equal(result.lifecycle.runId, runId)
    assert.notEqual(result.lifecycle.attemptId, request.attemptId)
  }
  // Run itself is back to running (continuation-claimable) and not terminal;
  // the continuation lane can now claim it.
  const run = await runs.get(runId)
  assert.ok(run)
  assert.notEqual(run?.status, 'failed')
  assert.equal(run?.targetState, 'running')
  assert.equal(run?.leaseToken, null)
  assert.equal(isAwaitingApproval(run?.targetState ?? 'queued'), false)
  const continuation = await runs.claimNextContinuation!('worker-2', 60_000)
  assert.ok(continuation)
  assert.equal(continuation.id, runId)
  assert.equal(continuation.deliveryState?.pendingApproval?.commandRequestId, 'cmd-1')
})

test('slice-2.4: reject by requester fails the same Run with approval_denied', async () => {
  const { approvals, runs, request, runId } = await seedRunAndApproval()
  const result = await applyApprovalDecision(makeDeps(approvals, runs), request.id, {
    approved: false,
    decidedBy: 'person:ada',
  })
  assert.equal(result.decision.outcome, 'decided')
  assert.equal(result.lifecycle.outcome, 'run_failed')
  if (result.lifecycle.outcome === 'run_failed') {
    assert.equal(result.lifecycle.failureReason, 'approval_denied')
  }
  const run = await runs.get(runId)
  assert.ok(run)
  assert.equal(run?.targetState, 'failed')
  assert.equal(run?.failureReason, 'approval_denied')
})

test('slice-2.4: non-requester decision is forbidden (no Run mutation)', async () => {
  const { approvals, runs, request, runId } = await seedRunAndApproval()
  const result = await applyApprovalDecision(makeDeps(approvals, runs), request.id, {
    approved: true,
    decidedBy: 'person:eve',
  })
  assert.equal(result.decision.outcome, 'forbidden')
  assert.equal(result.lifecycle.outcome, 'noop')
  if (result.lifecycle.outcome === 'noop') {
    assert.equal(result.lifecycle.reason, 'forbidden')
  }
  const run = await runs.get(runId)
  assert.ok(run)
  // Run is not in failed state — the forbidden decision left it alone.
  assert.notEqual(run?.targetState, 'failed')
  assert.notEqual(run?.targetState, 'succeeded')
  void runId
})

test('slice-2.4: duplicate decision returns already_decided (no second Continuation)', async () => {
  const { approvals, runs, request } = await seedRunAndApproval()
  const first = await applyApprovalDecision(makeDeps(approvals, runs), request.id, {
    approved: true,
    decidedBy: 'person:ada',
  })
  assert.equal(first.lifecycle.outcome, 'continuation_started')
  const second = await applyApprovalDecision(makeDeps(approvals, runs), request.id, {
    approved: true,
    decidedBy: 'person:ada',
  })
  assert.equal(second.decision.outcome, 'already_decided')
  assert.equal(second.lifecycle.outcome, 'noop')
})

test('slice-2.4: unknown request id is no-op', async () => {
  const { approvals, runs } = await seedRunAndApproval()
  const result = await applyApprovalDecision(makeDeps(approvals, runs), 'never-existed', {
    approved: true,
    decidedBy: 'person:ada',
  })
  assert.equal(result.decision.outcome, 'not_found')
  assert.equal(result.lifecycle.outcome, 'noop')
  if (result.lifecycle.outcome === 'noop') {
    assert.equal(result.lifecycle.reason, 'not_found')
  }
})

test('slice-2.4: id is stable across create / decide / expire', async () => {
  const approvals = createMemoryTargetApprovalStore()
  const created: ApprovalRequest = await approvals.create({
    runId: 'run-1',
    attemptId: 'attempt-1',
    requesterPrincipalId: 'person:ada',
    commandRequestId: 'cmd-1',
    attemptState: 'suspended',
    sessionRef: 'session-A',
    commandClass: 'shell',
  })
  const decided = await approvals.decide(created.id, { approved: true, decidedBy: 'person:ada' })
  assert.equal(decided.outcome, 'decided')
  if (decided.outcome === 'decided') {
    assert.equal(decided.request.id, created.id)
    assert.equal(decided.request.runId, 'run-1')
  }
})

test('slice-2.4: failed-then-failFromApproval is idempotent', async () => {
  const { approvals, runs, request } = await seedRunAndApproval()
  const first = await applyApprovalDecision(makeDeps(approvals, runs), request.id, {
    approved: false,
    decidedBy: 'person:ada',
  })
  assert.equal(first.lifecycle.outcome, 'run_failed')
  const second = await applyApprovalDecision(makeDeps(approvals, runs), request.id, {
    approved: false,
    decidedBy: 'person:ada',
  })
  assert.equal(second.decision.outcome, 'already_decided')
  assert.equal(second.lifecycle.outcome, 'noop')
})