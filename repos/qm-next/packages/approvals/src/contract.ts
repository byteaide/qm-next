/**
 * M3 approvals contract (12.0, lane-opening freeze): durable approval
 * records keyed by requestId, the decision state machine
 * (pending → approved/rejected), the approval action-value codec that
 * round-trips through provider card buttons, the card-renderer port, and
 * the ambient minimal slice (channel policy + judge port).
 *
 * Programs against the im-core `Interaction`/message shapes and @qm/types
 * principals; provider card payloads stay opaque (`OutboundBody.card`).
 * Changes go back through the main session, never inside a parallel lane.
 */
import type { InboundActor, InboundMessageEvent, ImLogger } from '@qm/im-core'
import type { Conversation, Destination, PendingApproval, Principal, PrincipalType, TurnInput } from '@qm/types'
/** Discriminator round-tripped through approval card button values. */
export const APPROVAL_VALUE_KIND = 'qm.approval.v1'

/** Which decision a card button carries. */
export type ApprovalDecision = 'approve' | 'reject'

/** Value embedded in card buttons; survives the provider round-trip. */
export interface ApprovalActionValue {
  kind: typeof APPROVAL_VALUE_KIND
  runId: string
  sessionId: string
  requestId: string
  command: string
  decision: ApprovalDecision
}

export function encodeApprovalValue(value: ApprovalActionValue): Record<string, unknown> {
  return { ...value }
}

/**
 * Parse a card action value. Accepts the structured object providers pass
 * through verbatim and JSON strings for platforms that stringify values.
 * Returns null for anything else — non-approval interactions are ignored.
 */
export function parseApprovalValue(value: unknown): ApprovalActionValue | null {
  let candidate: unknown = value
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return null
    }
  }
  if (typeof candidate !== 'object' || candidate === null) return null
  const record = candidate as Record<string, unknown>
  if (record.kind !== APPROVAL_VALUE_KIND) return null
  if (typeof record.runId !== 'string' || !record.runId) return null
  if (typeof record.requestId !== 'string') return null
  if (typeof record.command !== 'string') return null
  if (record.decision !== 'approve' && record.decision !== 'reject') return null
  return {
    kind: APPROVAL_VALUE_KIND,
    runId: record.runId,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
    requestId: record.requestId,
    command: record.command,
    decision: record.decision,
  }
}

/** What a surface records when a turn pauses on pending approvals. */
export interface ApprovalRecordInput {
  requestId: string
  runId: string
  sessionId: string
  command: string
  reason: string
  purpose?: string
  summary?: string
  kind?: 'approval' | 'input'
  /** Principal that triggered the original turn; only they may decide. */
  requester: Principal
  /** Where the approval card lives (for recovery routing). */
  destination: Destination
  threadId?: string
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

/** Durable approval record; `decidedBy` is the deciding principal id. */
export interface ApprovalRecord {
  requestId: string
  runId: string
  sessionId: string
  command: string
  reason: string
  purpose?: string
  summary?: string
  kind: 'approval' | 'input'
  requesterId: string
  destination: Destination
  threadId?: string
  status: ApprovalStatus
  decidedBy?: string
  decidedAt?: number
  createdAt: number
}

export type ApprovalDecisionOutcome =
  | { outcome: 'decided'; approved: boolean; record: ApprovalRecord }
  | { outcome: 'already_decided'; approved: boolean; record: ApprovalRecord }
  | { outcome: 'forbidden'; record: ApprovalRecord }
  | { outcome: 'not_found' }

/**
 * Durable approval registry. `decide` is the state machine: a pending
 * record transitions exactly once (double clicks dedupe to
 * `already_decided`), only the requester may decide (`forbidden`
 * otherwise, record untouched), and decided records are never resurrected
 * by re-recording. Both memory and Postgres implementations satisfy these
 * semantics identically (parity tests).
 */
export interface ApprovalStore {
  record(input: ApprovalRecordInput): Promise<ApprovalRecord>
  get(requestId: string): Promise<ApprovalRecord | null>
  decide(requestId: string, decision: { approved: boolean; decidedBy: string }): Promise<ApprovalDecisionOutcome>
  listPending(opts?: { limit?: number }): Promise<ApprovalRecord[]>
  close?(): Promise<void>
}

/** Semantic input for rendering an approval card (provider-native output). */
export interface ApprovalCardSpec {
  runId: string
  sessionId: string
  approvals: readonly PendingApproval[]
}

/**
 * Card rendering stays provider-side: implementers produce the opaque
 * payload carried on `OutboundBody.card`. Button values must embed
 * `ApprovalActionValue` (object, or its JSON encoding) so decisions
 * round-trip back through `parseApprovalValue`.
 */
export interface ApprovalCardRenderer {
  render(spec: ApprovalCardSpec): Record<string, unknown>
}

/** Per-container (channel) policy record for the ambient minimal slice. */
export interface ChannelPolicy {
  container: string
  ambientEnabled: boolean
  updatedAt: number
}

/**
 * Ambient engagement is off unless a policy explicitly enables it for the
 * container; absent policies behave identically to `ambientEnabled: false`.
 */
export interface ChannelPolicyStore {
  get(container: string): Promise<ChannelPolicy | null>
  setAmbient(container: string, enabled: boolean, opts?: { setBy?: string }): Promise<ChannelPolicy>
  close(): Promise<void>
}

/** One overheard message offered to the ambient judge. */
export interface AmbientCandidate {
  provider: string
  destination: Destination
  threadId?: string
  actor: InboundActor
  text: string
  occurredAt: number
}

export interface AmbientVerdict {
  engage: boolean
  /** Replacement turn text; defaults to the observed message text. */
  text?: string
  reason?: string
}

/**
 * Pluggable ambient judge. qm's judge model decides whether overheard
 * chatter warrants engagement; M3 ships the port with a no-op default.
 */
export interface AmbientJudge {
  consider(candidate: AmbientCandidate): Promise<AmbientVerdict>
}

export function createNoopAmbientJudge(): AmbientJudge {
  return { consider: async () => ({ engage: false }) }
}

/** Route an ambient-produced turn replies into. */export interface AmbientRoute {
  destination: Destination
  threadId?: string
  conversation: Conversation
}

export type AmbientSubmit = (input: TurnInput, route: AmbientRoute) => Promise<void>

export interface AmbientServiceOptions {
  policy: ChannelPolicyStore
  judge: AmbientJudge
  submit: AmbientSubmit
  actorType?: PrincipalType
  logger?: ImLogger
}

export interface AmbientService {
  /** Observe one inbound message; never throws to the caller. */
  observe(event: InboundMessageEvent): Promise<void>
}
