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
}

export type EntryType = 'user' | 'assistant' | 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'system'

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
  limit?: number
}
