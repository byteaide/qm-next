/**
 * Conversation descriptors shared by every surface. A conversation is the
 * platform-side container a turn arrives in; the orchestrator maps it to a
 * session via the thread ref.
 */
import type { Principal } from './identity.ts'

export type ConversationKind = 'dm' | 'channel' | 'group'

export interface Conversation {
  kind: ConversationKind
  threadRef: string
  channelRef?: string
  channelName?: string
  audience: Principal[]
  isPrivate?: boolean
}

export interface ConversationTurn {
  role: 'user' | 'assistant'
  name?: string
  text: string
}
