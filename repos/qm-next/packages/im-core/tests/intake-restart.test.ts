/**
 * Phase 5 restart safety (plan gate §4, ADR-0008): restart recovers
 * in-flight intake without duplicate outbound replies; duplicate
 * delivery after restart creates one Turn; accepted intake maps to the
 * same Turn identity on retry (markTurn, first-writer-wins).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createIntakeFanout,
  createMemoryIntakeCursorStore,
  createMemoryIntakeDeadLetterStore,
  createMemoryIntakeInbox,
  type ImIntakeCursorStore,
  type ImIntakeDeadLetterStore,
  type ImIntakeInbox,
  type IntakeRecord,
  type IntakeSubscriber,
} from '@qm/im-core/runtime'
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
    actor: { providerUserId: 'u1' },
    text,
  }
}

/** Stands in for the bridge subscriber's Turn creation + markTurn. */
function fakeBridgeSubscriber(inbox: ImIntakeInbox, turns: Map<string, string>, failEventIds: Set<string>): IntakeSubscriber {
  return {
    name: 'bridge',
    async handle(record: IntakeRecord) {
      if (record.turnId !== undefined) return
      if (failEventIds.has(record.eventId)) {
        failEventIds.delete(record.eventId)
        // Simulate a crash AFTER the Turn was created and attached but
        // BEFORE the subscriber cursor advanced.
        const runId = `run-for-${record.eventId}`
        turns.set(record.eventId, runId)
        await inbox.markTurn(record.id, runId)
        throw new Error('crashed before cursor advance')
      }
      const existing = [...turns.entries()].find(([, runId]) => runId === `run-for-${record.eventId}`)
      if (!existing) turns.set(record.eventId, `run-for-${record.eventId}`)
    },
  }
}

interface Stores {
  inbox: ImIntakeInbox
  cursors: ImIntakeCursorStore
  deadLetters: ImIntakeDeadLetterStore
}

function fanoutFor(stores: Stores, subscriber: IntakeSubscriber) {
  return createIntakeFanout({
    inbox: stores.inbox,
    cursors: stores.cursors,
    deadLetters: stores.deadLetters,
    subscribers: [subscriber],
    backoffMs: 1,
    maxAttempts: 3,
  })
}

test('duplicate live delivery creates one Turn', async () => {
  const stores = { inbox: createMemoryIntakeInbox(), cursors: createMemoryIntakeCursorStore(), deadLetters: createMemoryIntakeDeadLetterStore() }
  const turns = new Map<string, string>()
  const fanout = fanoutFor(stores, fakeBridgeSubscriber(stores.inbox, turns, new Set()))
  await fanout.ingest(messageEvent('fake', 'evt-1', 'hello'))
  const dup = await fanout.ingest(messageEvent('fake', 'evt-1', 'hello'))
  assert.equal(dup.duplicate, true)
  await fanout.drain()
  await fanout.drain()
  assert.equal(turns.size, 1, 'one Turn per distinct delivery')
  assert.equal(await fanout.lag('bridge'), 0)
})

test('crash between Turn creation and cursor advance maps to the same Turn on retry', async () => {
  const stores = { inbox: createMemoryIntakeInbox(), cursors: createMemoryIntakeCursorStore(), deadLetters: createMemoryIntakeDeadLetterStore() }
  const turns = new Map<string, string>()
  // First attempt "crashes" after creating + attaching the Turn.
  const crashing = fanoutFor(stores, fakeBridgeSubscriber(stores.inbox, turns, new Set(['evt-1'])))
  await crashing.ingest(messageEvent('fake', 'evt-1', 'hello'))
  await crashing.drain()
  assert.equal(turns.get('evt-1'), 'run-for-evt-1', 'Turn was created before the crash')
  assert.ok((await fanoutFor(stores, fakeBridgeSubscriber(stores.inbox, turns, new Set())).lag('bridge')) > 0, 'cursor did not advance')

  // Restart: a new fanout over the SAME stores redelivers the record.
  const restarted = fanoutFor(stores, fakeBridgeSubscriber(stores.inbox, turns, new Set()))
  await restarted.drain()
  assert.equal(turns.size, 1, 'no second Turn after restart')
  assert.equal(turns.get('evt-1'), 'run-for-evt-1', 'same Turn identity')
  assert.equal(await restarted.lag('bridge'), 0, 'cursor advanced after the idempotent skip')
})

test('duplicate delivery after restart creates one Turn', async () => {
  const stores = { inbox: createMemoryIntakeInbox(), cursors: createMemoryIntakeCursorStore(), deadLetters: createMemoryIntakeDeadLetterStore() }
  const turns = new Map<string, string>()
  const first = fanoutFor(stores, fakeBridgeSubscriber(stores.inbox, turns, new Set()))
  await first.ingest(messageEvent('fake', 'evt-1', 'hello'))
  await first.drain()

  // Provider redelivers the same eventId after the restart.
  const second = fanoutFor(stores, fakeBridgeSubscriber(stores.inbox, turns, new Set()))
  const redelivered = await second.ingest(messageEvent('fake', 'evt-1', 'hello'))
  assert.equal(redelivered.duplicate, true, 'durable inbox still knows the delivery')
  await second.drain()
  assert.equal(turns.size, 1)
})

test('exhausted intake is observable after restart (dead letter survives)', async () => {
  const stores = { inbox: createMemoryIntakeInbox(), cursors: createMemoryIntakeCursorStore(), deadLetters: createMemoryIntakeDeadLetterStore() }
  const failing: IntakeSubscriber = {
    name: 'audit',
    handle: async () => {
      throw new Error('audit sink unavailable')
    },
  }
  const first = createIntakeFanout({ ...stores, subscribers: [failing], backoffMs: 1, maxAttempts: 1 })
  await first.ingest(messageEvent('fake', 'evt-1', 'hello'))
  await first.drain()
  assert.equal((await first.listDeadLetters()).length, 1)

  const second = createIntakeFanout({
    inbox: stores.inbox,
    cursors: stores.cursors,
    deadLetters: stores.deadLetters,
    subscribers: [{ name: 'audit', handle: async () => undefined }],
    backoffMs: 1,
    maxAttempts: 1,
  })
  const letters = await second.listDeadLetters()
  assert.equal(letters.length, 1, 'dead letter survives the restart')
  const replay = await second.replayDeadLetter(letters[0]!.id, { actor: 'admin-1' })
  assert.equal(replay.ok, true)
})
