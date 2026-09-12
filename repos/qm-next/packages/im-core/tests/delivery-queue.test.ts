/**
 * Memory delivery queue: idempotency, lease claim, ack/fail/retry/park.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryDeliveryQueue } from '@qm/im-core/runtime'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function sendOp(chatId: string) {
  return {
    op: 'send' as const,
    destination: { type: 'fake', target: chatId },
    body: { text: 'hello' },
  }
}

test('enqueue is idempotent on idempotencyKey; onEnqueued fires only for new keys', async () => {
  const queue = createMemoryDeliveryQueue()
  const wakes: number[] = []
  queue.onEnqueued(() => wakes.push(1))
  const first = await queue.enqueue({ provider: 'fake', op: sendOp('c1'), idempotencyKey: 'run:1' })
  const duplicate = await queue.enqueue({ provider: 'fake', op: sendOp('c1'), idempotencyKey: 'run:1' })
  assert.equal(duplicate.id, first.id)
  assert.equal(queue.size, 1)
  assert.equal(wakes.length, 1)
})

test('claim hands out pending deliveries under lease with attempts increment', async () => {
  const queue = createMemoryDeliveryQueue()
  await queue.enqueue({ provider: 'fake', op: sendOp('c1'), idempotencyKey: 'run:1' })
  await queue.enqueue({ provider: 'fake', op: sendOp('c2'), idempotencyKey: 'run:2' })
  await queue.enqueue({ provider: 'other', op: sendOp('c3'), idempotencyKey: 'run:3' })

  const claimed = await queue.claim('fake', { ttlMs: 20, max: 10 })
  assert.equal(claimed.length, 2, 'only the provider match is claimed')
  assert.ok(claimed.every((d) => d.attempts === 1))

  const duringLease = await queue.claim('fake', { ttlMs: 20, max: 10 })
  assert.equal(duringLease.length, 0, 'leased deliveries are not re-claimable')

  await sleep(30)
  const afterLease = await queue.claim('fake', { ttlMs: 20, max: 10 })
  assert.equal(afterLease.length, 2, 'expired leases are claimable again')
  assert.ok(afterLease.every((d) => d.attempts === 2))
})

test('claim honours max and oldest-first ordering', async () => {
  const queue = createMemoryDeliveryQueue()
  for (let i = 0; i < 5; i++) {
    await queue.enqueue({ provider: 'fake', op: sendOp(`c${i}`), idempotencyKey: `run:${i}` })
    await sleep(1)
  }
  const claimed = await queue.claim('fake', { ttlMs: 100, max: 2 })
  assert.deepEqual(claimed.map((d) => d.idempotencyKey), ['run:0', 'run:1'])
})

test('ack marks delivered; acked deliveries never re-claim', async () => {
  const queue = createMemoryDeliveryQueue()
  const d = await queue.enqueue({ provider: 'fake', op: sendOp('c1'), idempotencyKey: 'run:1' })
  await queue.claim('fake', { ttlMs: 5, max: 10 })
  await queue.ack(d.id)
  const stored = await queue.get(d.id)
  assert.ok(stored?.deliveredAt)
  await sleep(10)
  assert.equal((await queue.claim('fake', { ttlMs: 5, max: 10 })).length, 0)
})

test('fail without park requeues after retryInMs; park is terminal', async () => {
  const queue = createMemoryDeliveryQueue()
  const d1 = await queue.enqueue({ provider: 'fake', op: sendOp('c1'), idempotencyKey: 'run:1' })
  const d2 = await queue.enqueue({ provider: 'fake', op: sendOp('c2'), idempotencyKey: 'run:2' })
  await queue.claim('fake', { ttlMs: 100, max: 10 })

  await queue.fail(d1.id, 'provider 5xx', { retryInMs: 20 })
  const failed = await queue.get(d1.id)
  assert.equal(failed?.lastError, 'provider 5xx')
  assert.equal((await queue.claim('fake', { ttlMs: 100, max: 10 })).length, 0, 'retry delay holds')
  await sleep(25)
  assert.equal((await queue.claim('fake', { ttlMs: 100, max: 10 })).length, 1, 'claimable after retry delay')

  await queue.fail(d2.id, 'unsupported', { park: true })
  await sleep(5)
  const parked = await queue.get(d2.id)
  assert.ok(parked?.parkedAt, 'parked timestamp set')
  assert.equal((await queue.claim('fake', { ttlMs: 100, max: 10 })).length, 0, 'parked never re-claims')
})
