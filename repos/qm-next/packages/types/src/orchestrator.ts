/**
 * Orchestrator contract: the turn pipeline from admission to reply.
 *
 * `OrchestratorDeps` is the M1 dependency surface. qm deps that serve M3+
 * capabilities (workspace, security, memory, skills, directory, delivery,
 * cron/monitor/webhook stores, ...) are deliberately absent; additions are
 * made through the contract-change process, never lane-local.
 */
import type { Conversation } from './conversation.ts'
import type { HarnessRegistry } from './harness.ts'
import type { Principal, ScopeId } from './identity.ts'
import type { ModelGateway } from './model.ts'
import type { BudgetTracker, RateLimiter } from './ratelimit.ts'
import type { TargetRunEventBus } from './run-observation.ts'
import type { RunStore } from './run.ts'
import type { SessionStore } from './session-store.ts'
import type { ToolContext } from './tools.ts'
import type { TurnInput, TurnResult } from './turn.ts'

export interface IdentityService {
  isInternal(principal: Principal): boolean
  audienceIsAllInternal(audience: readonly Principal[]): boolean
}

/** Frame variables sourced from stored branding (ADR-0018 shared-core segment). */
export interface ResolutionBranding {
  botName?: string
  orgName?: string
}

export interface TurnResolution {
  systemPrompt: string
  orgScopeId: ScopeId
  /**
   * ADR-0018 segment ④ — the rendered security policy prompt. Absent means
   * the deployment resolves no posture; the frame composer omits the segment.
   */
  securityPrompt?: string
  /** Shared-core frame variables (botName/orgName) resolved from branding. */
  branding?: ResolutionBranding
  /**
   * Segment ⑥ — the machine-facts block rendered from the sandbox computer
   * spec (qm renderComputerBlock). Inside the stable prefix.
   */
  computerBlock?: string
  /**
   * Segment ⑧ — the visible-skills index block. The skills resolution
   * decorator owns the content; the frame composer only fixes its position
   * inside the stable prefix (ADR-0018).
   */
  skillsBlock?: string
  /**
   * Segment ⑭ — the memory recall block. Appended AFTER the prompt-cache
   * boundary, never inside the stable prefix (qm parity).
   */
  memoryBlock?: string
  /**
   * Resolution-side assertion that the turn carries the surface tool set;
   * the orchestrator merges it with the caller-supplied TurnInput flag and
   * the turn-origin derivation to select mode-autonomous.
   */
  surfaceTools?: boolean
}

export interface ResolutionService {
  resolve(conversation: Conversation, actor: Principal): Promise<TurnResolution>
  scopeFor(conversation: Conversation, actor: Principal): ScopeId
}

export interface OrchestratorDeps {
  sessions: SessionStore
  runs: RunStore
  harness: HarnessRegistry
  identity: IdentityService
  resolution: ResolutionService
  rateLimiter: RateLimiter
  budget?: BudgetTracker
  /**
   * Optional target Run event log (Phase 7 / KV-006 cutover). The
   * orchestrator produces non-terminal attempt/progress events through
   * the typed envelope (`seq` allocated by the SequenceAllocator inside
   * the bus); terminal `run.finished` events are published by the turn
   * runner AFTER the RunStore commits, so the orchestrator owns no
   * subscriber truth (ADR-0001, ADR-0013).
   */
  runEventLog?: TargetRunEventBus
  /** Optional model usage recorder (P1): powers recordModelCall and admin sinks. */
  modelGateway?: ModelGateway
  /**
   * Optional per-turn tool context factory (P1 4.2a): when present, the
   * returned ToolContext rides the harness turn so tools execute; when it
   * returns null (or the factory is absent) the turn runs without tools.
   * `runId`/`attempt` arrive only for queued Run executions — the factory
   * forwards them into the tool context so tool calls replay through the
   * run's ToolLedger (attempt replays observe cached outputs); interactive
   * turns without a Run omit them and every call executes live.
   */
  tools?: (input: {
    scopeId: ScopeId
    sessionId: string
    /** Turn actor principal id — control-plane tool ops (crons, shares) own resources under it. */
    actorId?: string
    runId?: string
    attempt?: number
  }) => ToolContext | null | Promise<ToolContext | null>
}

export interface Orchestrator {
  handleTurn(input: TurnInput): Promise<TurnResult>
}
