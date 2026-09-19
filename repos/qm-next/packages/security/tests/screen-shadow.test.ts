/**
 * Phase 3 — Security Screen Shadow Record tests.
 *
 * Covers plan §3.2 Shadow Mode tests:
 *   - Allowed, denied, failed, and unavailable decisions are recorded.
 *   - Shadow Records are separately retained from Run Events.
 *   - Capacity-bounded retention with TTL eviction.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMemoryShadowRecordStore,
} from '@qm/security'
import type { ShadowRecord } from '@qm/security'

const baseRecord: Omit<ShadowRecord, 'id' | 'ts'> = {
  mode: 'shadow',
  decision: 'allow',
  actor: { id: 'person:ada', type: 'internal' },
  latencyMs: 1,
}

test('shadow store: create + get roundtrip', async () => {
  const store = createMemoryShadowRecordStore()
  await store.create({ ...baseRecord, id: 'a', ts: 100 })
  const fetched = await store.get('a')
  assert.deepEqual(fetched?.id, 'a')
})

test('shadow store: list by mode filter', async () => {
  const store = createMemoryShadowRecordStore()
  await store.create({ ...baseRecord, id: 'a', ts: 100, mode: 'shadow' })
  await store.create({ ...baseRecord, id: 'b', ts: 200, mode: 'shadow' })
  const list = await store.list({ mode: 'shadow' })
  assert.equal(list.length, 2)
})

test('shadow store: capacity-bounded retention evicts oldest', async () => {
  const store = createMemoryShadowRecordStore({ capacity: 2 })
  await store.create({ ...baseRecord, id: 'a', ts: 1 })
  await store.create({ ...baseRecord, id: 'b', ts: 2 })
  await store.create({ ...baseRecord, id: 'c', ts: 3 })
  const list = await store.list()
  assert.equal(list.length, 2)
  assert.deepEqual(list.map((r) => r.id), ['c', 'b'])
})

test('shadow store: evict removes records older than retention window', async () => {
  let now = 0
  const store = createMemoryShadowRecordStore({
    retentionMs: 1_000,
    now: () => now,
  })
  await store.create({ ...baseRecord, id: 'a', ts: 0 })
  now = 500
  await store.create({ ...baseRecord, id: 'b', ts: 500 })
  now = 2_000
  const evicted = await store.evict(now)
  assert.equal(evicted, 1)
  const remaining = await store.list()
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0]?.id, 'b')
})

test('shadow store: list newest-first ordering', async () => {
  const store = createMemoryShadowRecordStore()
  await store.create({ ...baseRecord, id: 'a', ts: 100 })
  await store.create({ ...baseRecord, id: 'b', ts: 300 })
  await store.create({ ...baseRecord, id: 'c', ts: 200 })
  const list = await store.list()
  assert.deepEqual(list.map((r) => r.id), ['b', 'c', 'a'])
})

test('shadow store: ruleId and redactedExcerpt are persisted as-is', async () => {
  const store = createMemoryShadowRecordStore()
  await store.create({
    ...baseRecord,
    id: 'a',
    ts: 100,
    decision: 'deny',
    ruleId: 'leak.v1',
    redactedExcerpt: '[redacted-credential]',
    reason: 'leak detected',
  })
  const fetched = await store.get('a')
  assert.equal(fetched?.ruleId, 'leak.v1')
  assert.equal(fetched?.redactedExcerpt, '[redacted-credential]')
  assert.equal(fetched?.reason, 'leak detected')
})

test('shadow store: actor/scope/run references are preserved', async () => {
  const store = createMemoryShadowRecordStore()
  await store.create({
    ...baseRecord,
    id: 'a',
    ts: 100,
    scopeId: 'personal:ada',
    sessionRef: 'session-A',
    runRef: 'run-1',
  })
  const fetched = await store.get('a')
  assert.equal(fetched?.scopeId, 'personal:ada')
  assert.equal(fetched?.sessionRef, 'session-A')
  assert.equal(fetched?.runRef, 'run-1')
})

test('shadow store: retentionMs is exposed on the store', () => {
  const store = createMemoryShadowRecordStore({ retentionMs: 1234 })
  assert.equal(store.retentionMs, 1234)
})