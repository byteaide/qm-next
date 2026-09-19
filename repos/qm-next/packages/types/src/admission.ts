/**
 * Target Admission contracts — implements ADR-0004 (Security Screen in
 * Shadow Mode), ADR-0006 (Admission rejections do not create Runs), and
 * ADR-0007 (Turn Admission is an orchestrator seam).
 *
 * Phase 0 freeze: types compile; runtime Admission lives in
 * `packages/orchestrator` (legacy seam). Phase 3 migrates it onto these
 * contracts.
 */
import type { CommandRequest } from './command-gate.ts'
import type { Conversation } from './conversation.ts'
import type { Principal, ScopeId } from './identity.ts'

/**
 * One Admission Waterfall stage. Order is fixed and the architecture gate
 * verifies short-circuit behavior (§3.1 of `docs/implementation-plan.md`).
 */
export type AdmissionStage =
  | 'identity'
  | 'rate_limit'
  | 'budget'
  | 'screen'
  | 'session'
  | 'dispatch'

export type AdmissionStageDecision = 'allow' | 'deny' | 'error' | 'skipped'

export interface AdmissionStageRecord {
  stage: AdmissionStage
  decision: AdmissionStageDecision
  reason?: string
  /** Latency of the stage, in milliseconds. */
  latencyMs: number
}

/** Modes the Security Screen supports. Shadow records without blocking. */
export type SecurityScreenMode = 'off' | 'shadow' | 'enforce'

export interface SecurityScreenOutcome {
  mode: SecurityScreenMode
  decision: 'allow' | 'deny' | 'unavailable'
  /** Stable rule identity; absent when no rule fired. */
  ruleId?: string
  reason?: string
  /** Redacted excerpt only — producer must redact before constructing this. */
  redactedExcerpt?: string
  ts: number
}

/**
 * Durable evidence of an Admission decision. Rejected work that never
 * becomes a Run is recorded here (ADR-0006). Not a Run Event.
 */
export interface AdmissionRecord {
  /** Stable identity assigned at construction; never reused. */
  id: string
  /** Surface that submitted the work; mirrors `TurnInput.surface`. */
  surface: string
  /** Caller that submitted the work. */
  actor: Principal
  /** Scope the work would have run in, if it was admitted. */
  scopeId?: ScopeId
  /** Final admission outcome. */
  decision: 'accepted' | 'rejected'
  /** Stage that closed the decision (last stage with non-`allow` outcome). */
  closingStage?: AdmissionStage
  /** Per-stage outcomes in waterfall order. */
  stages: readonly AdmissionStageRecord[]
  /** Security Screen outcome, when the screen ran. */
  screen?: SecurityScreenOutcome
  /** Reason text; never contains secrets. */
  reason?: string
  /** Structured rate-limit / budget context, when relevant. */
  context?: {
    rateLimit?: { limit: number; remaining: number; resetMs: number }
    budget?: { remaining: number; unit: string }
  }
  ts: number
}

/** The Admission port consumed by the orchestrator (ADR-0007). */
export interface AdmissionService {
  /**
   * Run the waterfall and return either an Admission Record + accepted
   * command request or an Admission Record describing rejection. Callers
   * MUST treat rejection as a closed outcome — no Run, no Run Events.
   */
  admit(input: AdmissionInput): Promise<AdmissionOutcome>
}

export interface AdmissionInput {
  surface: string
  actor: Principal
  /** Optional structured command request; absent for non-side-effecting work. */
  commandRequest?: CommandRequest
  /** Scope to evaluate against, when already resolved. */
  scopeId?: ScopeId
  /**
   * Optional conversation reference for the session stage. The orchestrator
   * passes this through from `TurnInput.conversation` so the session port
   * can resolve a session without leaking the conversation type into
   * `@qm/types`.
   */
  conversation?: Conversation
}

export type AdmissionOutcome =
  | { decision: 'accepted'; record: AdmissionRecord; commandRequest: CommandRequest }
  | { decision: 'rejected'; record: AdmissionRecord }
