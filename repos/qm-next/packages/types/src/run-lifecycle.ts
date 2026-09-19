/**
 * Target Run lifecycle types — implements ADR-0001 (Run owns terminal events
 * and observation) and ADR-0011 (Run and Attempt states are separate).
 *
 * Phase 0 freeze: these contracts compile and are referenced by JSDoc from
 * future target paths. Legacy `done`/`pending`/`running` enums in
 * `./run.ts` remain the runtime values during the migration window.
 * New behavior must use the target contracts; legacy paths must not
 * extend.
 *
 * Linked ADRs:
 *   - ADR-0001: Run owns terminal events and observation.
 *   - ADR-0010: Approval suspends the same Run.
 *   - ADR-0011: Run and Attempt states are separate.
 *   - ADR-0013: Run state and events commit together.
 */

/** Closed terminal outcome of a Run. */
export type RunOutcome = 'succeeded' | 'failed' | 'cancelled'

/**
 * Closed set of reasons a Run may have failed. `command_refused` covers
 * Command Gate denial; `approval_denied` / `approval_expired` cover the
 * Awaiting Approval path closing without continuation. Production uses
 * the closed set only — no ad-hoc reason strings on target paths.
 */
export type FailureReason =
  | 'execution_failed'
  | 'timeout'
  | 'cancelled'
  | 'command_refused'
  | 'approval_denied'
  | 'approval_expired'
  | 'approval_continuation_unavailable'

/** Run lifecycle position. Awaiting Approval is non-terminal. */
export type RunState =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

/** Attempt lifecycle position. Suspended is non-terminal and never Run-terminal. */
export type AttemptState =
  | 'queued'
  | 'running'
  | 'suspended'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

/** Monotonic per-Run sequence; persisted as `(run_id, seq)` unique. */
export interface EventCursor {
  runId: string
  seq: number
}

/**
 * Source-neutral snapshot of a Run. Projection only — the durable Run state
 * is the source of truth (ADR-0001). Snapshot consumers read this through
 * `RunObservation.snapshot()` and never assemble it from raw event streams.
 */
export interface RunSnapshot {
  id: string
  sessionId: string
  state: RunState
  outcome?: RunOutcome
  failureReason?: FailureReason
  /** Most recent Attempt; absent when the Run has no Attempt yet. */
  currentAttempt?: AttemptRef
  attempts: number
  /** Cursor of the last persisted event for resume/replay. */
  lastEventSeq?: number
  createdAt: number
  updatedAt: number
}

/** Opaque identifier pointing at a specific Attempt within a Run. */
export interface AttemptRef {
  runId: string
  attemptId: string
  state: AttemptState
  seq: number
}

/**
 * Terminal-vs-non-terminal classifier. Used by the architecture gate to
 * reject `done` on target write paths and by Run Observation to refuse to
 * close a stream whose underlying Run is non-terminal.
 */
export const TERMINAL_RUN_STATES = new Set<RunState>(['succeeded', 'failed', 'cancelled'])
export const TERMINAL_ATTEMPT_STATES = new Set<AttemptState>(['succeeded', 'failed', 'cancelled'])

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state)
}

export function isTerminalAttemptState(state: AttemptState): boolean {
  return TERMINAL_ATTEMPT_STATES.has(state)
}
