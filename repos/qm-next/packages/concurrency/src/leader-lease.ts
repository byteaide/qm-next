/**
 * Phase 4 §4.6 — the memory leader-lease primitive. Lives in
 * `@qm/concurrency` (a neutral package) so neither API nor Triggers
 * needs to import the other: both import this primitive, and
 * `@qm/triggers/src/lease.ts` re-exports it for backward compatibility.
 * Backs the scheduler tick so multiple scheduler instances coordinate
 * without double-firing; the durable once-per-slot gate remains
 * `CronStore.claimSlot`.
 */

export interface LeaderLease {
  hold<T>(key: string, fn: () => Promise<T>): Promise<T | null>
  close?(): Promise<void>
}

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
