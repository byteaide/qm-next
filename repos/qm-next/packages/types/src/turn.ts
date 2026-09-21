/**
 * Turn request/response contracts.
 *
 * `TurnInput` is the single orchestrator input (replaces qm's TurnRequest +
 * OrchestratorInput pair). `surface` is required: every turn states where it
 * came from and where replies go, with no default value.
 */
import type { Conversation, ConversationTurn } from './conversation.ts'
import type { Destination, IncomingAttachment, OutgoingAttachment } from './destination.ts'
import type { Principal } from './identity.ts'

export type TurnOrigin =
  | { kind: 'human'; messageTs?: string; entryTs?: string }
  | { kind: 'ambient'; entryTs?: string; live?: boolean }
  | { kind: 'automation'; destination?: Destination }
  | { kind: 'direct' }

export interface TurnApproval {
  requestId: string
  approved: boolean
  scope?: 'once' | 'session' | 'always'
  /**
   * ADR-0010 continuation executor — stable identity of the saved
   * command point. The resumer MUST replay by `commandRequestId`
   * (the id recorded on the durable Approval Continuation), never by
   * re-driving the raw input text.
   */
  commandRequestId?: string
}

/**
 * IM-envelope facts carried into the gateway block (segment ⑨). The bridge
 * derives them from the provider; core never names the platform.
 */
export interface GatewayContext {
  location?: string
  botHandle?: string
  details?: Record<string, string>
  instructions?: string
  /** Provider display name (e.g. the product's name) injected into platform-wording slots. */
  displayLabel?: string
}

export interface TurnInput {
  surface: string
  actor: Principal
  conversation: Conversation
  origin: TurnOrigin
  text: string
  attachments?: IncomingAttachment[]
  priorTurns?: ConversationTurn[]
  model?: string
  harness?: string
  thinkingLevel?: string
  readOnly?: boolean
  timezone?: string
  approval?: TurnApproval
  sessionParticipantIds?: readonly string[]
  runId?: string
  attempt?: number
  finalAttempt?: boolean
  background?: boolean
  cancel?: AbortSignal
  queueMs?: number
  /**
   * Caller-asserted availability of the surface tool set (post/reach/stay_silent).
   * When absent, the orchestrator derives it from the turn origin (ADR-0018
   * mode selection): ambient turns and automation with a destination carry
   * surface tools; other turns do not unless the resolution asserts them.
   */
  surfaceTools?: boolean
  /** Empty-conversation opener: the composer appends qm's proactive-open line. */
  proactiveOpener?: boolean
  /** IM envelope facts for the gateway block (segment ⑨). */
  gatewayContext?: GatewayContext
}

export type TurnStatus = 'ok' | 'refused' | 'failed' | 'pending_approval' | 'queued' | 'silent'

export interface PendingApproval {
  requestId: string
  command: string
  reason: string
  kind?: 'approval' | 'input'
}

export interface TurnResult {
  status: TurnStatus
  sessionId?: string
  reply?: string
  reason?: string
  runId?: string
  stopped?: boolean
  pendingApprovals?: PendingApproval[]
  attachments?: OutgoingAttachment[]
  sourceUserSeq?: number
  sourceAssistantEntrySeq?: number
}

export class NonRetryableTurnError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonRetryableTurnError'
  }
}
