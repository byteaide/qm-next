/**
 * Delivery claim loop: apply+ack, retry with backoff, park at maxAttempts,
 * drain on stop.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ImProviderLike, ImRegistryLike } from '@qm/im-core'
import { createDeliveryLoop, createMemoryDeliveryQueue } from '@qm/im-core/runtime'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function providerLike(overrides: Partial<ImProviderLike> = {}): ImProviderLike {
  return {
    provider: 'fake',
    outbound: async (ops) => ops.map((op) => ({ op: op.op })),
    ...overrides,
  }
}

function registryLike(provider: ImProviderLike): ImRegistryLike {
  return {
    get: () => provider,
    listProviderIds: () => [provider.provider],
  }
}

const sendOp = {
  op: 'send' as const,
  destination: { type: 'fake', target: 'c1' },
  body: { text: 'hi' },
}

test('loop claims, applies through the provider and acks successes', async () => {
  const queue = createMemoryDeliveryQueue()
  const seen: string[] = []
  const provider = providerLike({
    outbound: async (ops) => {
      for (const op of ops) if (op.op === 'send') seen.push(op.destination.target)
      return ops.map((op) => ({ op: op.op }))
    },
  })
  const d = await queue.enqueue({ provider: 'fake', op: sendOp, idempotencyKey: 'run:1' })
  const loop = createDeliveryLoop({ queue, registry: registryLike(provider), tickMs: 10 })
  await loop.start()
  await sleep(40)
  await loop.stop()
  const stored = await queue.get(d.id)
  assert.ok(stored?.deliveredAt, 'delivery acked')
  assert.deepEqual(seen, ['c1'])
})

test('loop retries failed deliveries with backoff until delivered', async () => {
  const queue = createMemoryDeliveryQueue()
  let attempts = 0
  const provider = providerLike({
    outbound: async (ops) => {
      attempts += 1
      if (attempts < 3) throw new Error('flaky')
      return ops.map((op) => ({ op: op.op }))
    },
  })
  const d = await queue.enqueue({ provider: 'fake', op: sendOp, idempotencyKey: 'run:1' })
  const loop = createDeliveryLoop({ queue, registry: registryLike(provider), tickMs: 10, backoffMs: 10 })
  await loop.start()
  await sleep(150)
  await loop.stop()
  const stored = await queue.get(d.id)
  assert.ok(stored?.deliveredAt, `delivered after retries (attempts=${attempts})`)
  assert.equal(attempts, 3)
})

test('loop parks a delivery after maxAttempts and stops claiming it', async () => {
  const queue = createMemoryDeliveryQueue()
  let attempts = 0
  const provider = providerLike({
    outbound: async () => {
      attempts += 1
      throw new Error('permanent failure')
    },
  })
  const d = await queue.enqueue({ provider: 'fake', op: sendOp, idempotencyKey: 'run:1' })
  const loop = createDeliveryLoop({ queue, registry: registryLike(provider), tickMs: 5, backoffMs: 5, maxAttempts: 3 })
  await loop.start()
  await sleep(250)
  await loop.stop()
  const stored = await queue.get(d.id)
  assert.ok(stored?.parkedAt, 'parked at terminal failure')
  assert.ok(stored?.lastError?.includes('permanent failure'))
  const attemptsAtPark = attempts
  await sleep(40)
  assert.equal(attempts, attemptsAtPark, 'no further attempts after parking')
})

test('stop() drains in-flight operations before resolving', async () => {
  const queue = createMemoryDeliveryQueue()
  let finished = false
  const provider = providerLike({
    outbound: async (ops) => {
      await sleep(50)
      finished = true
      return ops.map((op) => ({ op: op.op }))
    },
  })
  const d = await queue.enqueue({ provider: 'fake', op: sendOp, idempotencyKey: 'run:1' })
  const loop = createDeliveryLoop({ queue, registry: registryLike(provider), tickMs: 5 })
  await loop.start()
  await sleep(20)
  await loop.stop()
  assert.equal(finished, true, 'in-flight op settled before stop resolved')
  const stored = await queue.get(d.id)
  assert.ok(stored?.deliveredAt)
})

test('enqueue wakeup triggers a prompt claim without waiting for the tick', async () => {
  const queue = createMemoryDeliveryQueue()
  const provider = providerLike()
  const loop = createDeliveryLoop({ queue, registry: registryLike(provider), tickMs: 60_000 })
  await loop.start()
  const d = await queue.enqueue({ provider: 'fake', op: sendOp, idempotencyKey: 'run:1' })
  await sleep(30)
  const stored = await queue.get(d.id)
  assert.ok(stored?.deliveredAt, 'wakeup delivered without tick')
  await loop.stop()
})
