/**
 * In-memory ImDeliveryQueue: tests and single-process dev. Durable
 * deployments swap in the Postgres implementation (run-store pattern,
 * `FOR UPDATE SKIP LOCKED`) without touching callers.
 */
import type {
  ImDelivery,
  ImDeliveryClaimOptions,
  ImDeliveryFailOptions,
  ImDeliveryQueue,
} from '../delivery.ts'

interface QueueState {
  readonly deliveries: Map<string, ImDelivery>
  readonly byKey: Map<string, string>
  readonly nextClaimableAt: Map<string, number>
  readonly listeners: Set<() => void>
}

function createState(): QueueState {
  return {
    deliveries: new Map(),
    byKey: new Map(),
    nextClaimableAt: new Map(),
    listeners: new Set(),
  }
}

export type MemoryDeliveryQueue = ImDeliveryQueue & { readonly size: number }

export function createMemoryDeliveryQueue(): MemoryDeliveryQueue {
  const state = createState()
  const queue: MemoryDeliveryQueue = {
    get size() {
      return state.deliveries.size
    },
    async enqueue(input) {
      const existingId = state.byKey.get(input.idempotencyKey)
      if (existingId) return state.deliveries.get(existingId)!
      const delivery: ImDelivery = {
        id: crypto.randomUUID(),
        idempotencyKey: input.idempotencyKey,
        provider: input.provider,
        op: input.op,
        createdAt: Date.now(),
        attempts: 0,
        deliveredAt: null,
        ...(input.origin ? { origin: input.origin } : {}),
      }
      state.deliveries.set(delivery.id, delivery)
      state.byKey.set(delivery.idempotencyKey, delivery.id)
      for (const listener of state.listeners) listener()
      return delivery
    },
    async claim(provider, options: ImDeliveryClaimOptions) {
      const now = Date.now()
      const max = options.max ?? 10
      const claimable = [...state.deliveries.values()]
        .filter(
          (d) =>
            d.provider === provider &&
            d.deliveredAt === null &&
            d.parkedAt === undefined &&
            (d.leaseExpiresAt ?? 0) <= now &&
            (state.nextClaimableAt.get(d.id) ?? 0) <= now,
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, max)
      for (const d of claimable) {
        d.attempts += 1
        d.leaseExpiresAt = now + options.ttlMs
      }
      return claimable
    },
    async ack(id, at) {
      const d = state.deliveries.get(id)
      if (d && d.deliveredAt === null) d.deliveredAt = at ?? Date.now()
    },
    async fail(id, error, options: ImDeliveryFailOptions = {}) {
      const d = state.deliveries.get(id)
      if (!d) return
      d.lastError = error
      if (options.park) {
        d.parkedAt = Date.now()
        delete d.leaseExpiresAt
        return
      }
      state.nextClaimableAt.set(d.id, Date.now() + (options.retryInMs ?? 0))
      delete d.leaseExpiresAt
    },
    async get(id) {
      return state.deliveries.get(id) ?? null
    },
    onEnqueued(listener) {
      state.listeners.add(listener)
      return () => {
        state.listeners.delete(listener)
      }
    },
  }
  return queue
}
