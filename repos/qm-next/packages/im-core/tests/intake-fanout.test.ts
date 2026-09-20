/**
 * Intake fan-out contract (Phase 5, ADR-0008/0015): every named
 * subscriber receives accepted intake over an independent durable
 * cursor; a failing subscriber retries with backoff, never blocks the
 * others, and dead-letters after exhaustion without losing the record;
 * dead letters carry an admin-only redelivery_url and a secret-free
 * last_error; replay is admin-only, audited, never automatic. Asserts
 * the §5.5 metric families tick on the right paths.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAuditSubscriber,
  createIntakeFanout,
  createMemoryIntakeCursorStore,
  createMemoryIntakeDeadLetterStore,
  createMemoryIntakeInbox,
  createMirrorSubscriber,
  type IntakeFanout,
} from '@qm/im-core/runtime'
import type { IntakeRecord, IntakeSubscriber } from '@qm/im-core'
import { createRunMetricsRegistry, RUN_METRICS, type CounterSnapshot } from '@qm/runs'
import type { InboundMessageEvent, IntakeSubscriberContext } from '@qm/im-core'

function messageEvent(eventId: string, text: string): InboundMessageEvent {
  return {
    kind: 'message',
    provider: 'fake',
    instanceId: 'test',
    eventId,
    occurredAt: 1_000,
    receivedAt: 2_000,
    destination: { type: 'fake', target: 'chat-1' },
    actor: { providerUserId: 'u1' },
    text,
  }
}

function counterValue(snapshot: readonly CounterSnapshot[], name: string, labels: Record<string, string>): number {
  const entry = snapshot.find((s) => s.name === name)
  if (!entry) return 0
  const match = entry.byLabels.find(
    (b) => Object.entries(labels).every(([k, v]) => b.labels[k] === v) && Object.keys(b.labels).length === Object.keys(labels).length,
  )
  return match?.value ?? 0
}

function makeClock(start = 0): { now(): number; advance(ms: number): void } {
  let t = start
  return {
    now: () => t,
    advance(ms: number) {
      t += ms
    },
  }
}

interface Fixture {
  fanout: IntakeFanout
  metrics: ReturnType<typeof createRunMetricsRegistry>
  clock: ReturnType<typeof makeClock>
  received: Map<string, IntakeRecord[]>
  failNext: (subscriber: string, times: number, error?: string) => void
}

function makeFixture(subscribers: IntakeSubscriber[]): Fixture {
  const metrics = createRunMetricsRegistry()
  const clock = makeClock()
  const received = new Map<string, IntakeRecord[]>()
  const failures = new Map<string, { left: number; error: string }>()
  for (const s of subscribers) received.set(s.name, [])
  const wrapped: IntakeSubscriber[] = subscribers.map((s) => ({
    name: s.name,
    async handle(record: IntakeRecord, ctx: IntakeSubscriberContext) {
      const f = failures.get(s.name)
      if (f && f.left > 0) {
        f.left -= 1
        throw new Error(f.error)
      }
      received.get(s.name)!.push(record)
      await s.handle(record, ctx)
    },
  }))
  const fanout = createIntakeFanout({
    inbox: createMemoryIntakeInbox(),
    cursors: createMemoryIntakeCursorStore(),
    deadLetters: createMemoryIntakeDeadLetterStore(),
    subscribers: wrapped,
    metrics,
    now: clock.now,
    backoffMs: 10,
    maxAttempts: 3,
  })
  return {
    fanout,
    metrics,
    clock,
    received,
    failNext(subscriber, times, error = 'subscriber down') {
      failures.set(subscriber, { left: times, error })
    },
  }
}

test('fan-out delivers each accepted intake to bridge, mirror and audit', async () => {
  const f = makeFixture([
    { name: 'bridge', handle: async () => undefined },
    createMirrorSubscriber(async () => undefined),
    createAuditSubscriber(async () => undefined),
  ])
  await f.fanout.ingest(messageEvent('evt-1', 'hello'))
  await f.fanout.drain()
  for (const name of ['bridge', 'mirror', 'audit']) {
    assert.equal(f.received.get(name)!.length, 1, `${name} received the record`)
    assert.equal(f.received.get(name)![0]!.eventId, 'evt-1')
  }
  assert.equal(counterValue(f.metrics.snapshot(), RUN_METRICS.IM_INTAKE_DEDUP_TOTAL, { result: 'new' }), 1)
})

test('duplicate delivery ticks dedup=duplicate and dispatches nothing new', async () => {
  const f = makeFixture([{ name: 'bridge', handle: async () => undefined }])
  await f.fanout.ingest(messageEvent('evt-1', 'hello'))
  const dup = await f.fanout.ingest(messageEvent('evt-1', 'hello'))
  assert.equal(dup.duplicate, true)
  await f.fanout.drain()
  await f.fanout.drain()
  assert.equal(f.received.get('bridge')!.length, 1, 'exactly one delivery per subscriber')
  assert.equal(counterValue(f.metrics.snapshot(), RUN_METRICS.IM_INTAKE_DEDUP_TOTAL, { result: 'duplicate' }), 1)
})

test('each subscriber holds an independent cursor; a failing subscriber does not block others', async () => {
  const f = makeFixture([
    { name: 'bridge', handle: async () => undefined },
    { name: 'audit', handle: async () => undefined },
  ])
  f.failNext('audit', 2)
  await f.fanout.ingest(messageEvent('evt-1', 'first'))
  await f.fanout.drain()
  assert.equal(f.received.get('bridge')!.length, 1, 'bridge processed while audit failed')
  assert.equal(f.received.get('audit')!.length, 0)
  assert.equal(await f.fanout.lag('bridge'), 0)
  assert.equal(await f.fanout.lag('audit'), 1)
})

test('failed subscriber retries with backoff and eventually redelivers', async () => {
  const f = makeFixture([{ name: 'audit', handle: async () => undefined }])
  f.failNext('audit', 1)
  await f.fanout.ingest(messageEvent('evt-1', 'first'))
  await f.fanout.drain()
  assert.equal(f.received.get('audit')!.length, 0)
  // Backoff window: backoffMs * 2^0 = 10ms; the clock must advance first.
  await f.fanout.drain()
  assert.equal(f.received.get('audit')!.length, 0, 'backoff holds the redelivery')
  f.clock.advance(11)
  await f.fanout.drain()
  assert.equal(f.received.get('audit')!.length, 1, 'redelivered after backoff')
  assert.equal(await f.fanout.lag('audit'), 0)
  const retry = f.metrics.snapshot().find((s) => s.name === RUN_METRICS.IM_SUBSCRIBER_RETRY_TOTAL)
  assert.ok(retry)
  assert.equal(counterValue(f.metrics.snapshot(), RUN_METRICS.IM_SUBSCRIBER_RETRY_TOTAL, { subscriber: 'audit', outcome: 'fail' }), 1)
  assert.equal(counterValue(f.metrics.snapshot(), RUN_METRICS.IM_SUBSCRIBER_RETRY_TOTAL, { subscriber: 'audit', outcome: 'ok' }), 1)
})

test('exhausted subscriber dead-letters without losing the record; lag gauge tracks', async () => {
  const f = makeFixture([{ name: 'mirror', handle: async () => undefined }])
  f.failNext('mirror', 3)
  await f.fanout.ingest(messageEvent('evt-1', 'poison'))
  for (let i = 0; i < 3; i++) {
    f.clock.advance(100)
    await f.fanout.drain()
  }
  const letters = await f.fanout.listDeadLetters()
  assert.equal(letters.length, 1)
  const letter = letters[0]!
  assert.equal(letter.subscriber, 'mirror')
  assert.equal(letter.eventId, 'evt-1')
  assert.equal(letter.attempts, 3)
  assert.ok(letter.redeliveryUrl.startsWith('/admin/'), 'redelivery_url is the admin operator route')
  assert.ok(letter.redeliveryUrl.includes(letter.id))
  assert.equal(letter.lastError, 'subscriber down')
  assert.equal(letter.redeliveredAt, undefined, 'never auto-replayed')
  // Cursor advanced past the poison record; subsequent intake still flows.
  assert.equal(await f.fanout.lag('mirror'), 0)
  await f.fanout.ingest(messageEvent('evt-2', 'after poison'))
  await f.fanout.drain()
  assert.equal(f.received.get('mirror')!.length, 1)
  assert.equal(f.received.get('mirror')![0]!.eventId, 'evt-2')
  assert.equal(counterValue(f.metrics.snapshot(), RUN_METRICS.IM_SUBSCRIBER_DEAD_LETTER_TOTAL, { subscriber: 'mirror' }), 1)
})

test('last_error is redacted before the dead letter is recorded', async () => {
  const fanout = createIntakeFanout({
    inbox: createMemoryIntakeInbox(),
    cursors: createMemoryIntakeCursorStore(),
    deadLetters: createMemoryIntakeDeadLetterStore(),
    subscribers: [
      {
        name: 'bridge',
        handle: async () => {
          throw new Error('provider call failed with Bearer eyJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ and died')
        },
      },
    ],
    maxAttempts: 1,
    backoffMs: 1,
  })
  await fanout.ingest(messageEvent('evt-1', 'secret-ish'))
  await fanout.drain()
  const letters = await fanout.listDeadLetters()
  assert.equal(letters.length, 1)
  const lastError = letters[0]!.lastError
  assert.ok(!lastError.includes('eyJJJJ'), 'bearer token never enters last_error')
  assert.ok(lastError.includes('[redacted]'))
})

test('admin replay is audited, marked, and never repeats', async () => {
  const audits: unknown[] = []
  let mirrorCalls = 0
  const fanout = createIntakeFanout({
    inbox: createMemoryIntakeInbox(),
    cursors: createMemoryIntakeCursorStore(),
    deadLetters: createMemoryIntakeDeadLetterStore(),
    subscribers: [
      {
        name: 'mirror',
        handle: async (record) => {
          mirrorCalls += 1
          if (mirrorCalls === 1) throw new Error('mirror unavailable')
          void record
        },
      },
    ],
    maxAttempts: 1,
    backoffMs: 1,
    audit: (entry) => audits.push(entry),
  })
  await fanout.ingest(messageEvent('evt-1', 'hello'))
  await fanout.drain()
  const [letter] = await fanout.listDeadLetters()
  assert.ok(letter)
  const replay = await fanout.replayDeadLetter(letter.id, { actor: 'admin-1', at: 42 })
  assert.equal(replay.ok, true)
  if (replay.ok) assert.equal(replay.record.eventId, 'evt-1')
  assert.equal((await fanout.inspectDeadLetter(letter.id))?.redeliveredBy, 'admin-1')
  assert.equal(audits.length, 1)
  const second = await fanout.replayDeadLetter(letter.id, { actor: 'admin-2' })
  assert.deepEqual(second, { ok: false, reason: 'already_redelivered' })
  assert.equal(audits.length, 1, 'no second audit — the replay did not run again')
  const missing = await fanout.replayDeadLetter('nope', { actor: 'admin-1' })
  assert.deepEqual(missing, { ok: false, reason: 'not_found' })
})

test('failed replay returns replay_failed with a secret-free error', async () => {
  const audits: unknown[] = []
  let attempts = 0
  const fanout = createIntakeFanout({
    inbox: createMemoryIntakeInbox(),
    cursors: createMemoryIntakeCursorStore(),
    deadLetters: createMemoryIntakeDeadLetterStore(),
    subscribers: [
      {
        name: 'mirror',
        handle: async () => {
          attempts += 1
          if (attempts <= 2) throw new Error('mirror still down')
        },
      },
    ],
    maxAttempts: 1,
    backoffMs: 1,
    audit: (entry) => audits.push(entry),
  })
  await fanout.ingest(messageEvent('evt-1', 'hello'))
  await fanout.drain()
  const [letter] = await fanout.listDeadLetters()
  assert.ok(letter)
  const replay = await fanout.replayDeadLetter(letter.id, { actor: 'admin-1', at: 42 })
  assert.deepEqual(replay, { ok: false, reason: 'replay_failed', error: 'mirror still down' })
  assert.equal((await fanout.inspectDeadLetter(letter.id))?.redeliveredAt, undefined)
  assert.equal(audits.length, 1, 'failed replay is audited too')
  const again = await fanout.replayDeadLetter(letter.id, { actor: 'admin-1' })
  assert.equal(again.ok, true, 'retry allowed while the letter is not marked redelivered')
})
