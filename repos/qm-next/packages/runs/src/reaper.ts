import type { ReapEvent, Run, RunStore, ScopeId, SessionReservationStore, SessionStore } from '@qm/types'
import { createSweeper } from './sweeper.ts'
import { bumpReaperNewerSessionCounter } from './observability.ts'

export const REAPER_LEASE_KEY = 'runs:reaper'

export interface LeaderLease {
  hold<T>(key: string, fn: () => Promise<T>): Promise<T | null>
  close?(): Promise<void>
}

export function createNoopLeaderLease(): LeaderLease {
  return { hold: async () => null }
}

export interface ReaperErrorSink {
  record(event: {
    category: string
    code: string
    message: string
    scopeLabel: ScopeId
    sessionId?: string
  }): void
}

function recordReapEvent(errors: ReaperErrorSink, e: ReapEvent): void {
  // Slice 1.3 — newer-Session overlap uses a dedicated code so the
  // runbook entry (§1.6) can distinguish it from `requeued` /
  // `parked`. Operators reading the error feed can correlate
  // `run_reap_skipped_newer_session` spikes with the approval
  // continuation rate.
  const code =
    e.outcome === 'parked'
      ? 'run_reap_parked'
      : e.outcome === 'skipped_newer_session'
        ? 'run_reap_skipped_newer_session'
        : 'run_reap_requeued'
  errors.record({
    category: 'runs',
    code,
    message: `run ${e.runId} ${e.outcome} (worker=${e.workerId ?? 'none'}, attempts=${e.attempts}, error_attempts=${e.errorAttempts})`,
    scopeLabel: REAPER_LEASE_KEY as ScopeId,
    sessionId: e.sessionId,
  })
}

export interface Reaper {
  start(): void
  stop(): void
  sweep(): Promise<{ requeued: number; parked: number; skippedNewerSession: number }>
}

async function releaseStrandedSessionLeases(sessions: SessionStore, sessionIds: string[]): Promise<void> {
  for (const threadRef of new Set(sessionIds)) {
    const session = await sessions.getByThread(threadRef)
    if (session) await sessions.forceReleaseLease(session.id)
  }
}

export interface ReaperOptions {
  intervalMs: number
  leaderLease?: LeaderLease
  maxAgeMs?: number
  errors?: ReaperErrorSink
  /**
   * Slice 1.3 — Session Continuation Reservation store. When
   * provided, the reaper wraps `listActiveForSession` into an
   * `isNewerSession` callback so expired leases on a Session that
   * has an active continuation reservation for a *different* Run are
   * skipped instead of reaped (ADR-0010 + ADR-0001). When absent the
   * reaper falls back to the legacy behavior — every expired lease
   * is reaped.
   */
  reservations?: SessionReservationStore
  /**
   * Optional metrics registry (slice 1.6). When provided, the reaper
   * ticks `RUN_METRICS.lease_reaper_newer_session_total` for every
   * `skipped_newer_session` outcome.
   */
  metrics?: { inc(name: string, labels?: Record<string, string>): void }
}

export function createReaper(runs: RunStore, sessions: SessionStore, opts: ReaperOptions): Reaper {
  const leaderLease = opts.leaderLease ?? createNoopLeaderLease()
  const { errors, reservations, metrics } = opts

  // Slice 1.3 — wrap `SessionReservationStore.listActiveForSession`
  // into a `Run`-shaped predicate. The reservation store is keyed by
  // `sessionId` and lists every Run that holds an active reservation;
  // we exclude the Run currently being considered so the predicate
  // only fires when a *different* Run on the same Session is alive.
  const isNewerSession: ((run: Run) => Promise<boolean>) | undefined =
    reservations === undefined
      ? undefined
      : async (run) => {
          const active = await reservations.listActiveForSession(run.sessionId)
          return active.some((rid) => rid !== run.id)
        }

  const reap = async (): Promise<{ requeued: number; parked: number; skippedNewerSession: number }> => {
    const result = await runs.reapExpired(
      (retiredSessionIds) => releaseStrandedSessionLeases(sessions, retiredSessionIds),
      {
        ...(opts.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
        ...(errors ? { onReap: (e: ReapEvent) => recordReapEvent(errors, e) } : {}),
        ...(isNewerSession ? { isNewerSession } : {}),
      },
    )
    if (result.skippedNewerSession > 0) {
      if (metrics) metrics.inc('lease_reaper_newer_session_total', { outcome: 'skipped_newer_session' })
      else bumpReaperNewerSessionCounter(result.skippedNewerSession)
    }
    return result
  }
  const sweeper = createSweeper(
    () => leaderLease.hold(REAPER_LEASE_KEY, reap),
    opts.intervalMs,
  )
  return {
    start: () => sweeper.start(),
    stop: () => sweeper.stop(),
    sweep: reap,
  }
}
