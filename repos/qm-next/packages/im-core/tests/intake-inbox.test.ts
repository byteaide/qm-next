/**
 * Memory Intake Inbox contract (Phase 5, ADR-0008): dedup on the
 * (provider, eventId) Intake Key, monotonic seq, markTurn first-writer-
 * wins, listAfterSeq ordering. The Postgres twin mirrors these cases in
 * `intake-store-pg.test.ts`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryIntakeInbox } from '@qm/im-core/runtime'
import type { InboundMessageEvent } from '@qm/im-core'

function messageEvent(provider: string, eventId: string, text: string): InboundMessageEvent {
  return {
    kind: 'message',
    provider,
    instanceId: 'test',
    eventId,
    occurredAt: 1_000,
    receivedAt: 2_000,
    destination: { type: provider, target: 'chat-1' },
    actor: { providerUserId: 'u1', displayName: 'User One' },
    text,
  }
}

test('accept records a new intake and returns the record', async () => {
  const inbox = createMemoryIntakeInbox()
  const { record, duplicate } = await inbox.accept(messageEvent('fake', 'evt-1', 'hello'), 5_000)
  assert.equal(duplicate, false)
  assert.equal(record.provider, 'fake')
  assert.equal(record.eventId, 'evt-1')
  assert.equal(record.seq, 1)
  assert.equal(record.acceptedAt, 5_000)
  assert.equal(record.event.kind, 'message')
  assert.equal(record.turnId, undefined)
  assert.equal(await inbox.latestSeq(), 1)
})

test('duplicate accept returns the original record with duplicate=true', async () => {
  const inbox = createMemoryIntakeInbox()
  const first = await inbox.accept(messageEvent('fake', 'evt-1', 'hello'))
  const second = await inbox.accept(messageEvent('fake', 'evt-1', 'hello'))
  assert.equal(second.duplicate, true)
  assert.equal(second.record.id, first.record.id)
  assert.equal(second.record.seq, first.record.seq)
  assert.equal(await inbox.latestSeq(), 1, 'duplicate accept allocates no new seq')
})

test('same eventId from a different provider is a distinct delivery', async () => {
  const inbox = createMemoryIntakeInbox()
  const a = await inbox.accept(messageEvent('alpha', 'evt-1', 'from alpha'))
  const b = await inbox.accept(messageEvent('beta', 'evt-1', 'from beta'))
  assert.equal(a.duplicate, false)
  assert.equal(b.duplicate, false)
  assert.notEqual(a.record.id, b.record.id)
  assert.equal(await inbox.latestSeq(), 2)
})

test('composite key never conflates ids containing separators', async () => {
  const inbox = createMemoryIntakeInbox()
  const a = await inbox.accept(messageEvent('x', 'a:b', 'one'))
  const b = await inbox.accept(messageEvent('x:a', 'b', 'two'))
  assert.equal(a.duplicate, false)
  assert.equal(b.duplicate, false)
  const again = await inbox.accept(messageEvent('x', 'a:b', 'one'))
  assert.equal(again.duplicate, true, 'original key still dedups')
  assert.equal(again.record.id, a.record.id)
})

test('listAfterSeq returns records in seq order above the cursor', async () => {
  const inbox = createMemoryIntakeInbox()
  for (let i = 1; i <= 4; i++) await inbox.accept(messageEvent('fake', `evt-${i}`, `m${i}`))
  const after2 = await inbox.listAfterSeq(2)
  assert.deepEqual(after2.map((r) => r.seq), [3, 4])
  const limited = await inbox.listAfterSeq(0, 2)
  assert.deepEqual(limited.map((r) => r.seq), [1, 2])
})

test('markTurn is first-writer-wins and get returns the stored record', async () => {
  const inbox = createMemoryIntakeInbox()
  const { record } = await inbox.accept(messageEvent('fake', 'evt-1', 'hello'))
  assert.equal(await inbox.markTurn(record.id, 'run-1'), true)
  assert.equal((await inbox.get(record.id))?.turnId, 'run-1')
  assert.equal(await inbox.markTurn(record.id, 'run-2'), false, 'second writer loses')
  assert.equal((await inbox.get(record.id))?.turnId, 'run-1')
  assert.equal(await inbox.markTurn('missing', 'run-3'), false)
})

test('list returns newest first for admin surfaces', async () => {
  const inbox = createMemoryIntakeInbox()
  for (let i = 1; i <= 3; i++) await inbox.accept(messageEvent('fake', `evt-${i}`, `m${i}`))
  const listed = await inbox.list!()
  assert.deepEqual(listed.map((r) => r.seq), [3, 2, 1])
  assert.deepEqual((await inbox.list!({ limit: 2 })).map((r) => r.seq), [3, 2])
})
