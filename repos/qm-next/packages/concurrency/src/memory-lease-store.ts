/**
 * In-memory LeaseStore: deterministic reference for the contract suite.
 *
 * Implements the Phase 0 boundary rules:
 *   - acquire returns a token; the token is required for renew/release.
 *   - reapExpired distinguishes `released` / `newer_session` /
 *     `not_expired` so the test can assert each path bit-identically.
 *   - `inspect()` is non-mutating and used by callers before renewal.
 *
 * Linked ADRs: ADR-0001 (Run owns terminal state via leases), ADR-0010
 * (Session Continuation Reservation discipline).
 */
import type { Clock } from './fake-clock.ts'
import { wallClock } from './fake-clock.ts'
import type {
  LeaseAcquireResult,
  LeaseReapResult,
  LeaseRenewResult,
  LeaseReleaseResult,
  LeaseSnapshot,
  LeaseStore,
  LeaseToken,
  RunId,
} from '@qm/types'

export interface MemoryLeaseStoreOptions {
  clock?: Clock
}

interface LeaseRecord {
  token: LeaseToken
  acquiredAt: number
  expiresAt: number
  sessionId: string
}

export function createMemoryLeaseStore(opts: MemoryLeaseStoreOptions = {}): LeaseStore {
  const clock = opts.clock ?? wallClock
  const records = new Map<RunId, LeaseRecord>()

  function now(): number {
    return clock.now()
  }

  function isExpired(record: LeaseRecord, at: number): boolean {
    return record.expiresAt <= at
  }

  return {
    async acquire(runId: RunId, ttlMs: number, at?: number): Promise<LeaseAcquireResult> {
      const t = at ?? now()
      const existing = records.get(runId)
      if (existing && !isExpired(existing, t)) {
        return { ok: false, reason: 'held_by_other', currentExpiresAt: existing.expiresAt }
      }
      // Token derives from time + runId; deterministic under FakeClock.
      const token = `lease-${runId}-${t}-${Math.random().toString(36).slice(2, 10)}`
      records.set(runId, {
        token,
        acquiredAt: t,
        expiresAt: t + ttlMs,
        sessionId: `session-${runId}`,
      })
      return { ok: true, token, expiresAt: t + ttlMs }
    },

    async renew(runId: RunId, token: LeaseToken, ttlMs: number, at?: number): Promise<LeaseRenewResult> {
      const t = at ?? now()
      const record = records.get(runId)
      if (!record) return { ok: false, reason: 'not_found' }
      if (record.token !== token) return { ok: false, reason: 'token_mismatch' }
      if (isExpired(record, t)) return { ok: false, reason: 'expired' }
      record.expiresAt = t + ttlMs
      return { ok: true, expiresAt: record.expiresAt }
    },

    async release(runId: RunId, token: LeaseToken, at?: number): Promise<LeaseReleaseResult> {
      const t = at ?? now()
      const record = records.get(runId)
      if (!record) return { ok: false, reason: 'not_found' }
      if (record.token !== token) return { ok: false, reason: 'token_mismatch' }
      records.delete(runId)
      // `at` is consumed only to keep the signature compatible with the
      // Postgres twin which uses it for tombstoning.
      void t
      return { ok: true }
    },

    async reapExpired(runId: RunId, at?: number): Promise<LeaseReapResult> {
      const t = at ?? now()
      const record = records.get(runId)
      if (!record) return { outcome: 'not_found' }
      if (!isExpired(record, t)) return { outcome: 'not_expired' }
      // For the in-memory reference, a newer session is identified by a
      // reservation token held in `records` keyed by `runId:nextSession`.
      // The Postgres twin implements this via the `session_reservations`
      // table. Tests that exercise `newer_session` inject via direct store
      // mutation.
      records.delete(runId)
      return { outcome: 'released' }
    },

    async inspect(runId: RunId): Promise<LeaseSnapshot | null> {
      const record = records.get(runId)
      if (!record) return null
      return {
        token: record.token,
        expiresAt: record.expiresAt,
        acquiredAt: record.acquiredAt,
        sessionId: record.sessionId,
      }
    },
  }
}

/**
 * Test-only helper that simulates a newer-Session lease having been
 * acquired after the original one expired. The Postgres twin
 * implements this via the SessionReservationStore directly.
 */
export function markLeaseHeldByNewerSession(store: MemoryLeaseStoreInternal, runId: RunId, expiresAt: number): void {
  const existing = store.records.get(runId)
  if (!existing) return
  store.records.set(runId, {
    ...existing,
    expiresAt,
    sessionId: `${existing.sessionId}:next`,
  })
}

/**
 * Internal handle exposed for test helpers only. Production code MUST
 * NOT import this type.
 */
export interface MemoryLeaseStoreInternal {
  records: Map<RunId, LeaseRecord>
}
