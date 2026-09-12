/**
 * Harness adapter contract: the seam between the orchestrator and a model
 * runtime (mock, in-process SDK, HTTP gateway, ...). Adapted from qm's
 * harness.ts with the security-screening, tape and image fields deferred.
 */
import type { ConversationTurn } from './conversation.ts'
import type { ScopeId } from './identity.ts'
import type { IncomingAttachment } from './destination.ts'
import type { NewEntry, Session, SessionEntry } from './session.ts'

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
  ttftMs?: number | null
  durationMs?: number | null
}

export interface HarnessTurnInput {
  session: Session
  runId?: string
  cancel?: AbortSignal
  input: string
  priorTurns?: ConversationTurn[]
  attachments?: IncomingAttachment[]
  model?: string
  harness?: string
  thinkingLevel?: string
  readOnly?: boolean
  systemPrompt: string
  history: SessionEntry[]
  emit(entry: NewEntry): Promise<SessionEntry>
  scopeLabel: ScopeId
  orgScopeId: ScopeId
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void
  recordLlmRequest?(rec: HarnessLlmRequestRecord): void | Promise<void>
  onProgress?(p: { toolCalls: number }): void
  onDelta?(chunk: string): void
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
  generateTitle?(transcript: string): Promise<string | undefined>
  oneShot?(systemPrompt: string, prompt: string): Promise<string | undefined>
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
