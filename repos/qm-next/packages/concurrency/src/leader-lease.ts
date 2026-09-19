/**
 * Tick leases — neutral concurrency primitive (Phase 4 §4.6).
 *
 * Memory impl: single-process holder set, one holder per key. The
 * durable once-per-slot gate remains `CronStore.claimSlot` (Phase 0
 * parity suite). This file exists in `@qm/concurrency` so neither
 * `@qm/api` nor `@qm/triggers` needs to import the other just to share
 * a tick-lease primitive.
 *
 * Linked ADR-0003: API may consume this primitive without importing
 * Trigger impl; Triggers continues to own its own pg lease impl (which
 * uses the @qm/store pg pool and stays behind the Trigger boundary).
 */

/** Tick lease — only one `hold(key, fn)` per key runs at a time. */
export interface LeaderLease {
  hold<T>(key: string, fn: () => Promise<T>): Promise<T | null>
  close?(): Promise<void>
}

/**
 * Process-wide leader lease backed by an in-memory `Set<string>`.
 * One holder per key; concurrent holders observe `null` immediately.
 */
export function createMemoryLeaderLease(): LeaderLease {
  const held = new Set<string>()
  return {
    async hold<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
      if (held.has(key)) return null
      held.add(key)
      try {
        return await fn()
      } finally {
        held.delete(key)
      }
    },
    async close() {},
  }
}