/**
 * Memory monitor-store tests (parity 16.0): create enforces
  escalation guard (different owner requires consent), advance holds
  or clears the tail and records the fire time, setEnabled removes
  from the enabled set without deleting the record, and recordError
  surfaces without disabling the monitor.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryMonitorStore } from '../src/index.ts'

function input(overrides: Record<string, unknown> = {}) {
  return {
    owner: 'U1',
    createdBy: 'U1',
    ownerScopeId: 'personal:U1',
    processId: 'p-1',
    command: 'bg: npm run build',
    threadRef: 'thread-1',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  }
}

test('memory monitor store: create stores a monitor with cursor 0 and enabled', async () => {
  const store = createMemoryMonitorStore()
  const m = await store.create(input())
  assert.equal(m.cursor, 0)
  assert.equal(m.enabled, true)
  assert.equal(m.processId, 'p-1')
  assert.equal(m.threadRef, 'thread-1')
  assert.equal((await store.enabled()).length, 1)
})

test('memory monitor store: create rejects assigning a different owner without consent', async () => {
  const store = createMemoryMonitorStore()
  await assert.rejects(() => store.create(input({ owner: 'U2' })), /consent/)
})

test('memory monitor store: advance moves cursor, holds/clears tail, records fire time', async () => {
  const store = createMemoryMonitorStore()
  const m = await store.create(input())
  await store.advance(m.id, { cursor: 42, tail: 'partial li' })
  let got = await store.get(m.id)
  assert.equal(got?.cursor, 42)
  assert.equal(got?.tail, 'partial li')
  assert.equal(got?.lastFiredAt, undefined)
  await store.advance(m.id, { cursor: 50, firedAt: 123 })
  got = await store.get(m.id)
  assert.equal(got?.cursor, 50)
  assert.equal(got?.tail, undefined)
  assert.equal(got?.lastFiredAt, 123)
})

test('memory monitor store: setEnabled(false) keeps the record but removes from enabled', async () => {
  const store = createMemoryMonitorStore()
  const m = await store.create(input())
  await store.setEnabled(m.id, false)
  assert.equal((await store.enabled()).length, 0)
  assert.ok(await store.get(m.id))
})

test('memory monitor store: recordError keeps the monitor armed and surfaces the error', async () => {
  const store = createMemoryMonitorStore()
  const m = await store.create(input())
  await store.recordError(m.id, 'boom')
  const got = await store.get(m.id)
  assert.equal(got?.lastError, 'boom')
  assert.equal(got?.enabled, true)
})