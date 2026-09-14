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

/** Discriminator round-tripped through agent-request card button values. */
export const AGENT_REQUEST_VALUE_KIND = 'qm.agent-request.v1'

/** Which decision an agent-request card button carries. */
export type AgentRequestDecision = 'approve' | 'reject'

/** Value embedded in agent-request DM buttons; survives the provider round-trip. */
export interface AgentRequestActionValue {
  kind: typeof AGENT_REQUEST_VALUE_KIND
  requestId: string
  decision: AgentRequestDecision
}

export function encodeAgentRequestValue(value: AgentRequestActionValue): Record<string, unknown> {
  return { ...value }
}

export function parseAgentRequestValue(value: unknown): AgentRequestActionValue | null {
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
  if (record.kind !== AGENT_REQUEST_VALUE_KIND) return null
  if (typeof record.requestId !== 'string' || !record.requestId) return null
  if (record.decision !== 'approve' && record.decision !== 'reject') return null
  return { kind: AGENT_REQUEST_VALUE_KIND, requestId: record.requestId, decision: record.decision }
}

/** A reply directive asking a person's personal agent to run a task. */
export interface AgentRequestDirective {
  /** Provider-native target user id (parsed from the directive ref). */
  targetUserId: string
  task: string
}

export type AgentRequestStatus = 'pending' | 'approved' | 'declined'

/** Durable agent-request record keyed by requestId. */
export interface AgentRequestRecord {
  requestId: string
  originRunId: string
  originSessionId: string
  provider: string
  targetUserId: string
  task: string
  /** The requesting actor in the origin conversation. */
  requesterId: string
  requesterName?: string
  /** Where the result/decline posts back (the origin conversation). */
  destination: Destination
  threadId?: string
  replyToMessageId?: string
  status: AgentRequestStatus
  decidedBy?: string
  decidedAt?: number
  createdAt: number
}

export type AgentRequestDecisionOutcome =
  | { outcome: 'decided'; approved: boolean; record: AgentRequestRecord }
  | { outcome: 'already_decided'; approved: boolean; record: AgentRequestRecord }
  | { outcome: 'forbidden'; record: AgentRequestRecord }
  | { outcome: 'not_found' }

/**
 * Durable agent-request registry. `decide` mirrors the approval state
 * machine (one transition, duplicate dedupe) but only the TARGET user may
 * decide — it is their personal setup being asked for.
 */
export interface AgentRequestStore {
  record(input: Omit<AgentRequestRecord, 'status' | 'decidedBy' | 'decidedAt'>): Promise<AgentRequestRecord>
  get(requestId: string): Promise<AgentRequestRecord | null>
  decide(requestId: string, decision: { approved: boolean; decidedBy: string }): Promise<AgentRequestDecisionOutcome>
  listPending(opts?: { limit?: number }): Promise<AgentRequestRecord[]>
  close?(): Promise<void>
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

/** Ledger entry for one external bot's posts inside a container. */
export interface AmbientBotPolicy {
  mode: 'ignore' | 'rollup' | 'action' | 'user'
  /** Rollup batch window in hours (rollup mode only). */
  rollupHours?: number
}

/** Rollup batches judge at most once per window; qm's default. */
export const DEFAULT_ROLLUP_HOURS = 24

/** Per-container (channel) policy record for the ambient slice. */
export interface ChannelPolicy {
  container: string
  /** Standing orders rendered into every ambient judgment (qm proactivity policy). */
  orders: string
  /** External bot ledger keyed by author name (case-insensitive at lookup). */
  bots: Record<string, AmbientBotPolicy>
  ambientEnabled?: boolean
  setBy?: string
  updatedAt: number
}

/**
 * Ambient engagement is off unless a policy explicitly enables it for the
 * container; absent policies behave identically to `ambientEnabled: false`.
 */
export interface ChannelPolicyStore {
  get(container: string): Promise<ChannelPolicy | null>
  /** Full policy write (orders, ledger, ambient opt-in) — qm's `set`. */
  set(
    container: string,
    orders: string,
    opts?: { setBy?: string; bots?: Record<string, AmbientBotPolicy>; ambientEnabled?: boolean | null },
  ): Promise<ChannelPolicy>
  /** Ambient-only opt-in sugar (legacy shape: empty orders, empty ledger). */
  setAmbient(
    container: string,
    enabled: boolean,
    opts?: { setBy?: string },
  ): Promise<ChannelPolicy>
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
  /** Composed standing orders (incl. action-bot trigger lines), attached by the service. */
  orders?: string
}

export interface AmbientVerdict {
  engage: boolean
  /** Replacement turn text; defaults to the observed message text. */
  text?: string
  reason?: string
  /** The exact prompt the judge sent to the model, for judgment records. */
  prompt?: string
}

/**
 * Pluggable ambient judge. qm's judge model decides whether overheard
 * chatter warrants engagement; the keyword stub and the model judge in
 * `ambient-judge-model.ts` both implement this port.
 */
export interface AmbientJudge {
  consider(candidate: AmbientCandidate): Promise<AmbientVerdict>
}

/** Durable per-container marker of the last judged message (qm ambient_cursors). */
export interface AmbientCursor {
  lastJudgedTs: string
  lastJudgedAt?: number
}

export interface AmbientCursorStore {
  get(key: string): Promise<AmbientCursor | null>
  put(key: string, value: AmbientCursor): Promise<void>
  close?(): Promise<void>
}

export type AmbientDecisionKind = 'act' | 'ignore' | 'fastlane'

/** One recorded ambient judgment (qm ambient_judgments row). */
export interface AmbientJudgment {
  id?: number
  surface: string
  container: string
  decision: AmbientDecisionKind
  reason?: string
  askedBy?: string
  prompt?: string
  model?: string
  latencyMs?: number
  tsFrom?: string
  tsTo?: string
  createdAt: number
}

/** Summary view: everything except the prompt body. */
export type AmbientJudgmentSummary = Omit<AmbientJudgment, 'prompt'>

export type AmbientJudgmentCounts = Record<AmbientDecisionKind, number>

export interface AmbientJudgmentStore {
  record(j: AmbientJudgment): Promise<void>
  list(opts?: {
    container?: string
    decision?: AmbientDecisionKind[]
    before?: number
    beforeId?: number
    limit?: number
  }): Promise<AmbientJudgmentSummary[]>
  get(id: number): Promise<AmbientJudgment | null>
  counts(opts?: { container?: string }): Promise<AmbientJudgmentCounts>
  close(): Promise<void>
}

export type AckPickOutcome = 'picked' | 'declined'

/** One reaction-as-ack decision (qm ack_emoji_picks row). */
export interface AckEmojiPick {
  id?: number
  surface: string
  channel: string
  /** Trigger message id. */
  ts: string
  outcome: AckPickOutcome
  /** The emoji the model picked (absent when declined). */
  picked?: string
  /** The emoji actually applied (the model pick, else the random default). */
  icon?: string
  message?: string
  /** Comma-joined candidate list offered to the picker. */
  candidates?: string
  model?: string
  latencyMs?: number
  createdAt: number
}

export type AckPickCounts = Record<AckPickOutcome, number>

/** Summary view: everything except the candidate list. */
export type AckEmojiPickSummary = Omit<AckEmojiPick, 'candidates'>

export interface AckEmojiPickStore {
  record(p: AckEmojiPick): Promise<void>
  list(opts?: {
    channel?: string
    outcome?: AckPickOutcome[]
    before?: number
    beforeId?: number
    limit?: number
  }): Promise<AckEmojiPickSummary[]>
  get(id: number): Promise<AckEmojiPick | null>
  counts(opts?: { channel?: string }): Promise<AckPickCounts>
  close(): Promise<void>
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
  /** Per-container last-judged markers; absent means no cursor tracking. */
  cursors?: AmbientCursorStore
  /** Judgment recording; absent means judgments are not kept. */
  judgments?: AmbientJudgmentStore
  /** The assistant's own surface identity, rendered into judge prompts. */
  self?: { name?: string; mentionId?: string }
  /** Model label recorded with judgments (for cost/latency views). */
  judgeModel?: string
  /** Injectable clock for tests. */
  now?: () => number
}

export interface AmbientService {
  /** Observe one inbound message; never throws to the caller. */
  observe(event: InboundMessageEvent): Promise<void>
}
