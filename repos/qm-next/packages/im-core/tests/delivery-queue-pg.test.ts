/**
 * Postgres delivery queue: the durable twin runs the same contract suite
 * as the memory queue (idempotency, lease claim, retry/park, list).
 * Cases activate when QM_NEXT_PG_URL points at a reachable server.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostgresDeliveryQueue } from '@qm/im-core/runtime'

const pgUrl = process.env.QM_NEXT_PG_URL

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function sendOp(chatId: string) {
  return {
    op: 'send' as const,
    destination: { type: 'fake', target: chatId },
    body: { text: 'hello' },
  }
}

test('postgres delivery queue: idempotent enqueue, lease claim, ack', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  const queue = createPostgresDeliveryQueue(pgUrl!)
  t.after(() => queue.close())
  const wakes: number[] = []
  queue.onEnqueued(() => wakes.push(1))

  const first = await queue.enqueue({ provider: 'pgtest', op: sendOp('c1'), idempotencyKey: 'pg:run:1' })
  const duplicate = await queue.enqueue({ provider: 'pgtest', op: sendOp('c1'), idempotencyKey: 'pg:run:1' })
  assert.equal(duplicate.id, first.id)
  assert.equal(wakes.length, 1, 'wake fires only for new keys')

  await queue.enqueue({ provider: 'pgtest', op: sendOp('c2'), idempotencyKey: 'pg:run:2' })
  await queue.enqueue({ provider: 'other', op: sendOp('c3'), idempotencyKey: 'pg:run:3' })

  const claimed = await queue.claim('pgtest', { ttlMs: 30, max: 10 })
  assert.equal(claimed.length, 2, 'only the provider match is claimed')
  assert.ok(claimed.every((d) => d.attempts === 1))
  const duringLease = await queue.claim('pgtest', { ttlMs: 30, max: 10 })
  assert.equal(duringLease.length, 0, 'leased deliveries are not re-claimable')

  await sleep(40)
  const afterLease = await queue.claim('pgtest', { ttlMs: 30, max: 10 })
  assert.equal(afterLease.length, 2, 'expired leases are claimable again')
  assert.ok(afterLease.every((d) => d.attempts === 2))

  await queue.ack(afterLease[0]!.id)
  const stored = await queue.get(afterLease[0]!.id)
  assert.ok(stored?.deliveredAt, 'ack marks delivered')
  assert.equal((await queue.claim('pgtest', { ttlMs: 30, max: 10 })).length, 1, 'acked never re-claims')
})

test('postgres delivery queue: fail retries after delay, park is terminal, list newest-first', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  const queue = createPostgresDeliveryQueue(pgUrl!)
  t.after(() => queue.close())

  const d1 = await queue.enqueue({ provider: 'pgfail', op: sendOp('c1'), idempotencyKey: 'pg:f:1' })
  const d2 = await queue.enqueue({ provider: 'pgfail', op: sendOp('c2'), idempotencyKey: 'pg:f:2' })
  await queue.claim('pgfail', { ttlMs: 100, max: 10 })

  await queue.fail(d1.id, 'provider 5xx', { retryInMs: 10_000 })
  const failed = await queue.get(d1.id)
  assert.equal(failed?.lastError, 'provider 5xx')
  assert.equal((await queue.claim('pgfail', { ttlMs: 100, max: 10 })).length, 0, 'retry delay holds')

  await queue.fail(d2.id, 'unsupported', { park: true })
  const parked = await queue.get(d2.id)
  assert.ok(parked?.parkedAt, 'parked timestamp set')
  assert.equal((await queue.claim('pgfail', { ttlMs: 100, max: 10 })).length, 0, 'parked never re-claims')

  const listed = await queue.list!({ limit: 10 })
  assert.ok(listed.length >= 2)
  assert.equal(listed[0]!.id, d2.id, 'newest first')
})

test('postgres delivery queue: origin and op payloads round-trip', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  const queue = createPostgresDeliveryQueue(pgUrl!)
  t.after(() => queue.close())

  const d = await queue.enqueue({
    provider: 'pgorigin',
    op: sendOp('c9'),
    idempotencyKey: 'pg:o:1',
    origin: { runId: 'r1', surface: 'cron', fireKey: 'cron:x:1', sourceThreadRef: 'cron:x' },
  })
  const stored = await queue.get(d.id)
  assert.deepEqual(stored?.origin, { runId: 'r1', surface: 'cron', fireKey: 'cron:x:1', sourceThreadRef: 'cron:x' })
  assert.deepEqual(stored?.op, sendOp('c9'))
})
