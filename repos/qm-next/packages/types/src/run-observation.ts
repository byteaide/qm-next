/**
 * Target Run Observation contract — implements ADR-0001 (snapshot + cursor
 * replay/live) and ADR-0014 (observation redacts secrets in depth).
 *
 * The legacy in-memory `RunEventBus` (`./run-events.ts`) keeps M3's web
 * surface running during migration; new writes must use the typed
 * envelope below. Persistence shape is the same on memory and Postgres
 * implementations; both pass the contract suite in `tests/lifecycle`.
 *
 * Note on naming: the legacy module reserves `RunEvent` / `RunEventBus` /
 * `RunEventDraft`. The target contract uses the `Target*`-prefixed names
 * below so that both can coexist in `@qm/types` during the migration
 * window. Phase 1 cuts over Run Observation and the legacy aliases in
 * `./run-events.ts` are deleted.
 */
import type { EventCursor, RunSnapshot } from './run-lifecycle.ts'

/** Envelope fields every Run Event carries. `seq` is monotonic per Run. */
interface TargetRunEventEnvelope {
  runId: string
  sessionId: string
  seq: number
  /** Wall-clock epoch ms; monotonic within a Run but not relied on for ordering. */
  ts: number
}

/** Attempt-scoped identity on non-terminal execution events. */
export interface TargetAttemptIdentity {
  attemptId: string
  /** 1-based attempt number within the Run. */
  attemptSeq: number
}

interface TargetBaseRunEvent extends TargetRunEventEnvelope {
  /** Optional Attempt identity — present on non-terminal execution events. */
  attempt?: TargetAttemptIdentity
  /** Opaque redaction marker; presence means producer-side redaction. */
  redactions?: readonly string[]
}

export interface TargetRunCreatedEvent extends TargetBaseRunEvent {
  kind: 'run.created'
}

export interface TargetAttemptQueuedEvent extends TargetBaseRunEvent {
  kind: 'attempt.queued'
}

export interface TargetAttemptStartedEvent extends TargetBaseRunEvent {
  kind: 'attempt.started'
}

export interface TargetAttemptSuspendedEvent extends TargetBaseRunEvent {
  kind: 'attempt.suspended'
  /** Stable identifier of the Suspended Attempt; consumed by Approval Continuation. */
  attemptRef: string
  /** Approval Request the Attempt is waiting on, if any. */
  approvalRequestId?: string
}

export interface TargetAttemptResumedEvent extends TargetBaseRunEvent {
  kind: 'attempt.resumed'
  attemptRef: string
  approvalRequestId?: string
}

export interface TargetAttemptFinishedEvent extends TargetBaseRunEvent {
  kind: 'attempt.finished'
  attemptState: 'succeeded' | 'failed' | 'cancelled'
}

export interface TargetRunFinishedEvent extends TargetBaseRunEvent {
  kind: 'run.finished'
  outcome: 'succeeded' | 'failed' | 'cancelled'
  failureReason?: import('./run-lifecycle.ts').FailureReason
}

export interface TargetApprovalRequestedEvent extends TargetBaseRunEvent {
  kind: 'approval.requested'
  requestId: string
  commandRequestId: string
}

export interface TargetApprovalDecidedEvent extends TargetBaseRunEvent {
  kind: 'approval.decided'
  requestId: string
  approved: boolean
  decisionTtl?: number
}

export interface TargetApprovalExpiredEvent extends TargetBaseRunEvent {
  kind: 'approval.expired'
  requestId: string
}

export interface TargetRunCancelledEvent extends TargetBaseRunEvent {
  kind: 'run.cancelled'
  reason: import('./run-lifecycle.ts').FailureReason | 'cancelled'
}

/** Optional, non-authoritative, redacted assistant/progress delta. */
export interface TargetProgressEvent extends TargetBaseRunEvent {
  kind: 'progress'
  /** Redacted excerpt only; raw assistant text never enters the log. */
  redactedExcerpt: string
}

export interface TargetCommandGateDecisionEvent extends TargetBaseRunEvent {
  kind: 'command.gate.decision'
  commandRequestId: string
  decision: 'allow' | 'deny' | 'require_approval'
}

/** Target Run Event — typed envelope that crosses the durable boundary. */
export type TargetRunEvent =
  | TargetRunCreatedEvent
  | TargetAttemptQueuedEvent
  | TargetAttemptStartedEvent
  | TargetAttemptSuspendedEvent
  | TargetAttemptResumedEvent
  | TargetAttemptFinishedEvent
  | TargetRunFinishedEvent
  | TargetApprovalRequestedEvent
  | TargetApprovalDecidedEvent
  | TargetApprovalExpiredEvent
  | TargetRunCancelledEvent
  | TargetProgressEvent
  | TargetCommandGateDecisionEvent

/**
 * Producer-side draft missing allocator-assigned envelope fields. The
 * producer supplies addressing (`runId`, and `sessionId` where the event
 * kind carries it); `seq` comes from the `SequenceAllocator` and `ts`
 * from the bus — producers never assign either (§2.5).
 */
type TargetDraft<T extends TargetRunEvent> = T extends TargetRunEventEnvelope
  ? Omit<T, 'seq' | 'ts'>
  : never
export type TargetRunEventDraft = TargetDraft<TargetRunEvent>

/**
 * Producer-side factory: `TargetRunEventBus` mutates a draft into a
 * fully addressed event. Producers never assign `seq` themselves — that
 * path is a Phase 0 architecture violation (§2.5 of the implementation
 * plan).
 */
export interface TargetRunEventBus {
  /** Allocate the next monotonic `seq` for a Run and stamp the envelope. */
  publish(event: TargetRunEventDraft): Promise<TargetRunEvent>
  /** Read the durable snapshot of the Run, projected from the event log. */
  snapshot(runId: string): Promise<RunSnapshot | null>
  /** Replay events starting strictly after `cursor.seq` (exclusive). */
  replay(from: EventCursor): Promise<readonly TargetRunEvent[]>
  /**
   * Live subscription. Notifications occur only after the producing
   * transaction has committed (ADR-0013): pre-commit publishing is a
   * boundary violation.
   */
  subscribe(from: EventCursor, listener: (event: TargetRunEvent) => void): () => void
  /** Mark the Run stream closed at terminal state; later `publish` calls throw. */
  closeTerminal(runId: string): Promise<void>
}

/**
 * Read-only Run Observation view exposed to API and Web. Internally the
 * durable log is the source of truth; this interface only projects.
 *
 * Authorization (ADR-0014 §3): possession of a `runId` is never
 * authorization. Callers pass an authorization token whose visibility
 * resolution is the caller's responsibility; this port does not bypass it.
 */
export interface TargetRunObservation {
  snapshot(runId: string, auth: RunVisibilityToken): Promise<RunSnapshot | null>
  replay(from: EventCursor, auth: RunVisibilityToken): Promise<readonly TargetRunEvent[]>
  subscribe(
    from: EventCursor,
    auth: RunVisibilityToken,
    listener: (event: TargetRunEvent) => void,
  ): () => void
}

/**
 * Authorization token presented to Run Observation. The runtime resolves
 * `sessionId → visible principals` and grants access iff the caller's
 * principal is in that set or is an internal principal with reach.
 *
 * Production code MUST construct this from a Session-derived principal
 * check; construction here is opaque on purpose so that we can later
 * rotate the visibility logic without changing every call site.
 */
export interface RunVisibilityToken {
  readonly sessionId: string
  readonly callerPrincipalId: string
  readonly scope: 'principal' | 'internal' | 'system'
}
