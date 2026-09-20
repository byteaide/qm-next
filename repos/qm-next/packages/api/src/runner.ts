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
 */
import { errMessage } from '@qm/store'
import type { Orchestrator, RunStore, TargetRunEventBus, TargetRunEventDraft } from '@qm/types'

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
  deps: { orchestrator: Orchestrator; runs: RunStore; runEventLog?: TargetRunEventBus },
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
  const runner: TurnRunner = {
  async pollOnce() {
    if (polling) return false
    if (opts.canClaim && !opts.canClaim()) return false
    polling = true
      try {
        const run = await deps.runs.claim(workerId, ttlMs)
        if (!run) return false
        try {
          const result = await deps.orchestrator.handleTurn({ ...run.request, runId: run.id })
          const committed = await deps.runs.complete(run.id, run.leaseToken!, result)
          if (committed) {
            // The store stamps targetState='succeeded' on complete;
            // approval pauses and silent turns ride the same outcome.
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
