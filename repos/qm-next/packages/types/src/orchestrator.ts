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
import type { BudgetTracker, RateLimiter } from './ratelimit.ts'
import type { RunEventBus } from './run-events.ts'
import type { RunStore } from './run.ts'
import type { SessionStore } from './session-store.ts'
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
  /** Optional run event stream (M3): harness deltas/progress surface here. */
  runEvents?: RunEventBus
}

export interface Orchestrator {
  handleTurn(input: TurnInput): Promise<TurnResult>
}
