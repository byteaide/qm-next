/**
 * Fake clock fixture for deterministic lifecycle tests.
 *
 * `FakeClock` is a manually-advanced time source. Tests call `advance` to
 * move time forward and `setNow` to jump to a specific epoch. The clock
 * is consumed by `createMemoryLeaseStore`, `createMemorySessionReservationStore`,
 * and the in-memory `SequenceAllocator` so that the contract suite can
 * exercise expiry / TTL semantics without sleeping.
 *
 * Linked ADRs: ADR-0001 (lease discipline), ADR-0010 (TTL lifecycle).
 */

export interface Clock {
  now(): number
}

export interface FakeClock extends Clock {
  /** Current wall-clock value in epoch ms. */
  readonly now: () => number
  /** Advance by `ms` and return the new current time. */
  advance(ms: number): number
  /** Jump to an absolute epoch ms. */
  setNow(ms: number): void
  /** Subscribe to time advancement; useful for the event subscriber harness. */
  onAdvance(listener: (newNow: number) => void): () => void
}

export function createFakeClock(startMs = 1_700_000_000_000): FakeClock {
  let now = startMs
  const listeners = new Set<(n: number) => void>()
  return {
    now: () => now,
    advance(ms) {
      now += ms
      for (const l of listeners) l(now)
      return now
    },
    setNow(ms) {
      now = ms
      for (const l of listeners) l(now)
    },
    onAdvance(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** Wall-clock clock for production code paths; used by the Postgres twin. */
export const wallClock: Clock = { now: () => Date.now() }
