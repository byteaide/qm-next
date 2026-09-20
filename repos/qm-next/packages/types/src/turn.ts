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
