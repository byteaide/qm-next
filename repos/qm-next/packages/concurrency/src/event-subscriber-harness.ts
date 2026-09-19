/**
 * Event subscriber harness: collects events delivered to a
 * `TargetRunEventBus.subscribe(...)` listener so tests can assert
 * ordering and replay semantics. Reusable across memory and Postgres
 * implementations of the bus.
 */
import type { EventCursor, TargetRunEvent, TargetRunEventBus } from '@qm/types'

export interface EventSubscriberHarness {
  /** Snapshot of events received in delivery order. */
  events: readonly TargetRunEvent[]
  /** Subscribe and start collecting from the given cursor. */
  subscribe(from: EventCursor): () => void
  /** Wait until `n` events have been delivered (test-side helper). */
  waitFor(n: number, opts?: { timeoutMs?: number }): Promise<void>
  /** Reset collected events (test-only). */
  reset(): void
}

export function createEventSubscriberHarness(bus: TargetRunEventBus): EventSubscriberHarness {
  const collected: TargetRunEvent[] = []
  return {
    get events() {
      return [...collected]
    },
    subscribe(from) {
      return bus.subscribe(from, (event) => {
        collected.push(event)
      })
    },
    async waitFor(n, opts) {
      const deadline = Date.now() + (opts?.timeoutMs ?? 1000)
      while (collected.length < n) {
        if (Date.now() > deadline) {
          throw new Error(`event subscriber harness timed out waiting for ${n} events (got ${collected.length})`)
        }
        await new Promise((r) => setTimeout(r, 5))
      }
    },
    reset() {
      collected.length = 0
    },
  }
}
