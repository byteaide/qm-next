/**
 * Session persistence contract (M1 core subset of qm's SessionStore).
 *
 * Lease semantics: a turn acquires the session lease before appending, so
 * concurrent runs over one thread serialize. P1 adds the tape and LLM
 * request record groups the harness layer consumes; participant views,
 * search, and admin listings remain deferred; additions must be additive.
 */
import type { ScopeId } from './identity.ts'
import type { GetEntriesOptions, NewEntry, Session, SessionEntry, SessionPatch, SessionType } from './session.ts'

export type LeaseHolder = 'turn' | 'compaction' | 'fork' | 'backfill'

export interface Lease {
  sessionId: string
  token: string
}

export interface LeaseAttempt {
  lease: Lease | null
  heldBy?: LeaseHolder
  heldSince?: number
  heldUntil?: number
}

export type TapeKind = 'message' | 'context_event' | 'annotation'

export interface TapeMeta {
  bareText?: string
  ts?: string
  changeTime?: string
  hidden?: boolean
  overheard?: boolean
  author?: string
}

export interface NewTapeRecord {
  kind: TapeKind
  payload: unknown
  scopeLabel: ScopeId
  harness?: string
  meta?: TapeMeta
  entrySeq?: number
  coversEntrySeq?: number
}

export interface TapeRecord extends NewTapeRecord {
  sessionId: string
  seq: number
  createdAt: number
}

export interface GetTapeOptions {
  sinceSeq?: number
  limit?: number
}

export interface LlmCallUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  costUsd: number
}

export interface LlmTransportMeta {
  modelId?: string
  headers?: Record<string, string>
}

export type GapPhase =
  | 'provision'
  | 'creds'
  | 'dir_cleanup'
  | 'proc_reconcile'
  | 'auth_probe'
  | 'skills_materialize'
  | 'recall'
  | 'memory_write'
  | 'file_op'
  | 'exec'
  | 'model_dispatch'
  | 'dispatch_glue'
  | 'loop_reentry'
  | 'context_assemble'
  | 'glue_other'
  | 'tool_body'
  | 'pre_tool'
  | 'in_tool_untagged'
  | 'post_tool'
  | 'tool_ledger'
  | 'persist'
  | 'stream_open'

export interface GapWork {
  phase: GapPhase
  start: number
  end: number
  tool?: string
}

export type GapPhases = Partial<Record<GapPhase, number>> & {
  residual?: number
} & {
  [key: `tool_body.${string}`]: number | undefined
}

export interface LlmRequestRecord {
  id: string
  sessionId: string
  turnSeq: number | null
  step: number
  model: string
  scopeLabel: ScopeId
  createdAt: number
  request: unknown
  promptHash: string | null
  promptEnvelope?: unknown
  truncated: boolean
  ttftMs: number | null
  durationMs: number | null
  stepGapMs: number | null
  toolWallMs: number[] | null
  gapPhases: GapPhases | null
  usage: LlmCallUsage | null
  transport: LlmTransportMeta | null
}

export interface NewLlmRequest {
  turnSeq: number | null
  step: number
  model: string
  scopeLabel: ScopeId
  promptEnvelope?: unknown
  truncated?: boolean
  ttftMs?: number | null
  durationMs?: number | null
  stepGapMs?: number | null
  toolWallMs?: number[] | null
  gapPhases?: GapPhases | null
  usage?: LlmCallUsage | null
  transport?: LlmTransportMeta | null
}

export interface ListLlmRequestsOptions {
  turnSeqs?: number[]
  orphans?: boolean
  omitRequest?: boolean
}

/** One raw transcript-search hit (composed into view shapes by callers). */
export interface SessionEntryHit {
  sessionId: string
  seq: number
  type: SessionEntry['type']
  text: string
  createdAt: number
  author?: string
}

/** Result of forking a session: the fresh copy plus how much moved over. */
export interface SessionForkResult {
  session: Session
  entriesCopied: number
}

export interface SessionStore {
  getOrCreateByThread(
    threadRef: string,
    type: SessionType,
    scopeId: ScopeId,
    surface: string,
    channelName?: string,
  ): Promise<Session>
  getByThread(threadRef: string): Promise<Session | null>
  get(sessionId: string): Promise<Session | null>

  updateTitle(sessionId: string, title: string): Promise<void>

  acquireLease(sessionId: string, holder?: LeaseHolder): Promise<LeaseAttempt>
  releaseLease(lease: Lease): Promise<void>
  forceReleaseLease(sessionId: string): Promise<void>

  append(lease: Lease, entry: NewEntry): Promise<SessionEntry>
  getEntries(sessionId: string, opts?: GetEntriesOptions): Promise<SessionEntry[]>

  appendTape(lease: Lease, rec: NewTapeRecord): Promise<TapeRecord>
  getTape(sessionId: string, opts?: GetTapeOptions): Promise<TapeRecord[]>

  recordLlmRequest(sessionId: string, rec: NewLlmRequest, signal?: AbortSignal): Promise<LlmRequestRecord>
  listLlmRequests(sessionId: string, opts?: ListLlmRequestsOptions): Promise<LlmRequestRecord[]>

  addParticipant(sessionId: string, principalId: string): Promise<void>
  removeParticipant(sessionId: string, principalId: string): Promise<void>
  participantsOf(sessionId: string): Promise<string[]>

  // --- P3 surface lane (additive; sessions/conversations routes) ---

  /** Sessions where the principal holds an active participant window. */
  listByParticipant(principalId: string): Promise<Session[]>
  /** Raw entry-text search over the principal's visible sessions. */
  searchEntries(principalId: string, query: string, limit?: number): Promise<SessionEntryHit[]>
  /** Metadata patch (title/archived/pinned/color); null when unknown. */
  patchSession(sessionId: string, patch: SessionPatch): Promise<Session | null>
  /** Copy the transcript (≤ upToSeq when given) into a fresh session. */
  forkSession(sessionId: string, by: string, opts?: { upToSeq?: number }): Promise<SessionForkResult | null>
  /** Drop a session and its transcript (seed-refusal rollback). */
  discardSession(sessionId: string, by: string): Promise<boolean>
}
