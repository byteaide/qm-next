/**
 * Slice 2.6 — Session Continuation Reservation release-order helper.
 *
 * The plan §2.6 boundary rule is unambiguous:
 *
 *   1. Decision (approval / rejection / expiry) is processed and the
 *      Run state transition is **durable**.
 *   2. Terminal Run Event (`approval.decided` or `approval.expired`)
 *      is persisted.
 *   3. The Session Continuation Reservation is released **only after**
 *      step 2.
 *   4. Only after step 3 does any new same-Session Run leave `queued`.
 *
 * Releasing the Reservation before step 2 would leave a window where
 * another Run observes an empty reservation but the Awaiting Approval
 * Run is not yet terminal. This is a Phase 2 boundary check.
 *
 * `SessionReservationStore.release(sessionId, runId, opts)` already
 * accepts a `terminalStateConfirmed: true` flag (Phase 1 / ADR-0010).
 * This module is the orchestrator that threads the boundary:
 *
 *   - The caller proves step 2 by passing `terminalEventPersisted: true`
 *     after persisting the terminal Run Event.
 *   - The helper then calls `release({ terminalStateConfirmed: true })`
 *     — the underlying port rejects the call without that flag.
 *   - On any attempt to release without the proof, the helper ticks
 *     `SESSION_RESERVATION_RELEASE_ORDER_VIOLATION_TOTAL` and refuses
 *     to call `release()`.
 *
 * Linked ADRs: 0010 (Approval suspends the same Run),
 * 0012 (Approvals are requester-scoped and expire).
 */
import type { ReservationReleaseResult, SessionReservationStore } from '@qm/types'
import {
  bumpReservationReleaseOrderViolation,
  createRunMetricsRegistry,
  type RunMetricsRegistry,
} from './observability.ts'

export interface ReleaseApprovalReservationOptions {
  /** Optional metrics registry override (test injection). */
  metrics?: RunMetricsRegistry
}

export interface ReleaseApprovalReservationInput {
  sessionId: string
  /** Run id that owned the reservation — must match `requesterPrincipalId`
   *  semantics (the same Run id that acquired the reservation). */
  runId: string
  /**
   * Slice 2.6 step 2 — caller's proof that the terminal Run Event has
   * been persisted before this release. When `false` the helper
   * refuses to release and increments the violation counter.
   */
  terminalEventPersisted: boolean
  now?: number
}

/**
 * Release a Session Continuation Reservation after the terminal Run
 * Event has been persisted. Boundary: when
 * `terminalEventPersisted === false` the helper refuses to release and
 * increments `session_reservation_release_order_violation_total`.
 *
 * Returns the underlying `ReservationReleaseResult`. The orchestrator
 * pattern uses this single helper so the boundary check cannot be
 * skipped by direct callers.
 */
export async function releaseApprovalReservation(
  reservations: SessionReservationStore,
  input: ReleaseApprovalReservationInput,
  opts: ReleaseApprovalReservationOptions = {},
): Promise<ReservationReleaseResult> {
  if (!input.terminalEventPersisted) {
    if (opts.metrics) {
      opts.metrics.inc(RUN_METRICS.SESSION_RESERVATION_RELEASE_ORDER_VIOLATION_TOTAL)
    } else {
      bumpReservationReleaseOrderViolation(1)
    }
    return { ok: false, reason: 'terminal_not_confirmed' }
  }
  return reservations.release(input.sessionId, input.runId, {
    terminalStateConfirmed: true,
    ...(input.now !== undefined ? { now: input.now } : {}),
  })
}

/**
 * Convenience overload: same as above but constructs the metrics
 * registry inline. Useful when the caller does not have one wired.
 */
export async function releaseApprovalReservationWithMetrics(
  reservations: SessionReservationStore,
  input: ReleaseApprovalReservationInput,
): Promise<ReservationReleaseResult> {
  return releaseApprovalReservation(reservations, input, {
    metrics: createRunMetricsRegistry(),
  })
}