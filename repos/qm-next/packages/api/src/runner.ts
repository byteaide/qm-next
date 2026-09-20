/**
 * Turn runner: claims queued runs and executes them through the orchestrator.
 * Single-worker stand-in for qm's distributed pool; the lease semantics come
 * from the run-store contract unchanged (claim under TTL, complete or fail).
 *
 * Phase 7 / KV-006 cutover — the runner owns Run-terminal event production:
 * after the RunStore commits the terminal transition, the typed `run.finished`
 * event is published through the target event log (seq from the
 * SequenceAllocator, subscribers notified after the publish commit). A
 * requeueing failure publishes the non-terminal `attempt.finished` instead so
 * the stream stays open for the next attempt (ADR-0001, ADR-0013).
 *
 * ADR-0010 continuation executor (owner decision A, 2026-09-20) — this
 * runner is the executor that was missing:
 *   - When a turn returns `pending_approval`, the runner suspends the SAME
 *     Run instead of completing it: durable Approval Request (`approvals`),
 *     Session Continuation Reservation (`reservations`), `suspendForApproval`
 *     store transition (awaiting_approval + executor-lease release + durable
 *     Approval Continuation), then `attempt.suspended` + `approval.requested`
 *     events. Without the continuation ports wired it fails closed with
 *     `approval_continuation_unavailable` — a pending approval never
 *     completes as success again.
 *   - A claimable continuation lane runs before the fresh-claim lane every
 *     tick: `claimNextContinuation` gives durable discovery, so a restart
 *     between approval and resume still resumes exactly once (the
 *     `lastCommandRequestId` guard blocks double execution).
 *   - The Session Continuation Reservation is released only after the
 *     terminal Run Event has been persisted (plan §2.6 release order).
 *
 * Linked ADRs: ADR-0001, ADR-0010, ADR-0013.
 */
import { errMessage } from '@qm/store'
import { releaseApprovalReservation } from '@qm/runs'
import {
  APPROVAL_DEFAULT_TTL_MS,
  type ApprovalRequestInput,
  type ApprovalStore,
  type Orchestrator,
  type Run,
  type RunStore,
  type SessionReservationStore,
  type TargetRunEventBus,
  type TargetRunEventDraft,
  type TurnResult,
} from '@qm/types'

/** Distributive draft without the envelope addressing fields. */
type RunnerEventDraft = TargetRunEventDraft extends infer T
  ? T extends { runId: string; sessionId: string }
    ? Omit<T, 'runId' | 'sessionId'>
    : never
  : never

export interface TurnRunnerOptions {
  workerId?: string
  ttlMs?: number
  tickMs?: number
  /**
   * Deploy-drain gate (21.0): when false the runner stops claiming new
   * runs (in-flight turns finish); a newer build generation went live.
   */
  canClaim?: () => boolean
}

export interface TurnRunner {
  /** Claims and executes at most one pending run; true when it did. */
  pollOnce(): Promise<boolean>
  start(): void
  stop(): Promise<void>
}

export function createTurnRunner(
  deps: {
    orchestrator: Orchestrator
    runs: RunStore
    runEventLog?: TargetRunEventBus
    /**
     * ADR-0010 continuation executor ports. When either is absent the
     * runner fails a paused turn closed with
     * `approval_continuation_unavailable` instead of completing it.
     */
    approvals?: ApprovalStore
    reservations?: SessionReservationStore
  },
  opts: TurnRunnerOptions = {},
): TurnRunner {
  const workerId = opts.workerId ?? `api-${process.pid}`
  const ttlMs = opts.ttlMs ?? 30_000
  const tickMs = opts.tickMs ?? 25
  let timer: NodeJS.Timeout | null = null
  let polling = false
  // Publication is awaited by pollOnce: the terminal frame must be in
  // the durable log before the claim loop considers the run done, so
  // subscribers joining at terminal state never miss it.
  const publish = async (runId: string, sessionId: string, draft: RunnerEventDraft): Promise<void> => {
    await deps.runEventLog?.publish({ ...draft, runId, sessionId } as TargetRunEventDraft).catch(() => undefined)
  }
  /** §2.6 release order — call only after the terminal event published. */
  const releaseReservation = async (run: Run): Promise<void> => {
    if (!deps.reservations) return
    await releaseApprovalReservation(deps.reservations, {
      sessionId: run.sessionId,
      runId: run.id,
      terminalEventPersisted: true,
    }).catch(() => undefined)
  }
  /**
   * Approval pause with no executor support must never complete as
   * success: fail the Run closed with the dedicated FailureReason.
   */
  const failClosed = async (run: Run, reason: string): Promise<void> => {
    await deps.runs.fail(run.id, run.leaseToken!, reason, {
      retry: false,
      failureReason: 'approval_continuation_unavailable',
    })
    await publish(run.id, run.sessionId, {
      kind: 'run.finished',
      outcome: 'failed',
      failureReason: 'approval_continuation_unavailable',
    })
  }
  /**
   * ADR-0010 suspend flow: durable Approval Request → Session
   * Continuation Reservation → `suspendForApproval` (awaiting_approval
   * + executor-lease release + durable Approval Continuation) →
   * `attempt.suspended` + `approval.requested` events. Non-terminal —
   * no `run.finished` here.
   */
  const suspendForApproval = async (run: Run, result: TurnResult): Promise<void> => {
    const primary = result.pendingApprovals?.[0]
    if (!primary || !deps.approvals || !deps.runs.suspendForApproval) {
      await failClosed(run, 'approval continuation unavailable: executor ports not wired')
      return
    }
    const attemptId = `${run.id}:${run.attempts}`
    let requestId: string
    let ttlMs: number
    try {
      const input: ApprovalRequestInput = {
        runId: run.id,
        attemptId,
        requesterPrincipalId: run.request.actor.id,
        attemptState: 'suspended',
        commandRequestId: primary.requestId,
        sessionRef: run.sessionId,
        commandClass: 'tool_approval',
        ...(primary.command ? { commandRawText: primary.command } : {}),
      }
      const request = await deps.approvals.create(input)
      requestId = request.id
      ttlMs = request.ttlMs || APPROVAL_DEFAULT_TTL_MS
    } catch (err) {
      await failClosed(run, `approval continuation unavailable: ${errMessage(err)}`)
      return
    }
    if (deps.reservations) {
      await deps.reservations.reserve(run.sessionId, run.id, ttlMs).catch(() => undefined)
    }
    const suspended = await deps.runs.suspendForApproval(run.id, run.leaseToken!, {
      requestId,
      commandRequestId: primary.requestId,
      attemptId,
      suspendedAt: Date.now(),
      result,
    })
    if (!suspended) {
      await failClosed(run, 'approval continuation unavailable: lease lost before suspend')
      return
    }
    await publish(run.id, run.sessionId, {
      kind: 'attempt.suspended',
      attemptRef: attemptId,
      approvalRequestId: requestId,
    })
    await publish(run.id, run.sessionId, {
      kind: 'approval.requested',
      requestId,
      commandRequestId: primary.requestId,
    })
  }
  /**
   * ADR-0010 continuation lane: resume the saved command point in the
   * SAME Run — the resume `TurnInput.approval` carries the durable
   * request + command identity, never a blind replay of the original
   * text. The reservation releases only after the terminal Run Event
   * is persisted (plan §2.6).
   */
  const executeContinuation = async (run: Run): Promise<void> => {
    const pending = run.deliveryState?.pendingApproval
    if (!pending) return
    try {
      const result = await deps.orchestrator.handleTurn({
        ...run.request,
        runId: run.id,
        approval: {
          requestId: pending.requestId,
          approved: true,
          commandRequestId: pending.commandRequestId,
        },
      })
      if (result.status === 'pending_approval') {
        // Re-paused on the next gate in the same Run — suspend again.
        await suspendForApproval(run, result)
        return
      }
      const committed = await deps.runs.complete(run.id, run.leaseToken!, result)
      if (committed) {
        await publish(run.id, run.sessionId, { kind: 'run.finished', outcome: 'succeeded' })
      }
      await releaseReservation(run)
    } catch (err) {
      const { requeued } = await deps.runs.fail(run.id, run.leaseToken!, errMessage(err))
      if (requeued) {
        await publish(run.id, run.sessionId, { kind: 'attempt.finished', attemptState: 'failed' })
      } else {
        await publish(run.id, run.sessionId, {
          kind: 'run.finished',
          outcome: 'failed',
          failureReason: 'execution_failed',
        })
        await releaseReservation(run)
      }
    }
  }
  const runner: TurnRunner = {
  async pollOnce() {
    if (polling) return false
    if (opts.canClaim && !opts.canClaim()) return false
    polling = true
      try {
        // Continuation lane first: an approved continuation claims
        // before fresh work so the waiting session resumes next tick.
        if (deps.runs.claimNextContinuation) {
          const continuation = await deps.runs.claimNextContinuation(workerId, ttlMs)
          if (continuation) {
            await executeContinuation(continuation)
            return true
          }
        }
        const run = await deps.runs.claim(workerId, ttlMs)
        if (!run) return false
        try {
          // Session Continuation Reservation gate (plan §2.3/§2.6): a
          // new same-Session Run goes straight back to queued while
          // another Run's reservation is held. Exact for the
          // single-runner deployment; multi-runner narrows to a
          // claim-then-release window.
          if (deps.reservations) {
            const holders = await deps.reservations.listActiveForSession(run.sessionId).catch(() => [] as string[])
            if (holders.some((id) => id !== run.id)) {
              if (run.leaseToken !== null) {
                await deps.runs.releaseLease(run.id, run.leaseToken).catch(() => undefined)
              }
              return true
            }
          }
          const result = await deps.orchestrator.handleTurn({ ...run.request, runId: run.id })
          if (result.status === 'pending_approval') {
            await suspendForApproval(run, result)
            return true
          }
          const committed = await deps.runs.complete(run.id, run.leaseToken!, result)
          if (committed) {
            // The store stamps targetState='succeeded' on complete;
            // silent turns ride the same outcome. Approval pauses take
            // the suspend path above and never reach this line.
            await publish(run.id, run.sessionId, { kind: 'run.finished', outcome: 'succeeded' })
          }
        } catch (err) {
          const { requeued } = await deps.runs.fail(run.id, run.leaseToken!, errMessage(err))
          if (requeued) {
            await publish(run.id, run.sessionId, { kind: 'attempt.finished', attemptState: 'failed' })
          } else {
            await publish(run.id, run.sessionId, {
              kind: 'run.finished',
              outcome: 'failed',
              failureReason: 'execution_failed',
            })
          }
        }
        return true
      } finally {
        polling = false
      }
    },
    start() {
      if (timer) return
      timer = setInterval(() => {
        void runner.pollOnce().catch(() => undefined)
      }, tickMs)
      timer.unref()
    },
    async stop() {
      if (!timer) return
      clearInterval(timer)
      timer = null
    },
  }
  return runner
}
