/**
 * Phase 3 — Admission Record Store tests.
 *
 * Covers the memory implementation of `AdmissionRecordStore`: identity
 * preservation, ordering, capacity-bounded retention, and per-stage
 * counter queries used by the §11 runbook alerts.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { AdmissionRecord } from '@qm/types'
import {
  allocateAdmissionRecordId,
  createMemoryAdmissionRecordStore,
} from '@qm/admission'

function buildRecord(overrides: Partial<AdmissionRecord> = {}): AdmissionRecord {
  return {
    id: allocateAdmissionRecordId(),
    surface: 'web',
    actor: { id: 'person:ada', type: 'internal' },
    decision: 'rejected',
    closingStage: 'identity',
    stages: [{ stage: 'identity', decision: 'deny', reason: 'not internal', latencyMs: 1 }],
    reason: 'not internal',
    ts: 0,
    ...overrides,
  }
}

test('memory store: create + get roundtrip', async () => {
  const store = createMemoryAdmissionRecordStore()
  const record = buildRecord()
  await store.create(record)
  const fetched = await store.get(record.id)
  assert.deepEqual(fetched, record)
})

test('memory store: list orders newest-first', async () => {
  const store = createMemoryAdmissionRecordStore()
  const a = buildRecord({ ts: 100 })
  const b = buildRecord({ ts: 200 })
  const c = buildRecord({ ts: 150 })
  await store.create(a)
  await store.create(b)
  await store.create(c)
  const list = await store.list()
  assert.deepEqual(list.map((r) => r.ts), [200, 150, 100])
})

test('memory store: list since filter', async () => {
  const store = createMemoryAdmissionRecordStore()
  await store.create(buildRecord({ ts: 100 }))
  await store.create(buildRecord({ ts: 200 }))
  await store.create(buildRecord({ ts: 300 }))
  const list = await store.list({ since: 200 })
  assert.equal(list.length, 2)
  assert.deepEqual(list.map((r) => r.ts), [300, 200])
})

test('memory store: capacity-bounded retention evicts oldest', async () => {
  const store = createMemoryAdmissionRecordStore({ capacity: 2 })
  await store.create(buildRecord({ ts: 1 }))
  await store.create(buildRecord({ ts: 2 }))
  await store.create(buildRecord({ ts: 3 }))
  const list = await store.list()
  assert.equal(list.length, 2)
  assert.deepEqual(list.map((r) => r.ts), [3, 2])
})

test('memory store: countInWindow counts records in [since, until]', async () => {
  const store = createMemoryAdmissionRecordStore()
  await store.create(buildRecord({ ts: 100 }))
  await store.create(buildRecord({ ts: 200 }))
  await store.create(buildRecord({ ts: 300 }))
  const n = await store.countInWindow({ since: 150, until: 250 })
  assert.equal(n, 1)
})

test('memory store: countByStageDecision counts stage hits', async () => {
  const store = createMemoryAdmissionRecordStore()
  await store.create(
    buildRecord({
      stages: [
        { stage: 'identity', decision: 'allow', latencyMs: 1 },
        { stage: 'rate_limit', decision: 'deny', reason: 'rate', latencyMs: 1 },
      ],
      ts: 100,
    }),
  )
  await store.create(
    buildRecord({
      stages: [
        { stage: 'identity', decision: 'allow', latencyMs: 1 },
        { stage: 'rate_limit', decision: 'allow', latencyMs: 1 },
        { stage: 'budget', decision: 'deny', latencyMs: 1 },
      ],
      ts: 200,
    }),
  )
  const identityDeny = await store.countByStageDecision({
    stage: 'identity',
    decision: 'deny',
    since: 0,
  })
  const rateLimitDeny = await store.countByStageDecision({
    stage: 'rate_limit',
    decision: 'deny',
    since: 0,
  })
  const budgetDeny = await store.countByStageDecision({
    stage: 'budget',
    decision: 'deny',
    since: 0,
  })
  assert.equal(identityDeny, 0)
  assert.equal(rateLimitDeny, 1)
  assert.equal(budgetDeny, 1)
})

test('memory store: identity ids are stable', () => {
  const a = allocateAdmissionRecordId()
  const b = allocateAdmissionRecordId()
  assert.notEqual(a, b)
  assert.equal(a.length, 36) // UUID v4
})

test('memory store: get returns undefined for unknown id', async () => {
  const store = createMemoryAdmissionRecordStore()
  const fetched = await store.get('does-not-exist')
  assert.equal(fetched, undefined)
})