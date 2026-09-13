/**
 * Inbound events: the discriminated union every provider adapter emits into
 * the core. Envelope fields are contract — providers fill them honestly so
 * core-side dedup and ordering never touch platform payloads.
 */
import type { Destination, IncomingAttachment } from '@qm/types'
import type { ImInstanceId, ImProviderId, InboundActor, InboundMention, MessageRef } from './types.ts'

/** Fields every inbound event carries. */
export interface InboundEnvelope {
  provider: ImProviderId
  instanceId: ImInstanceId
  /** Provider-unique event id; core dedups on it. */
  eventId: string
  /** Platform timestamp, Unix epoch ms. */
  occurredAt: number
  /** Host receipt time, Unix epoch ms. */
  receivedAt: number
  /** Provider payload attachment point; off by default, diagnostic use only. */
  raw?: unknown
}

/** A user message: @mention, DM, or thread reply. */
export interface InboundMessageEvent extends InboundEnvelope {
  kind: 'message'
  /** Where replies go. `type` equals `provider`; `target` is the chat id. */
  destination: Destination
  actor: InboundActor
  /** Provider-normalized visible text (bot mention placeholders resolved). */
  text: string
  mentions?: InboundMention[]
  attachments?: IncomingAttachment[]
  /** Thread the message lives in, when the platform has threads. */
  threadId?: string
  /** Message being replied to, for threaded platforms without explicit threads. */
  replyToMessageId?: string
  /** True when the message @-mentions the receiving bot. */
  mentionedBot?: boolean
  /**
   * Container kind when the provider knows it: a direct message or a
   * group/channel. Absent keeps legacy providers fully addressed — core
   * ambient gating only redirects unaddressed chatter when the kind is
   * known and an ambient policy covers the container.
   */
  containerKind?: 'dm' | 'channel'
}

/** An interactive-card action (button click, menu select, …). */
export interface InboundInteractionEvent extends InboundEnvelope {
  kind: 'interaction'
  /** The message the interaction happened on. */
  ref: MessageRef
  actor: InboundActor
  action: {
    /** Stable action id when the platform carries one. */
    id?: string
    /** Round-tripped action value (approval decisions ride here). */
    value: unknown
    /** Platform widget tag (e.g. "button"). */
    tag?: string
    /** Selected option value for select menus. */
    option?: string
  }
}

/** An emoji reaction on a message. Reserved: v1 core logs, does not act. */
export interface InboundReactionEvent extends InboundEnvelope {
  kind: 'reaction'
  ref: MessageRef
  actor: InboundActor
  emoji: string
  action: 'added' | 'removed'
}

/** Bot lifecycle in a space (added to a group, removed, installed). */
export interface InboundLifecycleEvent extends InboundEnvelope {
  kind: 'lifecycle'
  event: 'bot_added' | 'bot_removed'
  /** Space affected, when the event is space-scoped. */
  spaceId?: string
}

export type InboundEvent =
  | InboundMessageEvent
  | InboundInteractionEvent
  | InboundReactionEvent
  | InboundLifecycleEvent

export type InboundEventKind = InboundEvent['kind']
