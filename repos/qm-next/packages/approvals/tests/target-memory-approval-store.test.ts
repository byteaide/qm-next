/**
 * Slice 2.3 — Target ApprovalStore memory contract tests.
 *
 * Asserts the §2.3 invariants:
 *   - `create` preserves the original Run / Attempt / CommandRequest
 *     identities and the suspended Attempt state (ADR-0010).
 *   - `create` defaults the TTL to `APPROVAL_DEFAULT_TTL_MS` (24h).
 *   - `create` rejects duplicate ids.
 *   - `get` is null on missing ids and round-trips a freshly created
 *     request.
 *   - `listPending` filters out requests whose `absoluteExpiry` has
 *     already passed (used by the durable sweep in slice 2.5).
 *
 * Linked ADRs: 0010 (Approval suspends the same Run),
 * 0012 (Approvals are requester-scoped and expire).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { APPROVAL_DEFAULT_TTL_MS } from '@qm/types'
import { createMemoryTargetApprovalStore } from '../src/index.ts'

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

test('slice-2.3: create + get roundtrip preserves identity fields', async () => {
  const store = createMemoryTargetApprovalStore()
  const request = await store.create(makeInput())
  assert.equal(request.status, 'pending')
  assert.equal(request.runId, 'run-1')
  assert.equal(request.attemptId, 'attempt-1')
  assert.equal(request.requesterPrincipalId, 'person:ada')
  assert.equal(request.continuation.runId, 'run-1')
  assert.equal(request.continuation.attemptId, 'attempt-1')
  assert.equal(request.continuation.commandRequestId, 'cmd-1')
  assert.equal(request.continuation.attemptState, 'suspended')
  assert.equal(request.continuation.sessionRef, 'session-A')
  assert.equal(request.continuation.approvalRequestId, request.id)
  assert.equal(request.continuation.pendingToolCallId, undefined)
  const fetched = await store.get(request.id)
  assert.deepEqual(fetched, request)
})

test('slice-2.3: create defaults ttlMs to APPROVAL_DEFAULT_TTL_MS (24h)', async () => {
  const store = createMemoryTargetApprovalStore()
  const request = await store.create(makeInput())
  assert.equal(request.ttlMs, APPROVAL_DEFAULT_TTL_MS)
  assert.equal(APPROVAL_DEFAULT_TTL_MS, 24 * 60 * 60_000)
  // absoluteExpiry is recorded at creation time; the wall-clock clock
  // returns Date.now(), so absoluteExpiry - createdAt ≈ ttlMs.
  const slack = request.absoluteExpiry - request.createdAt
  assert.ok(Math.abs(slack - APPROVAL_DEFAULT_TTL_MS) <= 5, `slack should be ~0, got ${slack}`)
})

test('slice-2.3: create honors explicit ttlMs and stamps absoluteExpiry', async () => {
  let now = 1_000_000
  const store = createMemoryTargetApprovalStore({ clock: { now: () => now } })
  const request = await store.create(makeInput({ ttlMs: 60_000 }))
  assert.equal(request.ttlMs, 60_000)
  assert.equal(request.absoluteExpiry, 1_060_000)
})

test('slice-2.3: create with explicit id is idempotent on that id', async () => {
  const store = createMemoryTargetApprovalStore({ idAllocator: () => 'alloc-fails' })
  const first = await store.create(makeInput({ id: 'app-1' }))
  assert.equal(first.id, 'app-1')
  await assert.rejects(
    () => store.create(makeInput({ id: 'app-1' })),
    /already exists/,
  )
})

test('slice-2.3: create preserves pendingToolCallId when provided', async () => {
  const store = createMemoryTargetApprovalStore()
  const request = await store.create(makeInput({ pendingToolCallId: 'tool-9' }))
  assert.equal(request.continuation.pendingToolCallId, 'tool-9')
})

test('slice-2.3: get returns null on missing id', async () => {
  const store = createMemoryTargetApprovalStore()
  const fetched = await store.get('does-not-exist')
  assert.equal(fetched, null)
})

test('slice-2.3: listPending filters out expired requests', async () => {
  let now = 0
  const store = createMemoryTargetApprovalStore({ clock: { now: () => now } })
  const shortLived = await store.create(makeInput({ runId: 'run-short', ttlMs: 1_000 }))
  await store.create(makeInput({ runId: 'run-long', ttlMs: 60_000 }))
  // Advance the clock past the short-lived absolute expiry.
  now = 2_000
  const pending = await store.listPending()
  const ids = pending.map((r) => r.runId)
  assert.ok(ids.includes('run-long'), 'long-lived should be pending')
  assert.ok(!ids.includes('run-short'), 'short-lived should be filtered out')
  // Sanity: the get() still returns the expired one; the filter is
  // only on listPending.
  const stillThere = await store.get(shortLived.id)
  assert.ok(stillThere)
})

test('slice-2.3: listPending respects limit', async () => {
  const store = createMemoryTargetApprovalStore()
  await store.create(makeInput({ runId: 'run-1' }))
  await store.create(makeInput({ runId: 'run-2' }))
  await store.create(makeInput({ runId: 'run-3' }))
  const pending = await store.listPending({ limit: 2 })
  assert.equal(pending.length, 2)
})

test('slice-2.3: create is independent across stores', async () => {
  const a = createMemoryTargetApprovalStore()
  const b = createMemoryTargetApprovalStore()
  const rA = await a.create(makeInput())
  const rB = await b.create(makeInput())
  assert.notEqual(rA.id, rB.id)
  assert.equal(await b.get(rA.id), null)
  assert.equal(await a.get(rB.id), null)
})