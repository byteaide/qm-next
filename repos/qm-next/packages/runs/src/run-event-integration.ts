/**
 * Run-store → event-log transactional wiring.
 *
 * Phase 1 (2026-09-20 architecture review) — when the runtime is on
 * the target write path (slice 1.5 flips the rollout flag), every
 * terminal state transition (complete / fail) MUST also persist a
 * typed `run.finished` event in the SAME transaction (ADR-0013).
 * Subscriber notification happens only after commit
 * (postgres-run-event-log's `notifyAfterCommit`).
 *
 * This helper is the only place that calls `appendInTx`. Calling it
 * from anywhere else is a Phase 1 boundary violation because the
 * state and event must commit together; splitting them risks
 * observable Run state without a matching event or vice versa.
 *
 * Linked ADRs: ADR-0001, ADR-0013.
 */
import type { PoolClient } from 'pg'
import type { FailureReason, Run, RunOutcome, TargetRunEventDraft } from '@qm/types'
import { RUN_METRICS, type RunMetricsRegistry } from './observability.ts'
import type { PostgresRunEventLog } from '../store/src/postgres-run-event-log.ts'

export interface RunEventDraftInput {
  run: Pick<Run, 'id' | 'sessionId' | 'targetState' | 'failureReason' | 'runSource' | 'attempts'>
  outcome: RunOutcome
  /** Required when outcome === 'failed'. */
  failureReason?: FailureReason
}

/**
 * Build the typed event draft for a Run terminal transition.
 * Centralised here so the wire shape is testable in isolation
 * without touching the database.
 */
export function buildTerminalEventDraft(input: RunEventDraftInput): TargetRunEventDraft {
  const draft: TargetRunEventDraft = {
    kind: 'run.finished',
    runId: input.run.id,
    sessionId: input.run.sessionId,
    outcome: input.outcome,
    ...(input.failureReason ? { failureReason: input.failureReason } : {}),
  }
  return draft
}

/**
 * Append the typed event to the log inside the caller's transaction.
 * The caller is expected to:
 *   1. `BEGIN`
 *   2. UPDATE the Run row
 *   3. call `appendTerminalEvent(tx, log, draft)`
 *   4. `COMMIT`
 *   5. call `log.notifyAfterCommit([event])` to fan out to subscribers
 *
 * Any throw between steps 2 and 4 rolls back the entire transaction
 * (state + event). Subscribers never see a pre-commit event because
 * `appendInTx` deliberately does NOT call notify().
 */
export async function appendTerminalEvent(
  tx: PoolClient,
  log: PostgresRunEventLog,
  draft: TargetRunEventDraft,
  metrics: RunMetricsRegistry,
): Promise<ReturnType<PostgresRunEventLog['appendInTx']>> {
  let event: Awaited<ReturnType<PostgresRunEventLog['appendInTx']>> | undefined
  try {
    event = await log.appendInTx(tx, draft)
    metrics.inc(RUN_METRICS.EVENT_COMMIT_TOTAL, { outcome: terminalOutcomeLabel(draft.kind) })
    return event
  } catch (err) {
    metrics.inc(RUN_METRICS.EVENT_TX_FAILURES_TOTAL, { stage: 'append' })
    if (err instanceof Error && /run_seq_conflict/.test(err.message)) {
      metrics.inc(RUN_METRICS.SEQ_CONFLICT_TOTAL)
    }
    throw err
  }
}

function terminalOutcomeLabel(kind: string): 'terminal' | 'non_terminal' {
  if (kind === 'run.finished' || kind === 'run.cancelled') return 'terminal'
  return 'non_terminal'
}

/**
 * Convenience wrapper used by the worker / orchestrator when they
 * hold the postgres store, the postgres event log, and the metrics
 * registry. Returns the typed event so the caller can stash it for
 * post-commit notification.
 */
export async function completeRunWithEvent(
  tx: PoolClient,
  runId: string,
  sessionId: string,
  outcome: RunOutcome,
  log: PostgresRunEventLog,
  metrics: RunMetricsRegistry,
  failureReason?: FailureReason,
): Promise<void> {
  const draft = buildTerminalEventDraft({
    run: {
      id: runId,
      sessionId,
      targetState: outcome === 'succeeded' ? 'succeeded' : outcome === 'cancelled' ? 'cancelled' : 'failed',
      runSource: 'target',
      attempts: 0,
    },
    outcome,
    failureReason,
  })
  const event = await appendTerminalEvent(tx, log, draft, metrics)
  log.notifyAfterCommit([event])
}