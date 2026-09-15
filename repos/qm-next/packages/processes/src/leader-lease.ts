/**
 * Single-leader gating for the process reaper (mirrors qm's
 * `persistence/leader-lease.ts` contract). `hold` invokes `fn` while the
 * caller is the leader for `key`, returning `null` if the lease is not
 * held; `fn` receives a `lost` promise that resolves when the lease is
 * dropped mid-execution.
 */
const NEVER_LOST = new Promise<void>(() => {})

export interface ReaperLeaderLease {
  hold<T>(key: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null>
}

export function createNoopLeaderLease(): ReaperLeaderLease {
  return {
    async hold<T>(_key: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null> {
      return fn(NEVER_LOST)
    },
  }
}