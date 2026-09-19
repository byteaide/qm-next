/**
 * In-memory SessionReservationStore: deterministic reference for the
 * Phase 0 contract suite.
 *
 * Implements the Phase 2 release-order discipline (§2.6 of the
 * implementation plan): the reservation release rejects calls that
 * arrive before the owning Run reaches durable terminal state. Tests
 * pass `terminalStateConfirmed: true` to model the post-terminal case.
 *
 * Linked ADRs: ADR-0010 (Approval suspends the same Run).
 */
import type { Clock } from './fake-clock.ts'
import { wallClock } from './fake-clock.ts'
import type {
  ReservationReleaseResult,
  ReservationResult,
  ReservationSnapshot,
  RunId,
  SessionReservationStore,
} from '@qm/types'

export interface MemorySessionReservationStoreOptions {
  clock?: Clock
}

interface ReservationRecord {
  runId: RunId
  acquiredAt: number
  expiresAt: number
}

export function createMemorySessionReservationStore(
  opts: MemorySessionReservationStoreOptions = {},
): SessionReservationStore {
  const clock = opts.clock ?? wallClock
  const records = new Map<string, ReservationRecord>()

  function now(): number {
    return clock.now()
  }

  return {
    async reserve(sessionId: string, runId: RunId, ttlMs: number, at?: number): Promise<ReservationResult> {
      if (ttlMs <= 0) return { ok: false, reason: 'ttl_invalid' }
      const t = at ?? now()
      const existing = records.get(sessionId)
      if (existing && existing.expiresAt > t && existing.runId !== runId) {
        return { ok: true, acquired: false, currentRunId: existing.runId, expiresAt: existing.expiresAt }
      }
      records.set(sessionId, {
        runId,
        acquiredAt: t,
        expiresAt: t + ttlMs,
      })
      return { ok: true, acquired: true, expiresAt: t + ttlMs }
    },

    async inspect(sessionId: string): Promise<ReservationSnapshot | null> {
      const record = records.get(sessionId)
      if (!record) return null
      return {
        runId: record.runId,
        expiresAt: record.expiresAt,
        acquiredAt: record.acquiredAt,
      }
    },

    async release(
      sessionId: string,
      runId: RunId,
      releaseOpts?: { terminalStateConfirmed?: boolean; now?: number },
    ): Promise<ReservationReleaseResult> {
      void releaseOpts?.now
      const record = records.get(sessionId)
      if (!record) return { ok: false, reason: 'not_found' }
      if (record.runId !== runId) return { ok: false, reason: 'run_mismatch' }
      if (!releaseOpts?.terminalStateConfirmed) {
        return { ok: false, reason: 'terminal_not_confirmed' }
      }
      records.delete(sessionId)
      return { ok: true }
    },

    async listActiveForSession(sessionId: string): Promise<readonly RunId[]> {
      const record = records.get(sessionId)
      if (!record) return []
      if (record.expiresAt <= now()) return []
      return [record.runId]
    },
  }
}
