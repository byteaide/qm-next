/**
 * Slice 2.5 — Approval TTL lifecycle + durable sweep contract tests.
 *
 * Asserts the §2.5 invariants:
 *   - Default TTL is 24h when not specified.
 *   - `absoluteExpiry` is recorded at creation and equals
 *     `createdAt + maxTtlMs`.
 *   - Renewal extends `ttlMs` but never past the absolute expiry.
 *   - Renewal after absolute expiry returns `expired` and does not
 *     mutate the record.
 *   - Renewal that would not move the absolute expiry returns `no_op`
 *     with `reason: 'ttl_already_at_max'`.
 *   - The durable sweep is the only authority for `expired` status;
 *     lazy expiry in `decide` is bounded by the absolute-expiry check
 *     but does not mutate state.
 *   - Sweep runs exactly once per expired request (idempotent).
 *
 * Linked ADRs: 0010 (Approval suspends the same Run),
 * 0012 (Approvals are requester-scoped and expire).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { APPROVAL_DEFAULT_TTL_MS } from '@qm/types'
import {
  createMemoryTargetApprovalStore,
  runApprovalTTLSweep,
} from '../src/index.ts'

function makeInput(overrides: Partial<Parameters<ReturnType<typeof createMemoryTargetApprovalStore>['create']>[0]> = {}) {
  return {
    runId: 'run-1',
    attemptId: 'attempt-1',
    requesterPrincipalId: 'person:ada',
    commandRequestId: 'cmd-1',
    attemptState: 'suspended' as const,
    sessionRef: 'session-A',
    commandClass: 'shell',
    ...overrides,
  }
}

test('slice-2.5: default TTL is 24h and absoluteExpiry = createdAt + maxTtlMs', async () => {
  let now = 1_000_000
  const store = createMemoryTargetApprovalStore({ clock: { now: () => now } })
  const request = await store.create(makeInput())
  assert.equal(request.ttlMs, APPROVAL_DEFAULT_TTL_MS)
  assert.equal(request.maxTtlMs, APPROVAL_DEFAULT_TTL_MS)
  assert.equal(request.absoluteExpiry, request.createdAt + request.maxTtlMs)
  assert.equal(request.absoluteExpiry, now + APPROVAL_DEFAULT_TTL_MS)
})

test('slice-2.5: explicit maxTtlMs is recorded and never mutates', async () => {
  const store = createMemoryTargetApprovalStore()
  const request = await store.create(makeInput({ ttlMs: 60_000, maxTtlMs: 5 * 60_000 }))
  assert.equal(request.ttlMs, 60_000)
  assert.equal(request.maxTtlMs, 5 * 60_000)
  assert.equal(request.absoluteExpiry, request.createdAt + 5 * 60_000)
})

test('slice-2.5: renewal extends ttlMs up to but not past absoluteExpiry', async () => {
  let now = 0
  const store = createMemoryTargetApprovalStore({ clock: { now: () => now } })
  const request = await store.create(makeInput({ ttlMs: 60_000, maxTtlMs: 5 * 60_000 }))
  // Original ttlMs is 60s; renewal to 180s is allowed.
  const renewed = await store.renew(request.id, { newTtlMs: 180_000, renewedBy: 'person:ada' })
  assert.equal(renewed.outcome, 'renewed')
  if (renewed.outcome === 'renewed') {
    assert.equal(renewed.request.ttlMs, 180_000)
    assert.equal(renewed.request.absoluteExpiry, request.createdAt + 5 * 60_000)
    assert.equal(renewed.request.renewalCount, 1)
  }
  // Renewal past maxTtlMs is clamped at the absolute expiry.
  const renewedMax = await store.renew(request.id, { newTtlMs: 600_000, renewedBy: 'person:ada' })
  assert.equal(renewedMax.outcome, 'renewed')
  if (renewedMax.outcome === 'renewed') {
    assert.equal(renewedMax.request.ttlMs, 5 * 60_000)
    assert.equal(renewedMax.request.renewalCount, 2)
  }
  // Renewal that would not move anything returns no_op.
  const noop = await store.renew(request.id, { newTtlMs: 5 * 60_000, renewedBy: 'person:ada' })
  assert.equal(noop.outcome, 'no_op')
})

test('slice-2.5: renewal after absolute expiry returns expired and does not mutate', async () => {
  let now = 0
  const store = createMemoryTargetApprovalStore({ clock: { now: () => now } })
  const request = await store.create(makeInput({ ttlMs: 60_000 }))
  now = 70_000
  const renewed = await store.renew(request.id, { newTtlMs: 120_000, renewedBy: 'person:ada' })
  assert.equal(renewed.outcome, 'expired')
  const after = await store.get(request.id)
  assert.ok(after)
  assert.equal(after?.ttlMs, 60_000)
  assert.equal(after?.status, 'pending')
})

test('slice-2.5: renewal by non-requester returns forbidden', async () => {
  const store = createMemoryTargetApprovalStore()
  const request = await store.create(makeInput())
  const renewed = await store.renew(request.id, { newTtlMs: 600_000, renewedBy: 'person:eve' })
  assert.equal(renewed.outcome, 'forbidden')
})

test('slice-2.5: durable sweep is the only authority for expired status', async () => {
  let now = 0
  const store = createMemoryTargetApprovalStore({ clock: { now: () => now } })
  await store.create(makeInput({ runId: 'run-1', ttlMs: 60_000 }))
  await store.create(makeInput({ runId: 'run-2', ttlMs: 600_000 }))
  now = 70_000
  const expired = await runApprovalTTLSweep(store, { now })
  assert.equal(expired.length, 1)
  assert.equal(expired[0]?.runId, 'run-1')
  // run-2 stays pending.
  const run2 = await store.get((await store.listPending({ now }))[0]?.id ?? '__missing__')
  assert.ok(run2)
})

test('slice-2.5: sweep is idempotent — repeated sweeps do not double-count', async () => {
  let now = 0
  const store = createMemoryTargetApprovalStore({ clock: { now: () => now } })
  const request = await store.create(makeInput({ ttlMs: 60_000 }))
  now = 70_000
  const first = await runApprovalTTLSweep(store, { now })
  assert.equal(first.length, 1)
  const second = await runApprovalTTLSweep(store, { now })
  assert.equal(second.length, 0, 'second sweep sees already-expired request and does not re-expire')
  void request
})

test('slice-2.5: lazy expiry in decide returns expired without mutating state', async () => {
  let now = 0
  const store = createMemoryTargetApprovalStore({ clock: { now: () => now } })
  const request = await store.create(makeInput({ ttlMs: 60_000 }))
  now = 70_000
  const decided = await store.decide(request.id, { approved: true, decidedBy: 'person:ada', now })
  assert.equal(decided.outcome, 'expired')
  const after = await store.get(request.id)
  assert.ok(after)
  assert.equal(after?.status, 'pending', 'sweep must run before status flips; decide does not mutate')
})

test('slice-2.5: decide after sweep sees already_decided', async () => {
  let now = 0
  const store = createMemoryTargetApprovalStore({ clock: { now: () => now } })
  const request = await store.create(makeInput({ ttlMs: 60_000 }))
  now = 70_000
  await runApprovalTTLSweep(store, { now })
  const decided = await store.decide(request.id, { approved: true, decidedBy: 'person:ada', now })
  assert.equal(decided.outcome, 'already_decided')
  if (decided.outcome === 'already_decided') {
    assert.equal(decided.approved, false)
  }
})

test('slice-2.5: renewal on already-decided request returns already_decided', async () => {
  const store = createMemoryTargetApprovalStore()
  const request = await store.create(makeInput())
  await store.decide(request.id, { approved: true, decidedBy: 'person:ada' })
  const renewed = await store.renew(request.id, { newTtlMs: 600_000, renewedBy: 'person:ada' })
  assert.equal(renewed.outcome, 'already_decided')
})