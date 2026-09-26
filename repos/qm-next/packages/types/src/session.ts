/**
 * Session aggregate and entry log types.
 */
import type { ScopeId } from './identity.ts'

export type SessionType = 'dm' | 'channel' | 'group'

export interface Session {
  id: string
  type: SessionType
  scopeId: ScopeId
  threadRef: string
  surface: string
  createdAt: number
  channelName?: string
  title?: string | null
  lastActivityAt?: number
  /** Web-ui conversation flags (P3 surface lane; additive). */
  archived?: boolean
  pinned?: boolean
  color?: string | null
}

/** Metadata patch applied by the sessions/conversations routes. */
export interface SessionPatch {
  title?: string | null
  archived?: boolean
  pinned?: boolean
  color?: string | null
}

export type EntryType = 'user' | 'assistant' | 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'system' | 'soul' | 'delivery'

export interface SessionEntry {
  sessionId: string
  seq: number
  parentSeq: number | null
  type: EntryType
  payload: unknown
  scopeLabel: ScopeId
  createdAt: number
}

export interface NewEntry {
  type: EntryType
  payload: unknown
  scopeLabel: ScopeId
}

export interface GetEntriesOptions {
  sinceSeq?: number
  /** Exclusive upper bound — entries with seq >= beforeSeq are skipped.
   *  Added for M-Tape-1 to support `createTranscriptSource` windowed
   *  reads (qm `tape-projection.ts` `projected(sessionId, limit, beforeSeq)`). */
  beforeSeq?: number
  limit?: number
}
