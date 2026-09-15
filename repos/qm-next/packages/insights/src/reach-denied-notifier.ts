/**
 * Reach-denied notifier (qm `src/insights/reach-denied-notifier.ts`):
 * a leader-lease-gated sweeper that relays `deployment.reach_denied`
 * audit events to an out-of-band `notify` callback, advancing a
 * `ReachDeniedCursor` watermark in a `DurableMap` so a restart resumes
 * cleanly without replaying history.
 */
import type { AuditEvent, AuditLog } from '@qm/admin'
import type { DurableMap } from '@qm/store'
import { createSweeper, type Sweeper } from '@qm/runs'

const LEASE_KEY = 'insights:reach-denied:tick'
const CURSOR_KEY = 'reach-denied-notify'
const TAIL_LIMIT = 200

export interface ReachDeniedCursor {
  lastAt: number
}

const NEVER_LOST = new Promise<void>(() => {})

/**
 * A single-leader gating primitive. `hold` invokes `fn` while the caller
 * is the leader for `key`, returning `null` if the lease is not held.
 * `fn` receives a `lost` promise that resolves when the lease is lost
 * mid-execution so callers can abort.
 */
export interface ReachDeniedLeaderLease {
  hold<T>(key: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null>
}

export function createNoopLeaderLease(): ReachDeniedLeaderLease {
  return {
    async hold<T>(_key: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null> {
      return fn(NEVER_LOST)
    },
  }
}

export interface ReachDeniedNotifierDeps {
  auditLog: AuditLog
  cursors: DurableMap<ReachDeniedCursor>
  notify: (e: AuditEvent) => Promise<void>
  leaderLease?: ReachDeniedLeaderLease
  now?: () => number
}

export function createReachDeniedNotifier(deps: ReachDeniedNotifierDeps): Sweeper {
  const lease = deps.leaderLease ?? createNoopLeaderLease()
  const sweep = async (): Promise<void> => {
    const cursor = (await deps.cursors.get(CURSOR_KEY)) ?? { lastAt: deps.now?.() ?? Date.now() }
    const fresh = (
      await deps.auditLog.tail({ limit: TAIL_LIMIT, action: 'deployment.reach_denied', since: cursor.lastAt })
    )
      .slice()
      .sort((a, b) => a.at - b.at)
    for (const e of fresh) {
      await deps.notify(e)
      await deps.cursors.put(CURSOR_KEY, { lastAt: e.at })
    }
    if (fresh.length === 0 && !(await deps.cursors.get(CURSOR_KEY))) {
      await deps.cursors.put(CURSOR_KEY, cursor)
    }
  }
  return createSweeper(() => lease.hold(LEASE_KEY, () => sweep()), 60_000, {
    label: 'reach-denied-notifier',
    immediate: true,
  })
}