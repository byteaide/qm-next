/**
 * Run queue contract: durable turns between intake and execution.
 *
 * Lease semantics: `claim` hands a run to a worker under a lease token with a
 * TTL; the worker heartbeats to extend it, then completes or fails the run.
 * Expired leases are reaped back to pending or parked. Both the in-memory and
 * Postgres implementations must satisfy these semantics identically (lane A
 * parity tests).
 *
 * Phase 1 (2026-09-20 architecture review) — Run-owned lifecycle:
 *   - `targetState` is the target Run lifecycle state (RunState in
 *     `./run-lifecycle.ts`). The legacy `status` field is kept until
 *     Phase 7 cleanup so legacy code paths keep compiling during the
 *     migration window.
 *   - `failureReason` is required when `targetState === 'failed'`.
 *   - `currentAttempt` and `attempts` already track the Attempt identity.
 *     The target Attempt State machine is a separate contract in
 *     `AttemptState`; it is computed from `targetState` plus the durable
 *     event log (Slice 1.2 lands the event log).
 *   - `runSource` declares whether a row was created by the legacy path
 *     (`legacy`) or the target path (`target`). It is the toggle the
 *     rollout flag (`Phase 0 RolloutFlag` for `target.run-observation`)
 *     checks at write time; the architecture gate rejects new
 *     `runSource = 'target'` rows that still write `'done'` as the
 *     legacy status.
 *
 * Linked ADRs: ADR-0001 (Run owns terminal state), ADR-0005 (legacy
 * projection), ADR-0011 (Run/Attempt states separate), ADR-0013
 * (state + event commit together).
 */
import type { TurnInput, TurnResult } from './turn.ts'
import type { FailureReason, RunState } from './run-lifecycle.ts'

export type RunStatus = 'pending' | 'running' | 'done' | 'failed'

/**
 * Whether a Run row was written by the legacy write path (`legacy`)
 * or the target write path (`target`). The target path is gated by
 * `target.run-observation` (Phase 0 RolloutFlag); when the flag is
 * off, all writes go through the legacy path even on services that
 * have been migrated. The architecture gate rejects any
 * `runSource: 'target'` row whose `status === 'done'` literal is
 * physically present.
 */
export type RunSource = 'legacy' | 'target'

export interface ReapEvent {
  runId: string
  sessionId: string
  workerId: string | null
  attempts: number
  errorAttempts: number
  /**
   * Slice 1.3 — outcome of a reap pass on a single Run.
   *   - `requeued` — lease expired or max-age reached; the Run is
   *     restored to `pending` so a worker can re-claim it.
   *   - `parked` — lease expired AND the Run has exhausted its retry
   *     budget; the Run is moved to `failed`.
   *   - `skipped_newer_session` — the lease expired but a newer
   *     Session has an active continuation reservation on the same
   *     Session id (ADR-0010 / ADR-0001); the reaper leaves the Run
   *     row alone so the newer Session's Run can complete.
   */
  outcome: 'requeued' | 'parked' | 'skipped_newer_session'
}

/**
 * ADR-0010 continuation executor — the durable Approval Continuation
 * mirrored on the Run row. Written atomically by
 * `suspendForApproval`; survives process restarts so the continuation
 * lane can resume the saved command point exactly once.
 */
export interface RunPendingApproval {
  /** Durable Approval Request id (the `ApprovalStore` registry id). */
  requestId: string
  /** Stable command-point identity replayed on resume. */
  commandRequestId: string
  /** Identifier of the Suspended Attempt being resumed. */
  attemptId: string
  /** Wall-clock epoch ms when the Attempt was suspended. */
  suspendedAt: number
}

export interface RunDeliveryState {
  editRef?: string
  /**
   * Slice 2.4 — idempotency key of the last Approval Continuation
   * Attempt (ADR-0010). Repeated delivery of the same approval decision
   * must not create a second Continuation Attempt.
   */
  lastCommandRequestId?: string
  /** Slice 2.4 — id of the active Continuation Attempt within this Run. */
  currentAttemptId?: string
  /**
   * ADR-0010 continuation executor — present while the Run is
   * `awaiting_approval`. Cleared by `beginContinuationAttempt` only in
   * the sense that the pointer moves on: the record is retained so the
   * continuation lane can build the resume `TurnInput.approval`.
   */
  pendingApproval?: RunPendingApproval
}

/**
 * Input for `RunStore.suspendForApproval` (ADR-0010 continuation
 * executor). `result` is the `pending_approval` TurnResult snapshot
 * that surfaces (wire/IM cards) read while the Run is suspended.
 */
export interface RunSuspension {
  requestId: string
  commandRequestId: string
  attemptId: string
  suspendedAt: number
  result: TurnResult
}

export interface Run {
  id: string
  sessionId: string
  /** Legacy Run status. `done` is the legacy terminal success state. */
  status: RunStatus
  /**
   * Target Run state (ADR-0001). Defaults to `'queued'` for legacy
   * rows that did not record a target state at write time. The
   * migration projection (§1.5) lifts legacy rows into target
   * semantics on read; the durable value lands when the rollout
   * flag flips.
   */
  targetState: RunState
  /**
   * Closed set of reasons a Run may have failed (Phase 0). Required
   * when `targetState === 'failed'`; absent otherwise.
   */
  failureReason?: FailureReason
  /**
   * Source path the Run was written from. Production writes that go
   * through the target contract set `target`; everything else is
   * `legacy`. The architecture gate asserts no `target` rows carry
   * the literal `'done'`.
   */
  runSource: RunSource
  request: TurnInput
  result: TurnResult | null
  deliveryState: RunDeliveryState | null
  dedupKey: string | null
  attempts: number
  errorAttempts: number
  maxAttempts: number
  leaseToken: string | null
  leaseExpiresAt: number | null
  workerId: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface EnqueueInput {
  sessionId: string
  request: TurnInput
  dedupKey?: string
  maxAttempts?: number
}

export interface EnqueueResult {
  run: Run
  deduped: boolean
}

export interface RunStore {
  readonly maxClaims?: number

  enqueue(input: EnqueueInput): Promise<EnqueueResult>

  claim(workerId: string, ttlMs: number): Promise<Run | null>

  claimById(runId: string, workerId: string, ttlMs: number): Promise<Run | null>

  heartbeat(runId: string, leaseToken: string, ttlMs: number): Promise<boolean>

  releaseLease(runId: string, leaseToken: string): Promise<boolean>

  complete(runId: string, leaseToken: string, result: TurnResult): Promise<boolean>

  fail(runId: string, leaseToken: string, error: string, opts?: { retry?: boolean; failureReason?: FailureReason }): Promise<{ requeued: boolean }>

  setDeliveryState(runId: string, leaseToken: string | null, state: RunDeliveryState): Promise<boolean>

  /**
   * ADR-0010 continuation executor — suspend the Run for Approval:
   * transitions `targetState` to `awaiting_approval`, releases the
   * executor lease, and records the durable Approval Continuation in
   * `deliveryState.pendingApproval` together with the
   * `pending_approval` result snapshot the surfaces read.
   *
   * The Run is NOT claimable while suspended (`status` stays
   * `'running'`, lease is `null`) and is invisible to the reaper
   * (`leaseLapsed` requires a live lease). Awaiting Approval is
   * non-terminal — no terminal listener fires.
   *
   * Returns `false` when the Run does not exist, the lease token does
   * not match, the Run is terminal, or it is already suspended.
   */
  suspendForApproval?(
    runId: string,
    leaseToken: string,
    suspension: RunSuspension,
  ): Promise<boolean>

  /**
   * ADR-0010 continuation executor — claim the oldest
   * continuation-claimable Run: a Run that `beginContinuationAttempt`
   * flipped back to `'running'` with no executor lease and a retained
   * `deliveryState.pendingApproval`. The lease attaches WITHOUT
   * bumping `attempts` (the Continuation Attempt was already counted
   * at `beginContinuationAttempt` time).
   *
   * Returns `null` when no continuation-claimable Run exists. Durable
   * discovery: safe across process restarts — the acceptance property
   * "restart between approval and resume still resumes exactly once"
   * rides on this method plus the `lastCommandRequestId` idempotency
   * guard.
   */
  claimNextContinuation?(workerId: string, ttlMs: number): Promise<Run | null>

  /**
   * Slice 2.4 — create a Continuation Attempt in the SAME Run (no
   * successor Run). ADR-0010 continuation executor: the Run becomes
   * continuation-claimable — `status`/`targetState` return to
   * `'running'` with the executor lease released, and the continuation
   * lane claims it via `claimNextContinuation`. The Suspended Attempt
   * stays in the Run's history; `deliveryState.pendingApproval` is
   * retained so the lane can build the resume `TurnInput.approval`.
   *
   * Guarded: returns `false` when the Run does not exist, is already
   * in a terminal state, is NOT `awaiting_approval` (a live or queued
   * Run is never re-driven by a stale decision), or the same
   * `commandRequestId` was already delivered. That idempotency is the
   * exactly-once guarantee for repeated approval decision delivery
   * (ADR-0010 §"Repeated delivery").
   */
  beginContinuationAttempt?(
    runId: string,
    newAttemptId: string,
    commandRequestId: string,
  ): Promise<boolean>

  /**
   * Slice 2.4 — fail the same Run with `approval_denied` or
   * `approval_expired` (ADR-0010). The rejected/expired command never
   * executes; the Run is terminal after this call.
   *
   * ADR-0010 continuation executor guard: only an `awaiting_approval`
   * Run may be failed from a decision — a Run that already resumed
   * (continuation claimable/claimed) is left alone so a late TTL sweep
   * or duplicate decision can never kill live work.
   *
   * Returns `false` when the Run does not exist, is already
   * terminal, or is not `awaiting_approval`. Idempotent — duplicate
   * calls return `false`.
   */
  failFromApproval?(runId: string, failureReason: 'approval_denied' | 'approval_expired'): Promise<boolean>

  onTerminal(listener: (run: Run) => void): void

  get(runId: string): Promise<Run | null>

  activeForThread(sessionId: string): Promise<Run | null>

  inFlightForThread(sessionId: string): Promise<Run[]>

  withdraw(runId: string): Promise<boolean>

  activeSessionIds(): Promise<string[]>

  list(opts?: { limit?: number }): Promise<Run[]>

  reapExpired(
    onRetired?: (sessionIds: string[]) => Promise<void>,
    opts?: {
      maxAgeMs?: number
      onReap?: (event: ReapEvent) => void
      /**
       * Slice 1.3 — newer-Session overlap check. Called for every
       * candidate Run whose lease has expired. When it returns `true`,
       * the reaper emits a `skipped_newer_session` event and leaves
       * the Run row alone. The RunStore does not import
       * `@qm/concurrency` directly; the caller (typically the reaper)
       * wraps `SessionReservationStore.listActiveForSession` into this
       * callback.
       */
      isNewerSession?: (run: Run) => Promise<boolean>
    },
  ): Promise<{ requeued: number; parked: number; skippedNewerSession: number }>

  waitFor(runId: string, timeoutMs?: number): Promise<Run>

  close?(): Promise<void>
}

const TERMINAL = new Set<RunStatus>(['done', 'failed'])

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.has(status)
}

/**
 * Slice 1.5 — terminal-state check on the *target* state machine.
 * Used by `settle()` so target rows (which never write the legacy
 * `status='done'` literal) still fire the terminal listener when the
 * targetState reaches `succeeded` / `failed` / `cancelled`. Legacy
 * rows also pass this check because every legacy terminal write
 * already sets `targetState` to the same value (`succeeded` on
 * `complete`, `failed` on `retire`).
 */
export function isTerminalTargetState(state: RunState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
}

export function errorParks(run: Pick<Run, 'errorAttempts' | 'maxAttempts' | 'attempts'>, maxClaims?: number): boolean {
  return run.errorAttempts + 1 >= run.maxAttempts || (maxClaims !== undefined && run.attempts >= maxClaims)
}

export function leaseLapsed(run: Pick<Run, 'status' | 'leaseExpiresAt'>, asOf: number): boolean {
  return run.status === 'running' && run.leaseExpiresAt !== null && run.leaseExpiresAt <= asOf
}

/**
 * Phase 1 — Target Run state from a legacy status. The legacy status
 * `'done'` is ambiguous: it covers `succeeded`, `silent success`, and
 * `command_refused` (which the target model distinguishes via
 * `FailureReason`). Legacy rows are projected to target states at read
 * time so the call site observes one well-typed shape regardless of
 * whether the write path was legacy or target.
 *
 * Phase 1 ships the projection; the durable `targetState` lands when
 * the rollout flag flips (§1.5). Until then, every call to a target
 * observation port goes through `projectLegacyStatus` and the result
 * is the source of truth for the API/Web surface.
 */
export function projectLegacyStatus(
  status: RunStatus,
  opts: { result?: TurnResult | null; failureReason?: FailureReason | null } = {},
): RunState {
  if (status === 'pending') return 'queued'
  if (status === 'running') return 'running'
  if (status === 'failed') {
    const reason = opts.failureReason ?? null
    if (reason === 'command_refused') return 'failed'
    if (reason === 'approval_denied') return 'failed'
    if (reason === 'approval_expired') return 'failed'
    if (reason === 'approval_continuation_unavailable') return 'failed'
    if (reason === 'timeout') return 'failed'
    if (reason === 'cancelled') return 'cancelled'
    return 'failed'
  }
  // status === 'done'
  const resultStatus = opts.result?.status
  if (resultStatus === 'silent') return 'succeeded'
  if (resultStatus === 'refused') return 'failed'
  if (resultStatus === 'failed') return 'failed'
  if (resultStatus === 'pending_approval') return 'failed'
  return 'succeeded'
}

/**
 * Phase 1 — Project a `Run` row to its target terminal outcome. For
 * non-terminal rows the function returns `null`; callers project
 * themselves via `projectLegacyStatus`.
 */
export function projectLegacyOutcome(run: Pick<Run, 'status' | 'targetState' | 'result' | 'failureReason'>): 'succeeded' | 'failed' | 'cancelled' | null {
  const state = run.targetState
  if (state === 'succeeded') return 'succeeded'
  if (state === 'failed') return 'failed'
  if (state === 'cancelled') return 'cancelled'
  if (run.status === 'done') {
    const resultStatus = run.result?.status
    if (resultStatus === 'silent') return 'succeeded'
    if (resultStatus === 'refused') return 'failed'
    if (resultStatus === 'failed') return 'failed'
    if (resultStatus === 'pending_approval') return 'failed'
    return 'succeeded'
  }
  return null
}

/**
 * Phase 1 — Validate that a Run row written by the target path does
 * not carry the legacy `'done'` literal as its `status`. The
 * architecture gate enforces the same rule at static-check time; this
 * helper is the runtime guard used by store implementations and by
 * the rollout-flag-on write path.
 */
export function assertTargetRunInvariant(run: Pick<Run, 'runSource' | 'status' | 'targetState' | 'failureReason'>): void {
  if (run.runSource !== 'target') return
  if (run.status === 'done') {
    throw new Error(
      'architecture violation: target Run row carries legacy status `done`; use `targetState = succeeded`',
    )
  }
  if (run.targetState === 'failed' && run.failureReason === undefined) {
    throw new Error('architecture violation: target Run row with targetState=`failed` requires a FailureReason')
  }
  if (run.targetState !== 'failed' && run.failureReason !== undefined) {
    throw new Error('architecture violation: target Run row with failureReason but targetState != `failed`')
  }
}
