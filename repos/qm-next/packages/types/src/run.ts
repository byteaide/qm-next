/**
 * Run queue contract: durable turns between intake and execution.
 *
 * Lease semantics: `claim` hands a run to a worker under a lease token with a
 * TTL; the worker heartbeats to extend it, then completes or fails the run.
 * Expired leases are reaped back to pending or parked. Both the in-memory and
 * Postgres implementations must satisfy these semantics identically (lane A
 * parity tests).
 */
import type { TurnInput, TurnResult } from './turn.ts'

export type RunStatus = 'pending' | 'running' | 'done' | 'failed'

export interface ReapEvent {
  runId: string
  sessionId: string
  workerId: string | null
  attempts: number
  errorAttempts: number
  outcome: 'requeued' | 'parked'
}

export interface RunDeliveryState {
  editRef?: string
}

export interface Run {
  id: string
  sessionId: string
  status: RunStatus
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

  fail(runId: string, leaseToken: string, error: string, opts?: { retry?: boolean }): Promise<{ requeued: boolean }>

  setDeliveryState(runId: string, leaseToken: string | null, state: RunDeliveryState): Promise<boolean>

  /**
   * Slice 2.4 — create a Continuation Attempt in the SAME Run (no
   * successor Run). The Run transitions back to `running`. The
   * Suspended Attempt stays in the Run's history; this method only
   * advances the active Attempt pointer.
   *
   * Returns `false` when the Run does not exist, is already in a
   * terminal state, or the new attempt id collides with an existing
   * one. Idempotent on the same `(runId, commandRequestId)` pair —
   * duplicate calls return `false` so repeated delivery cannot create
   * a second Continuation Attempt (ADR-0010 §"Repeated delivery").
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
   * Returns `false` when the Run does not exist or is already
   * terminal. Idempotent — duplicate calls return `false`.
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
    opts?: { maxAgeMs?: number; onReap?: (event: ReapEvent) => void },
  ): Promise<{ requeued: number; parked: number }>

  waitFor(runId: string, timeoutMs?: number): Promise<Run>

  close?(): Promise<void>
}

const TERMINAL = new Set<RunStatus>(['done', 'failed'])

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.has(status)
}

export function errorParks(run: Pick<Run, 'errorAttempts' | 'maxAttempts' | 'attempts'>, maxClaims?: number): boolean {
  return run.errorAttempts + 1 >= run.maxAttempts || (maxClaims !== undefined && run.attempts >= maxClaims)
}

export function leaseLapsed(run: Pick<Run, 'status' | 'leaseExpiresAt'>, asOf: number): boolean {
  return run.status === 'running' && run.leaseExpiresAt !== null && run.leaseExpiresAt <= asOf
}
