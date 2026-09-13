/**
 * Harness adapter contract: the seam between the orchestrator and a model
 * runtime (mock, in-process SDK, HTTP gateway, ...). Adapted from qm's
 * harness.ts with the security-screening callbacks still deferred; P1 adds
 * the tools/tape/goal/compaction hooks and the per-turn auth vocabulary the
 * four engine harnesses consume.
 */
import type { ConversationTurn } from './conversation.ts'
import type { ScopeId } from './identity.ts'
import type { IncomingAttachment } from './destination.ts'
import type { NewEntry, Session, SessionEntry } from './session.ts'
import type { GapPhases, GapWork, LlmCallUsage, LlmTransportMeta, NewTapeRecord, TapeRecord } from './session-store.ts'
import type { ProviderKeys } from './model.ts'
import type { ToolContext } from './tools.ts'

export type HarnessControlTransport = 'mock' | 'in-process' | 'sdk' | 'http' | 'json-rpc' | 'api'

export type HarnessToolTransport = 'mock' | 'in-process' | 'plugin' | 'dynamic' | 'in-process-mcp' | 'mcp'

export type HarnessCapability = 'abort' | 'steer' | 'images' | 'thinking-level' | 'fast-mode' | 'provider-sessions'

export interface HarnessAdapterProfile {
  id: string
  controlTransport: HarnessControlTransport
  toolTransport: HarnessToolTransport
  transcriptFormat: string
  capabilities: ReadonlySet<HarnessCapability>
}

export interface HarnessLlmRequestRecord {
  turnSeq: number | null
  step: number
  model: string
  promptEnvelope?: unknown
  truncated: boolean
  transport?: LlmTransportMeta | null
  ttftMs?: number | null
  durationMs?: number | null
  stepGapMs?: number | null
  toolWallMs?: number[] | null
  gapPhases?: GapPhases | null
  usage?: LlmCallUsage | null
}

export interface HarnessImage {
  mimeType: string
  dataBase64: string
  artifactId?: string
}

export interface OverheardEntryPayload {
  overheard: true
  ts: string
  changeTime?: string
  name?: string
  text: string
  files?: string[]
  mentions?: Record<string, string>
}

export interface CodexTurnAuth {
  accessToken: string
  idToken: string
  accountId?: string
  expiresAt?: number
}

export type GoalStatus = 'active' | 'complete' | 'blocked'

export interface GrindBudget {
  minTurns?: number
  minMs?: number
  minTokens?: number
  minUsd?: number
}

export interface GoalRecord {
  objective: string
  status: GoalStatus
  floor?: GrindBudget
  capTokens?: number
  tokensUsed: number
  createdAt: number
  updatedAt: number
  blockedStreak: number
  blockedReason?: string
  completionNote?: string
  source: 'tool' | 'directive'
}

export interface HarnessTurnInput {
  session: Session
  runId?: string
  cancel?: AbortSignal
  input: string
  triggerTs?: string
  entryTs?: string
  environment?: string
  priorTurns?: ConversationTurn[]
  overheard?: OverheardEntryPayload[]
  attachments?: IncomingAttachment[]
  images?: HarnessImage[]
  model?: string
  harness?: string
  thinkingLevel?: string
  fastMode?: boolean
  readOnly?: boolean
  surfaceTools?: boolean
  surfaceName?: string
  pollFire?: boolean
  turnWallClockMs?: number
  systemPrompt: string
  systemCacheBoundary?: number
  history: SessionEntry[]
  tools?: ToolContext
  emit(entry: NewEntry): Promise<SessionEntry>
  tape?(rec: NewTapeRecord): Promise<unknown>
  tapeRows?: TapeRecord[]
  tapeMode?: 'shadow' | 'serve'
  tapeFold?: unknown[]
  scopeLabel: ScopeId
  orgScopeId: ScopeId
  providerKeys?: ProviderKeys
  runtimePinned?: boolean
  claudeOauthToken?: string
  codexAuth?: CodexTurnAuth
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void
  recordLlmRequest?(rec: HarnessLlmRequestRecord): void | Promise<void>
  onProgress?(p: { toolCalls: number; tokens?: number }): void
  onGapWork?(sink: (work: GapWork) => void): void
  onDelta?(chunk: string): void
  onTextBlockStart?(): void
  toolApprovalGate?(tool: string): boolean
}

export interface HarnessPendingApproval {
  command: string
  reason: string
  kind?: 'approval'
  matched?: string
  purpose?: string
  approvalKey?: string
}

export interface HarnessTurnResult {
  reply: string
  silent?: boolean
  stopped?: true
  pendingApprovals?: HarnessPendingApproval[]
  pausedOnApproval?: boolean
  modelCalls?: number
  cacheUsage?: { cacheRead: number; cacheWrite: number; uncachedInput: number }
  compileMs?: number
  tapeWriteFailed?: boolean
}

export interface HarnessDetectInput {
  session: Session
  message: string
  recentContext: string
  threadOpener?: string
  systemPrompt: string
  history: SessionEntry[]
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void
}

export interface HarnessDetectResult {
  respond: boolean
  reason?: string
}

export interface HarnessCompactInput {
  session: Session
  history: SessionEntry[]
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void
}

export interface HarnessTurnController {
  runTurn(input: HarnessTurnInput): Promise<HarnessTurnResult>
  close?(): Promise<void> | void
  resetSession?(sessionId: string): Promise<void> | void
}

export interface HarnessModelUtilities {
  shouldRespond?(input: HarnessDetectInput): Promise<HarnessDetectResult>
  compactHistory?(input: HarnessCompactInput): Promise<string>
  contextTokenBudget?(scopeLabel?: string, model?: string): number | undefined
  oneShot?(systemPrompt: string, prompt: string): Promise<string | undefined>
  generateTitle?(transcript: string): Promise<string | undefined>
}

export interface HarnessToolPresentation {
  name(coreName: string): string
}

export interface Harness {
  profile: HarnessAdapterProfile
  turns: HarnessTurnController
  models: HarnessModelUtilities
  tools: HarnessToolPresentation
}

export interface HarnessRegistry {
  register(harness: Harness): void
  get(id: string): Harness | undefined
  ids(): string[]
  /** Resolves an explicit harness id, or the deployment's configured default when omitted. */
  resolve(id?: string): Harness
}
