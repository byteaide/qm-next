/**
 * Phase 3 — Turn Admission port contracts.
 *
 * Linked ADRs: 0004 (Security Screen Shadow Mode), 0006 (rejections do not
 * create Runs), 0007 (Admission is an orchestrator seam with a fixed
 * waterfall).
 *
 * The types in `@qm/types/admission.ts` define the durable record shape.
 * This file adds the runtime port contracts the waterfall consumes.
 */
import type { Principal, ScopeId } from '@qm/types'
import type { CommandRequest } from '@qm/types'
import type {
  AdmissionStage,
  AdmissionInput,
  SecurityScreenOutcome,
} from '@qm/types'

/** Per-stage latency plus a structured outcome. */
export interface StageDecision {
  decision: 'allow' | 'deny' | 'error' | 'skipped'
  reason?: string
  latencyMs: number
}

/**
 * Narrow ports for the 6 fixed waterfall stages. ADR-0007 forbids reordering;
 * the architecture gate verifies short-circuit behavior on reject.
 */
export interface IdentityStagePort {
  check(actor: Principal): Promise<StageDecision>
}

export interface RateLimitStagePort {
  check(actorId: string): Promise<
    StageDecision & { limit?: number; remaining?: number; resetMs?: number }
  >
}

export interface BudgetStagePort {
  check(actorId: string): Promise<
    StageDecision & { remaining?: number; unit?: string }
  >
}

export interface ScreenStagePort {
  /**
   * Returns the screener outcome. Implementations MUST redact secrets
   * before returning `redactedExcerpt`. ADR-0004: Shadow records without
   * blocking; Enforce rejects; Off skips.
   */
  screen(input: AdmissionInput): Promise<SecurityScreenOutcome>
}

export interface SessionStagePort {
  /**
   * Single stage covering plan §3.1 step 5 (resolution and Session lease).
   * Returns the resolved session + lease, or a deny decision with reason.
   */
  resolveAndLease(input: AdmissionInput): Promise<
    | {
        decision: 'allow'
        sessionId: string
        scopeId: ScopeId
        leaseToken: unknown
        systemPrompt: string
        orgScopeId: ScopeId
        /**
         * ADR-0018: the full TurnResolution (security prompt, branding,
         * decorator blocks) when the deployment resolves one; the flattened
         * systemPrompt/orgScopeId stay for the minimal contract.
         */
        resolution?: import('@qm/types').TurnResolution
        latencyMs: number
      }
    | { decision: 'deny'; reason: string; latencyMs: number }
  >
}

export interface DispatchStagePort {
  /**
   * Final pre-harness stage. Returns allow/deny + reason. The actual
   * harness call lives in the orchestrator; this stage is the last
   * authorization gate before that call (plan §3.1 step 6).
   */
  prepare(input: AdmissionInput, resolved: { sessionId: string; scopeId: ScopeId }): Promise<
    { decision: 'allow'; latencyMs: number } | { decision: 'deny'; reason: string; latencyMs: number }
  >
}

/** All six stage ports. Budget + screen are optional per ADR-0007 (some stages may be unconfigured). */
export interface StagePorts {
  identity: IdentityStagePort
  rateLimit: RateLimitStagePort
  budget?: BudgetStagePort
  screen?: ScreenStagePort
  session: SessionStagePort
  dispatch: DispatchStagePort
}

export interface WaterfallOptions {
  /** Defaults to Date.now. Injected for tests. */
  now?: () => number
  /** Defaults to the default-registry helper. Inject for unit tests. */
  metrics?: import('@qm/runs').RunMetricsRegistry
}

export interface ResolvedContext {
  sessionId: string
  scopeId: ScopeId
  leaseToken: unknown
  systemPrompt: string
  orgScopeId: ScopeId
  /** ADR-0018: full TurnResolution passthrough (security prompt, branding, decorator blocks). */
  resolution?: import('@qm/types').TurnResolution
  /** Present only when the admitted work carried a structured command; pure reads omit it (ADR-0002). */
  commandRequest?: CommandRequest
  rateLimit?: { limit: number; remaining: number; resetMs: number }
  budget?: { remaining: number; unit: string }
  screen?: SecurityScreenOutcome
}

export interface AcceptedAdmission {
  decision: 'accepted'
  record: import('@qm/types').AdmissionRecord
  /** Present only when the admitted work carried a structured command; pure reads omit it (ADR-0002). */
  commandRequest?: CommandRequest
  resolved: ResolvedContext
}

export interface RejectedAdmission {
  decision: 'rejected'
  record: import('@qm/types').AdmissionRecord
}

export type WaterfallOutcome = AcceptedAdmission | RejectedAdmission

/** Internal helper: the order is fixed; this re-export keeps callers honest. */
export const WATERFALL_ORDER: readonly AdmissionStage[] = [
  'identity',
  'rate_limit',
  'budget',
  'screen',
  'session',
  'dispatch',
] as const