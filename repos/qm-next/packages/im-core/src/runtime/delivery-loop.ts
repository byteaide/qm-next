/**
 * Delivery claim loop: wakes on enqueue, claims per provider under a lease,
 * applies operations through the provider, acks successes, fails with
 * exponential backoff, parks at maxAttempts, and drains on stop.
 * Claim/ack/retry semantics ported from qm's DeliveryStore poller.
 */
import type {
  ImDelivery,
  ImDeliveryLoop,
  ImDeliveryLoopOptions,
  ImDeliveryQueue,
  ImProviderLike,
} from '../delivery.ts'
import type { ImLogger } from '../provider.ts'

const DEFAULT_TICK_MS = 1_000
const DEFAULT_CLAIM_TTL_MS = 30_000
const DEFAULT_MAX_PER_CLAIM = 10
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_BACKOFF_MS = 1_000

export function createDeliveryLoop(options: ImDeliveryLoopOptions): ImDeliveryLoop {
  const queue: ImDeliveryQueue = options.queue
  const logger: ImLogger = console
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS
  const claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS
  const maxPerClaim = options.maxPerClaim ?? DEFAULT_MAX_PER_CLAIM
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS

  const inFlight = new Set<Promise<void>>()
  let running = false
  let ticking = false
  let timer: NodeJS.Timeout | undefined
  let offEnqueued: (() => void) | undefined

  async function applyDelivery(provider: ImProviderLike, delivery: ImDelivery): Promise<void> {
    const tracked = (async () => {
      try {
        if (delivery.attempts > maxAttempts) {
          await queue.fail(delivery.id, `surrendered after ${delivery.attempts - 1} attempts: ${delivery.lastError ?? 'unknown'}`, { park: true })
          logger.warn(`im: delivery ${delivery.id} parked after ${delivery.attempts - 1} attempts`)
          return
        }
        await provider.outbound([delivery.op])
        await queue.ack(delivery.id)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        const retryInMs = backoffMs * 2 ** Math.max(0, delivery.attempts - 1)
        await queue.fail(delivery.id, message, { retryInMs })
        logger.warn(`im: delivery ${delivery.id} failed (attempt ${delivery.attempts}), retry in ${retryInMs}ms:`, message)
      }
    })().finally(() => {
      inFlight.delete(tracked)
    })
    inFlight.add(tracked)
    return tracked
  }

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      for (const providerId of options.registry.listProviderIds()) {
        const provider = options.registry.get(providerId)
        if (!provider) continue
        const claimed = await queue.claim(providerId, { ttlMs: claimTtlMs, max: maxPerClaim })
        for (const delivery of claimed) {
          await applyDelivery(provider, delivery)
        }
      }
    } finally {
      ticking = false
    }
  }

  return {
    async start(): Promise<void> {
      if (running) return
      running = true
      offEnqueued = queue.onEnqueued(() => {
        void tick()
      })
      timer = setInterval(() => {
        void tick()
      }, tickMs)
      timer.unref?.()
      await tick()
    },
    async stop(): Promise<void> {
      if (!running) return
      running = false
      offEnqueued?.()
      offEnqueued = undefined
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight])
      }
    },
  }
}
