/**
 * Skill pack sync engine, ported from qm's `skills/skill-sync-engine.ts`:
 * a sweeper tick re-fetches every pack under a leader lease, compares the
 * head SHA against the last successful import, and asks the composition
 * root to reconcile (import / catalog update) any pack whose head has
 * moved. A no-op leader lease is the default; pass a real lease when
 * running multi-instance.
 */
import type { SkillPackStore } from './skill-pack-store.ts'
import type { SkillPackFetcher } from './pack-fetcher.ts'
import { createSweeper, errMessage } from './util.ts'

const TICK_LEASE_KEY = 'skills:sync:tick'
const DEFAULT_INTERVAL_MS = 300_000

export interface SkillSyncEngine {
  tick(now?: number): Promise<void>
  start(intervalMs: number): void
  stop(): void
}

export interface SkillSyncDeps {
  packs: SkillPackStore
  fetcher: SkillPackFetcher
  reconcile: (packId: string) => Promise<unknown>
  leaderLease?: LeaderLease
}

export interface LeaderLease {
  hold<T>(key: string, fn: () => Promise<T>): Promise<T | null>
  close?(): Promise<void>
}

function createNoopLeaderLease(): LeaderLease {
  return {
    async hold<T>(key: string, fn: () => Promise<T>): Promise<T> {
      void key
      return await fn()
    },
  }
}

export function createSkillSyncEngine(deps: SkillSyncDeps): SkillSyncEngine {
  const leaderLease = deps.leaderLease ?? createNoopLeaderLease()

  async function syncOne(packId: string): Promise<void> {
    const pack = await deps.packs.get(packId)
    if (!pack) return
    if (pack.syncMode === 'tracked') {
      const head = await deps.fetcher.resolveRef(pack)
      if (pack.lastImport?.status === 'ok' && head === pack.lastImport.commit) return
      await deps.reconcile(packId)
    } else {
      const head = await deps.fetcher.resolveRef(pack)
      const available = pack.lastImport ? head !== pack.lastImport.commit : false
      if (available !== Boolean(pack.updateAvailable)) {
        await deps.packs.update(packId, { updateAvailable: available })
      }
    }
  }

  async function syncAll(): Promise<void> {
    for (const pack of await deps.packs.list()) {
      try {
        await syncOne(pack.id)
      } catch (e) {
        console.error(`[skill-sync] pack ${pack.id} failed:`, errMessage(e))
      }
    }
  }

  const tick = async (): Promise<void> => {
    await leaderLease.hold(TICK_LEASE_KEY, syncAll)
  }

  const sweeper = createSweeper(
    () => tick().catch((e: unknown) => console.error('[skill-sync] tick failed:', errMessage(e))),
    DEFAULT_INTERVAL_MS,
    { label: 'skill-sync' },
  )
  return { tick, start: sweeper.start, stop: sweeper.stop }
}
