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

export interface TurnResolution {
  systemPrompt: string
  orgScopeId: ScopeId
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
    runId?: string
    attempt?: number
  }) => ToolContext | null | Promise<ToolContext | null>
}

export interface Orchestrator {
  handleTurn(input: TurnInput): Promise<TurnResult>
}
