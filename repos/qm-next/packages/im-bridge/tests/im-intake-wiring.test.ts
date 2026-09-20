/**
 * Phase 5 wiring (ADR-0008/0015): the composed intake path — registry
 * emit → durable inbox → fan-out → bridge subscriber → bridge.sink —
 * with the REAL turn bridge, run store, and Turn-identity tracker.
 * Verifies one Turn per distinct delivery, the same Turn identity on
 * redelivery after a simulated crash, and that the bridge subscriber
 * skips records that already carry their Turn identity.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMemoryIntakeCursorStore,
  createMemoryIntakeDeadLetterStore,
  createMemoryIntakeInbox,
  createIntakeFanout,
} from '@qm/im-core/runtime'
import type { InboundMessageEvent } from '@qm/im-core'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { ResolutionService } from '@qm/types'
import { createImTurnBridge, type ImTurnBridge } from '../src/bridge.ts'
import { createBridgeIntakeSubscriber, createBridgeTurnTracker } from '../src/intake-subscriber.ts'

function resolution(): ResolutionService {
  return {
    resolve: async () => ({ systemPrompt: 'test', orgScopeId: 'org:test' }),
    scopeFor: () => 'org:test',
  }
}

function messageEvent(eventId: string, overrides: Partial<InboundMessageEvent> = {}): InboundMessageEvent {
  return {
    kind: 'message',
    provider: 'fake',
    instanceId: 'test',
    eventId,
    occurredAt: 1_000,
    receivedAt: 2_000,
    destination: { type: 'fake', target: 'oc_chat1' },
    actor: { providerUserId: 'u1', displayName: 'User One' },
    text: 'hello bot',
    mentionedBot: true,
    ...overrides,
  }
}

interface Wiring {
  runs: ReturnType<typeof createMemoryRunStore>
  inbox: ReturnType<typeof createMemoryIntakeInbox>
  fanout: ReturnType<typeof createIntakeFanout>
  bridge: ImTurnBridge
  stop(): Promise<void>
}

async function setupWiring(sinkThrowOnFirstCall = false): Promise<Wiring> {
  const runs = createMemoryRunStore()
  const sessions = createMemorySessionStore()
  const inbox = createMemoryIntakeInbox()
  const cursors = createMemoryIntakeCursorStore()
  const deadLetters = createMemoryIntakeDeadLetterStore()
  const tracker = createBridgeTurnTracker(inbox)
  const bridge = createImTurnBridge({ runs, sessions, resolution: resolution(), im: { get: () => undefined, listProviderIds: () => [] } }, { onTurnCreated: (eventId, runId) => tracker.onTurnCreated(eventId, runId) })
  const subscriber = createBridgeIntakeSubscriber(
    sinkThrowOnFirstCall
      ? {
          ...bridge,
          sink: async (events) => {
            const result = bridge.sink(events)
            await result
            throw new Error('simulated crash after Turn creation')
          },
        }
      : bridge,
    tracker,
  )
  const fanout = createIntakeFanout({ inbox, cursors, deadLetters, subscribers: [subscriber], backoffMs: 0, maxAttempts: 3 })
  await bridge.start()
  return {
    runs,
    inbox,
    fanout,
    bridge,
    stop: async () => {
      await fanout.stop()
      await bridge.stop()
    },
  }
}

test('composed path: one delivery creates one Turn and records the identity on the record', async () => {
  const w = await setupWiring()
  try {
    const { record } = await w.fanout.ingest(messageEvent('evt-1'))
    await w.fanout.drain()
    const runs = await w.runs.list()
    assert.equal(runs.length, 1)
    assert.equal((await w.inbox.get(record.id))?.turnId, runs[0]!.id, 'intake record carries the Turn identity')
    assert.equal(await w.fanout.lag('bridge'), 0)
  } finally {
    await w.stop()
  }
})

test('redelivery of the same eventId creates no second Turn', async () => {
  const w = await setupWiring()
  try {
    await w.fanout.ingest(messageEvent('evt-1'))
    const dup = await w.fanout.ingest(messageEvent('evt-1'))
    assert.equal(dup.duplicate, true)
    await w.fanout.drain()
    await w.fanout.drain()
    assert.equal((await w.runs.list()).length, 1)
  } finally {
    await w.stop()
  }
})

test('crash after Turn creation: restart maps the redelivery to the same Turn', async () => {
  const w = await setupWiring(true)
  try {
    const { record } = await w.fanout.ingest(messageEvent('evt-1'))
    await w.fanout.drain()
    const runs = await w.runs.list()
    assert.equal(runs.length, 1, 'Turn created before the simulated crash')
    assert.equal((await w.inbox.get(record.id))?.turnId, runs[0]!.id, 'identity recorded despite the crash')
    assert.equal(await w.fanout.lag('bridge'), 1, 'cursor did not advance')

    await w.fanout.drain()
    const all = await w.runs.list()
    assert.equal(all.length, 1, 'no second Turn on redelivery')
    assert.equal(await w.fanout.lag('bridge'), 0, 'cursor advanced via the idempotent skip')
  } finally {
    await w.stop()
  }
})
