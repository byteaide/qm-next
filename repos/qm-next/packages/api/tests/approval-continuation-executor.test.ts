/**
 * ADR-0010 continuation executor — acceptance tests (owner decision A,
 * 2026-09-20; the deferred slice archived in the Phase 7 section of
 * `docs/implementation-plan.md`).
 *
 * These are the Phase 2 resume tests backed by a real executor:
 *   - approval resumes the saved command point, not a blind replay
 *     (the continuation turn carries `TurnInput.approval` with the
 *     durable request + command identity);
 *   - no successor Run is created (same Run id throughout);
 *   - restart between approval and resume still resumes exactly once
 *     (durable continuation discovery + `lastCommandRequestId` guard).
 *
 * Plus the executor-side boundary behaviors:
 *   - unwired executor fails closed with `approval_continuation_unavailable`
 *     (a pending approval never completes as success);
 *   - a new same-Session Run stays queued while the Session Continuation
 *     Reservation is held, and the reservation releases only after the
 *     terminal Run Event (plan §2.6).
 *
 * Linked ADRs: 0010, 0012, 0013; plan §2.3/§2.4/§2.6.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@qm/cordis'
import { createInMemoryEventLog, createMemorySequenceAllocator, createMemorySessionReservationStore } from '@qm/concurrency'
import { createMemoryTargetApprovalStore } from '@qm/approvals'
import { createHarnessRouter, createMockHarness, OrchestratorService, type MockHarness } from '@qm/orchestrator'
import { applyApprovalDecision, type ApprovalContinuationDeps } from '@qm/runs'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { ResolutionService, Run, RunStore, ScopeId, SessionReservationStore, TargetRunEvent, TargetRunEventBus, TurnResult } from '@qm/types'
import { createTurnRunner, type TurnRunner } from '../src/index.ts'

const SCOPE: ScopeId = 'org:default'

interface ExecutorRig {
  runs: RunStore
  reservations: SessionReservationStore
  approvals: ReturnType<typeof createMemoryTargetApprovalStore>
  glue: ApprovalContinuationDeps
  log: ReturnType<typeof createInMemoryEventLog>
  harness: MockHarness
  sessionId: string
  /** Build a runner over the rig stores — each call simulates a fresh process. */
  spawnRunner(workerId: string): TurnRunner
}

async function buildRig(script: Parameters<typeof createMockHarness>[0]['script']): Promise<ExecutorRig> {
  const sessions = createMemorySessionStore()
  const runs = createMemoryRunStore()
  const log = createInMemoryEventLog({ allocator: createMemorySequenceAllocator() })
  const approvals = createMemoryTargetApprovalStore()
  const reservations = createMemorySessionReservationStore()
  const harness = createMockHarness({ script })
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(harness)
  const resolution: ResolutionService = {
    resolve: async () => ({ systemPrompt: 'You are qm-next.', orgScopeId: SCOPE }),
    scopeFor: () => SCOPE,
  }
  const spawnRunner = (workerId: string): TurnRunner => {
    const orchestrator = new OrchestratorService(new Context(), {
      sessions,
      runs,
      harness: registry,
      identity: {
        isInternal: (p) => p.type === 'internal',
        audienceIsAllInternal: (audience) => audience.every((p) => p.type === 'internal'),
      },
      resolution,
      rateLimiter: { check: async () => ({ allowed: true }) },
      runEventLog: log.bus,
    })
    return createTurnRunner(
      { orchestrator, runs, runEventLog: log.bus, approvals, reservations },
      { workerId, tickMs: 5 },
    )
  }
  // Resolve the session id the way the enqueued run will see it.
  const session = await sessions.getOrCreateByThread('thread:approval', 'dm', SCOPE, 'test')
  return { runs, reservations, approvals, glue: { approvals, runs, runEventLog: log.bus, reservations }, log, harness, sessionId: session.id, spawnRunner }
}

async function enqueueTurn(runs: RunStore, sessionId: string, text: string): Promise<Run> {
  const { run } = await runs.enqueue({
    sessionId,
    request: {
      surface: 'test',
      actor: { id: 'person:ada', type: 'internal' },
      conversation: { kind: 'dm', threadRef: 'thread:approval', audience: [{ id: 'person:ada', type: 'internal' }] },
      origin: { kind: 'direct' },
      text,
    },
  })
  return run
}

function eventsOf(log: ReturnType<typeof createInMemoryEventLog>, runId: string): TargetRunEvent[] {
  return [...log.readAll(runId)]
}

test('approve: suspends the same Run, resumes the saved command point, no successor Run', async () => {
  const rig = await buildRig([
    { reply: 'need a yes', pausedOnApproval: true, pendingApprovals: [{ command: 'rm -rf /', reason: 'destructive' }] },
    { reply: 'resumed and done' },
  ])
  const runner = rig.spawnRunner('rig-1')
  try {
    const enqueued = await enqueueTurn(rig.runs, rig.sessionId, 'do the thing')
    assert.equal(await runner.pollOnce(), true)

    // Suspended, not completed: awaiting_approval with the executor
    // lease released and the durable continuation on the row.
    const suspended = await rig.runs.get(enqueued.id)
    assert.ok(suspended)
    assert.equal(suspended.targetState, 'awaiting_approval')
    assert.equal(suspended.leaseToken, null)
    assert.equal(suspended.result?.status, 'pending_approval')
    assert.ok(suspended.deliveryState?.pendingApproval)
    const pending = suspended.deliveryState.pendingApproval!

    // Durable Approval Request + Session Continuation Reservation held.
    const request = await rig.approvals.get(pending.requestId)
    assert.ok(request)
    assert.equal(request.runId, enqueued.id)
    assert.equal(request.status, 'pending')
    const reservation = await rig.reservations.inspect(rig.sessionId)
    assert.ok(reservation)
    assert.equal(reservation.runId, enqueued.id)

    // Observation: awaiting is observable; suspension + request events persisted.
    const events = eventsOf(rig.log, enqueued.id)
    assert.ok(events.some((e) => e.kind === 'attempt.suspended' && e.approvalRequestId === request.id))
    assert.ok(events.some((e) => e.kind === 'approval.requested' && e.requestId === request.id))
    const snapshot = await rig.log.bus.snapshot(enqueued.id)
    assert.equal(snapshot?.state, 'awaiting_approval')

    // No successor Run exists.
    assert.equal((await rig.runs.list()).length, 1)

    // The decision routes through the same glue the web/IM surfaces use.
    const decision = await applyApprovalDecision(rig.glue, request.id, { approved: true, decidedBy: 'person:ada' })
    assert.equal(decision.decision.outcome, 'decided')
    assert.equal(decision.lifecycle.outcome, 'continuation_started')

    // Still the SAME Run, now continuation-claimable.
    const claimable = await rig.runs.get(enqueued.id)
    assert.equal(claimable?.targetState, 'running')
    assert.equal(claimable?.leaseToken, null)
    assert.equal((await rig.runs.list()).length, 1)

    // The continuation lane claims and executes the resume.
    assert.equal(await runner.pollOnce(), true)

    // Saved command point, not a blind replay: the resumed turn carries
    // the durable approval + command identity.
    assert.equal(rig.harness.calls.length, 2)
    const resumeCall = rig.harness.calls[1]!
    assert.equal(resumeCall.runId, enqueued.id)
    assert.deepEqual(resumeCall.approval, {
      requestId: request.id,
      approved: true,
      commandRequestId: pending.commandRequestId,
    })

    // Same Run reached terminal success exactly once.
    const done = await rig.runs.get(enqueued.id)
    assert.equal(done?.targetState, 'succeeded')
    assert.equal(done?.result?.reply, 'resumed and done')
    const terminal = eventsOf(rig.log, enqueued.id)
    assert.equal(terminal.filter((e) => e.kind === 'run.finished').length, 1)

    // §2.6 — the reservation released only after the terminal event.
    assert.equal(await rig.reservations.inspect(rig.sessionId), null)
    const resumedIdx = terminal.findIndex((e) => e.kind === 'attempt.resumed')
    assert.ok(resumedIdx >= 0)
    assert.ok(terminal.slice(0, resumedIdx).some((e) => e.kind === 'approval.decided'))
  } finally {
    await runner.stop()
  }
})

test('restart between approval and resume still resumes exactly once', async () => {
  const rig = await buildRig([
    { reply: 'need a yes', pausedOnApproval: true, pendingApprovals: [{ command: 'deploy', reason: 'needs sign-off' }] },
    { reply: 'deployed' },
  ])
  const runner = rig.spawnRunner('rig-1')
  try {
    const enqueued = await enqueueTurn(rig.runs, rig.sessionId, 'ship it')
    await runner.pollOnce()
    const suspended = await rig.runs.get(enqueued.id)
    const pending = suspended?.deliveryState?.pendingApproval
    assert.ok(pending)
    const request = await rig.approvals.get(pending.requestId)
    assert.ok(request)

    // The decision lands (durable) but the process "restarts" before
    // the continuation lane claims: the original runner is abandoned
    // and a fresh runner over the SAME stores takes over.
    const decision = await applyApprovalDecision(rig.glue, request.id, { approved: true, decidedBy: 'person:ada' })
    assert.equal(decision.lifecycle.outcome, 'continuation_started')

    const restarted = rig.spawnRunner('rig-2-after-restart')
    assert.equal(await restarted.pollOnce(), true)

    // The fresh process resumed the SAME Run, exactly once, with the
    // saved command point.
    assert.equal(rig.harness.calls.length, 2)
    const resumeCall = rig.harness.calls[1]!
    assert.equal(resumeCall.runId, enqueued.id)
    assert.equal(resumeCall.approval?.commandRequestId, pending.commandRequestId)
    const done = await rig.runs.get(enqueued.id)
    assert.equal(done?.targetState, 'succeeded')

    // An idler tick claims nothing further; duplicate decision delivery
    // is a no-op — no second execution.
    assert.equal(await restarted.pollOnce(), false)
    const duplicate = await applyApprovalDecision(rig.glue, request.id, { approved: true, decidedBy: 'person:ada' })
    assert.equal(duplicate.decision.outcome, 'already_decided')
    assert.equal(rig.harness.calls.length, 2)
    await restarted.stop()
  } finally {
    await runner.stop()
  }
})

test('reject: fails the same Run with approval_denied; reservation released after the terminal event', async () => {
  const rig = await buildRig([
    { reply: 'need a yes', pausedOnApproval: true, pendingApprovals: [{ command: 'drop-tables', reason: 'destructive' }] },
  ])
  const runner = rig.spawnRunner('rig-1')
  try {
    const enqueued = await enqueueTurn(rig.runs, rig.sessionId, 'drop it')
    await runner.pollOnce()
    const suspended = await rig.runs.get(enqueued.id)
    const pending = suspended?.deliveryState?.pendingApproval
    assert.ok(pending)

    const decision = await applyApprovalDecision(rig.glue, pending.requestId, { approved: false, decidedBy: 'person:ada' })
    assert.equal(decision.lifecycle.outcome, 'run_failed')
    if (decision.lifecycle.outcome === 'run_failed') {
      assert.equal(decision.lifecycle.failureReason, 'approval_denied')
    }

    const failed = await rig.runs.get(enqueued.id)
    assert.equal(failed?.targetState, 'failed')
    assert.equal(failed?.failureReason, 'approval_denied')
    assert.ok(failed?.finishedAt)

    // Terminal events: approval.decided then run.finished; reservation gone.
    const events = eventsOf(rig.log, enqueued.id)
    const decidedIdx = events.findIndex((e) => e.kind === 'approval.decided' && e.approved === false)
    const finishedIdx = events.findIndex((e) => e.kind === 'run.finished')
    assert.ok(decidedIdx >= 0 && finishedIdx > decidedIdx)
    const finished = events[finishedIdx] as Extract<TargetRunEvent, { kind: 'run.finished' }>
    assert.equal(finished.outcome, 'failed')
    assert.equal(finished.failureReason, 'approval_denied')
    assert.equal(await rig.reservations.inspect(rig.sessionId), null)

    // No successor Run; the rejected command never executed.
    assert.equal((await rig.runs.list()).length, 1)
    assert.equal(rig.harness.calls.length, 1)
  } finally {
    await runner.stop()
  }
})

test('unwired executor: pending approval fails closed with approval_continuation_unavailable', async () => {
  const sessions = createMemorySessionStore()
  const runs = createMemoryRunStore()
  const log = createInMemoryEventLog({ allocator: createMemorySequenceAllocator() })
  const harness = createMockHarness({
    script: [{ reply: 'need a yes', pausedOnApproval: true, pendingApprovals: [{ command: 'x', reason: 'gated' }] }],
  })
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(harness)
  const resolution: ResolutionService = {
    resolve: async () => ({ systemPrompt: 's', orgScopeId: SCOPE }),
    scopeFor: () => SCOPE,
  }
  const orchestrator = new OrchestratorService(new Context(), {
    sessions,
    runs,
    harness: registry,
    identity: { isInternal: (p) => p.type === 'internal', audienceIsAllInternal: (a) => a.every((p) => p.type === 'internal') },
    resolution,
    rateLimiter: { check: async () => ({ allowed: true }) },
    runEventLog: log.bus,
  })
  const runner = createTurnRunner({ orchestrator, runs, runEventLog: log.bus }, { workerId: 'no-executor', tickMs: 5 })
  const session = await sessions.getOrCreateByThread('thread:approval', 'dm', SCOPE, 'test')
  const enqueued = await enqueueTurn(runs, session.id, 'go')
  try {
    await runner.pollOnce()
    const run = await runs.get(enqueued.id)
    assert.equal(run?.targetState, 'failed')
    assert.equal(run?.failureReason, 'approval_continuation_unavailable')
    const events = [...log.readAll(enqueued.id)]
    const finished = events.find((e): e is Extract<TargetRunEvent, { kind: 'run.finished' }> => e.kind === 'run.finished')
    assert.ok(finished)
    assert.equal(finished.outcome, 'failed')
    assert.equal(finished.failureReason, 'approval_continuation_unavailable')
  } finally {
    await runner.stop()
  }
})

test('same-Session Run stays queued while the reservation is held (plan §2.6)', async () => {
  const rig = await buildRig([
    { reply: 'need a yes', pausedOnApproval: true, pendingApprovals: [{ command: 'gate-1', reason: 'gated' }] },
    { reply: 'first done' },
    { reply: 'second done' },
  ])
  const runner = rig.spawnRunner('rig-1')
  try {
    const first = await enqueueTurn(rig.runs, rig.sessionId, 'first')
    await runner.pollOnce()
    const suspended = await rig.runs.get(first.id)
    assert.equal(suspended?.targetState, 'awaiting_approval')

    // A second same-Session turn is enqueued while the reservation is held.
    const second = await enqueueTurn(rig.runs, rig.sessionId, 'second')
    await runner.pollOnce()
    const secondAfter = await rig.runs.get(second.id)
    assert.ok(secondAfter)
    assert.equal(secondAfter.targetState, 'queued')
    assert.equal(secondAfter.leaseToken, null)

    // Approve; the continuation completes and releases the reservation.
    const pending = suspended?.deliveryState?.pendingApproval
    assert.ok(pending)
    await applyApprovalDecision(rig.glue, pending.requestId, { approved: true, decidedBy: 'person:ada' })
    await runner.pollOnce() // resumes the first run
    const firstDone = await rig.runs.get(first.id)
    assert.equal(firstDone?.targetState, 'succeeded')
    assert.equal(await rig.reservations.inspect(rig.sessionId), null)

    // Only now does the second Run leave queued.
    await runner.pollOnce()
    const secondDone = await rig.runs.get(second.id)
    assert.equal(secondDone?.targetState, 'succeeded')
  } finally {
    await runner.stop()
  }
})
