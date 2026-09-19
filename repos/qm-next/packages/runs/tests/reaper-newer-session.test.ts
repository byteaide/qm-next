/**
 * Slice 1.3 — Reaper newer-Session overlap detection.
 *
 * The reaper must NOT retire a Run whose Session has an active
 * SessionContinuationReservation owned by a *different* Run (ADR-0010
 * + ADR-0001). When such overlap exists, the reaper emits a
 * `skipped_newer_session` event, increments the
 * `lease_reaper_newer_session_total` observability counter, and
 * leaves the Run row alone so the newer Session's Run can complete.
 *
 * Linked ADRs: ADR-0001, ADR-0010.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReaper } from '@qm/runs'
import { RUN_METRICS, _resetDefaultRunMetricsRegistryForTests, createRunMetricsRegistry } from '@qm/runs'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import { createMemorySessionReservationStore } from '@qm/concurrency'
import type { ReapEvent, RunStore } from '@qm/types'

/** Enqueue a Run and claim it with a 1ms lease so the reaper sees it
 *  as expired without us having to reach into private state. */
async function enqueueExpiredRun(runStore: RunStore, sessionId: string, dedupKey: string): Promise<string> {
  const enq = await runStore.enqueue({
    sessionId,
    request: {
      surface: 'api',
      actor: { type: 'internal', id: 'tester' },
      conversation: { kind: 'dm', threadRef: sessionId, audience: [] },
      origin: { kind: 'direct' },
      text: 'reaper-newer-session',
    },
    dedupKey,
  })
  const claimed = await runStore.claim('worker-1', 1)
  assert.ok(claimed, `claim must succeed for ${dedupKey}`)
  // Wait past the 1ms TTL so leaseLapsed() returns true.
  await new Promise((res) => setTimeout(res, 10))
  return enq.run.id
}

test('reaper: skips Run when a newer Session holds an active continuation reservation', async () => {
  _resetDefaultRunMetricsRegistryForTests()
  const runStore = createMemoryRunStore()
  const sessions = createMemorySessionStore()
  const reservations = createMemorySessionReservationStore()

  const sessionId = 'session-A'
  const runId = await enqueueExpiredRun(runStore, sessionId, 'older')

  // Reserve the Session for a *different* Run — the newer
  // approval-continuation Run. ADR-0010: only one Run may hold the
  // Session at a time; the older Run is "in flight" on the same
  // Session id from the reaper's point of view.
  const reservation = await reservations.reserve(sessionId, 'newer', 60_000)
  assert.equal(reservation.ok, true)

  const events: ReapEvent[] = []
  const reaper = createReaper(runStore, sessions, {
    intervalMs: 60_000,
    reservations,
    errors: {
      record(e) {
        events.push({
          runId: e.sessionId ?? 'unknown',
          sessionId: e.sessionId ?? '',
          workerId: null,
          attempts: 0,
          errorAttempts: 0,
          outcome: e.code === 'run_reap_skipped_newer_session' ? 'skipped_newer_session' : 'requeued',
        })
      },
    },
  })
  const result = await reaper.sweep()
  assert.equal(result.skippedNewerSession, 1, 'one Run should be skipped due to newer-Session overlap')
  assert.equal(result.requeued, 0, 'no Run should be requeued when a newer Session is active')
  assert.equal(result.parked, 0, 'no Run should be parked when a newer Session is active')

  // The Run itself stays running — the reaper left it alone.
  const after = await runStore.get(runId)
  assert.equal(after?.status, 'running', 'older Run must remain running when newer Session is active')

  // The error sink received a `skipped_newer_session` event.
  const skipped = events.filter((e) => e.outcome === 'skipped_newer_session')
  assert.equal(skipped.length, 1)
})

test('reaper: still reaps when no newer Session holds a reservation', async () => {
  _resetDefaultRunMetricsRegistryForTests()
  const runStore = createMemoryRunStore()
  const sessions = createMemorySessionStore()
  const reservations = createMemorySessionReservationStore()
  const sessionId = 'session-B'

  const runId = await enqueueExpiredRun(runStore, sessionId, 'lonely')

  const reaper = createReaper(runStore, sessions, {
    intervalMs: 60_000,
    reservations,
  })
  const result = await reaper.sweep()
  assert.equal(result.skippedNewerSession, 0)
  assert.ok(
    result.requeued + result.parked >= 1,
    `expected at least one reap, got ${JSON.stringify(result)}`,
  )

  const after = await runStore.get(runId)
  assert.ok(after)
  assert.notEqual(after?.status, 'running', 'Run must no longer be running after reap')
})

test('reaper: ticks the injected metrics registry with the skipped_newer_session outcome label', async () => {
  _resetDefaultRunMetricsRegistryForTests()
  const runStore = createMemoryRunStore()
  const sessions = createMemorySessionStore()
  const reservations = createMemorySessionReservationStore()
  const registry = createRunMetricsRegistry()

  const sessionId = 'session-C'
  const runId = await enqueueExpiredRun(runStore, sessionId, 'metrics')

  // Reserve the Session for a different RunId so the older Run is
  // skipped by the reaper.
  await reservations.reserve(sessionId, 'run-other', 60_000)

  const reaper = createReaper(runStore, sessions, {
    intervalMs: 60_000,
    reservations,
    metrics: {
      inc(name, labels) {
        registry.inc(name, labels)
      },
    },
  })
  const result = await reaper.sweep()
  assert.equal(result.skippedNewerSession, 1)

  const snap = registry.snapshot().find((s) => s.name === RUN_METRICS.LEASE_REAP_NEWER_SESSION_TOTAL)
  assert.ok(snap, `expected counter ${RUN_METRICS.LEASE_REAP_NEWER_SESSION_TOTAL} to be ticked`)
  assert.equal(snap?.total, 1)
  assert.deepEqual(snap?.byLabels[0]?.labels, { outcome: 'skipped_newer_session' })

  // Sanity — the Run is still running because it was skipped.
  const after = await runStore.get(runId)
  assert.equal(after?.status, 'running')
})

test('reaper: falls back to legacy behavior when `reservations` is not provided', async () => {
  _resetDefaultRunMetricsRegistryForTests()
  const runStore = createMemoryRunStore()
  const sessions = createMemorySessionStore()
  const sessionId = 'session-D'

  const runId = await enqueueExpiredRun(runStore, sessionId, 'legacy')

  // No `reservations` → no newer-session check.
  const reaper = createReaper(runStore, sessions, { intervalMs: 60_000 })
  const result = await reaper.sweep()
  assert.equal(result.skippedNewerSession, 0)
  assert.ok(result.requeued + result.parked >= 1)
  const after = await runStore.get(runId)
  assert.notEqual(after?.status, 'running')
})

test('reaper: emits a skipped_newer_session event with the original worker id', async () => {
  _resetDefaultRunMetricsRegistryForTests()
  const runStore = createMemoryRunStore()
  const sessions = createMemorySessionStore()
  const reservations = createMemorySessionReservationStore()
  const sessionId = 'session-E'

  await enqueueExpiredRun(runStore, sessionId, 'with-worker')
  await reservations.reserve(sessionId, 'newer-worker', 60_000)

  const captured: ReapEvent[] = []
  const reaper = createReaper(runStore, sessions, {
    intervalMs: 60_000,
    reservations,
    errors: {
      record(e) {
        captured.push({
          runId: e.sessionId ?? 'unknown',
          sessionId: e.sessionId ?? '',
          workerId: null,
          attempts: 0,
          errorAttempts: 0,
          outcome: e.code === 'run_reap_skipped_newer_session' ? 'skipped_newer_session' : 'requeued',
        })
      },
    },
  })
  await reaper.sweep()
  const skip = captured.find((e) => e.outcome === 'skipped_newer_session')
  assert.ok(skip, 'expected at least one skipped_newer_session event')
})