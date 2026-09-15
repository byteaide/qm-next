/**
 * Turn runner: claims queued runs and executes them through the orchestrator.
 * Single-worker stand-in for qm's distributed pool; the lease semantics come
 * from the run-store contract unchanged (claim under TTL, complete or fail).
 */
import { errMessage } from '@qm/store'
import type { Orchestrator, RunStore } from '@qm/types'

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
  deps: { orchestrator: Orchestrator; runs: RunStore },
  opts: TurnRunnerOptions = {},
): TurnRunner {
  const workerId = opts.workerId ?? `api-${process.pid}`
  const ttlMs = opts.ttlMs ?? 30_000
  const tickMs = opts.tickMs ?? 25
  let timer: NodeJS.Timeout | null = null
  let polling = false
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
          await deps.runs.complete(run.id, run.leaseToken!, result)
        } catch (err) {
          await deps.runs.fail(run.id, run.leaseToken!, errMessage(err))
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
