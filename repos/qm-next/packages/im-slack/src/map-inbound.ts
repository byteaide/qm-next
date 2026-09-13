/**
 * Inbound mapping: raw Socket Mode payloads → @qm/im-core InboundEvent.
 * The mapper binds instance id, bot identity and warning sink once; the
 * per-event functions stay pure so fixture replays stay declarative.
 * Addressing decisions are core-owned: the mapper delivers honestly
 * (mention flags, container kind) and the bridge classifies.
 */
import type { Destination } from '@qm/types'
import type {
  InboundInteractionEvent,
  InboundLifecycleEvent,
  InboundMessageEvent,
  InboundMention,
  InboundReactionEvent,
} from '@qm/im-core'
import { decodeSlackEntities, stripMention } from './mrkdwn.ts'
import type { SlackProviderConfig } from './types.ts'

const PROVIDER = 'slack'

/** Bot identity resolved from `auth.test` at provider start. */
export interface SlackIdentity {
  /** Bot user id (auth.test `user_id`); mention stripping and loop guard. */
  botUserId: string
  /** App bot id (auth.test `bot_id`); events carrying it are bot-authored. */
  botId?: string
}

export interface InboundMapperDeps {
  warn?(message: string): void
}

export interface InboundMapper {
  appMention(event: Record<string, unknown>, eventId?: string): InboundMessageEvent
  message(event: Record<string, unknown>, eventId?: string): InboundMessageEvent | undefined
  blockActions(body: Record<string, unknown>, eventId?: string): InboundInteractionEvent | undefined
  reaction(event: Record<string, unknown>, action: 'added' | 'removed', eventId?: string): InboundReactionEvent | undefined
  memberJoined(event: Record<string, unknown>, eventId?: string): InboundLifecycleEvent | undefined
}

function destination(chatId: string, threadId?: string): Destination {
  return threadId ? { type: PROVIDER, target: chatId, threadId } : { type: PROVIDER, target: chatId }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Dedup id: envelope `event_id` when carried, else a stable composite. */
function compositeId(parts: Array<string | undefined>): string {
  return parts.filter((part) => part !== undefined && part !== '').join(':')
}

/** `<@U…>` and `<@U…|name>` tokens in raw Slack text. */
const MENTION_TOKEN = /<@([A-Z][A-Z0-9]+)(?:\|([^>]*))?>/g

function extractMentions(text: string, botUserId: string): InboundMention[] {
  const mentions: InboundMention[] = []
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const id = match[1]!
    if (id === botUserId) continue
    mentions.push({
      actor: { providerUserId: id, ...(match[2] ? { displayName: match[2] } : {}) },
    })
  }
  return mentions
}

function visibleText(rawText: string, botUserId: string, mentionedBot: boolean): string {
  const text = mentionedBot ? stripMention(rawText, botUserId) : decodeSlackEntities(rawText)
  return text.trim()
}

export function createInboundMapper(config: SlackProviderConfig, identity: SlackIdentity, deps: InboundMapperDeps = {}): InboundMapper {
  const instanceId = config.instanceId
  const botUserId = identity.botUserId
  const warn = deps.warn ?? (() => {})

  function envelope(event: Record<string, unknown>): { channel: string; ts: string; occurredAt: number } {
    return {
      channel: str(event.channel),
      ts: str(event.ts),
      occurredAt: Number.isFinite(Number(event.ts)) ? Math.round(Number(event.ts) * 1000) : Date.now(),
    }
  }

  function messageEvent(
    event: Record<string, unknown>,
    opts: { mentionedBot?: boolean; containerKind: 'dm' | 'channel' },
    eventId?: string,
  ): InboundMessageEvent {
    const place = envelope(event)
    const rawText = str(event.text)
    const mentions = extractMentions(rawText, botUserId)
    const threadTs = str(event.thread_ts) || undefined
    if (Array.isArray(event.files) && event.files.length > 0) {
      warn(`dropping ${event.files.length} inbound file(s): no blob staging wired for raw slack events yet`)
    }
    return {
      kind: 'message',
      provider: PROVIDER,
      instanceId,
      eventId: eventId ?? compositeId([str(event.event_id) || undefined, 'msg', place.channel, place.ts, str(event.client_msg_id) || undefined]),
      occurredAt: place.occurredAt,
      receivedAt: Date.now(),
      destination: destination(place.channel, threadTs),
      actor: {
        providerUserId: str(event.user) || str(event.bot_id),
        ...(str(event.username) ? { displayName: str(event.username) } : {}),
        ...(event.bot_id ? { isBot: true } : {}),
      },
      text: visibleText(rawText, botUserId, opts.mentionedBot === true),
      ...(mentions.length ? { mentions } : {}),
      ...(threadTs ? { threadId: threadTs } : {}),
      replyToMessageId: place.ts,
      ...(opts.mentionedBot !== undefined ? { mentionedBot: opts.mentionedBot } : {}),
      containerKind: opts.containerKind,
    }
  }

  function appMention(event: Record<string, unknown>, eventId?: string): InboundMessageEvent {
    return messageEvent(event, { mentionedBot: true, containerKind: 'channel' }, eventId)
  }

  function message(event: Record<string, unknown>, eventId?: string): InboundMessageEvent | undefined {
    const subtype = str(event.subtype)
    if (subtype === 'message_changed' || subtype === 'message_deleted') return undefined
    if (event.bot_id || subtype === 'bot_message') return undefined
    if (botUserId && str(event.user) === botUserId) return undefined
    const channelType = str(event.channel_type)
    if (channelType === 'im') return messageEvent(event, { containerKind: 'dm' }, eventId)
    if (channelType === 'channel' || channelType === 'group' || channelType === 'mpim') {
      return messageEvent(event, { containerKind: 'channel' }, eventId)
    }
    return undefined
  }

  function blockActions(body: Record<string, unknown>, eventId?: string): InboundInteractionEvent | undefined {
    const message = (body.message as Record<string, unknown> | undefined) ?? {}
    const user = (body.user as Record<string, unknown> | undefined) ?? {}
    const actions = Array.isArray(body.actions) ? (body.actions as Array<Record<string, unknown>>) : []
    const action = actions[0]
    if (!action) return undefined
    // Interactive payloads carry the channel on body.channel.id; older
    // shapes repeat it on the message.
    const chatId = str((body.channel as Record<string, unknown> | undefined)?.id) || str(message.channel)
    const place = envelope(message)
    return {
      kind: 'interaction',
      provider: PROVIDER,
      instanceId,
      eventId: eventId ?? compositeId(['block', chatId, place.ts, str(user.id), str(action.action_ts)]),
      occurredAt: Date.now(),
      receivedAt: Date.now(),
      ref: { destination: destination(chatId), messageId: place.ts },
      actor: { providerUserId: str(user.id), ...(str(user.username) ? { displayName: str(user.username) } : {}) },
      action: {
        ...(str(action.action_id) ? { id: str(action.action_id) } : {}),
        value: action.value,
        ...(str(action.type) ? { tag: str(action.type) } : {}),
      },
    }
  }

  function reaction(
    event: Record<string, unknown>,
    action: 'added' | 'removed',
    eventId?: string,
  ): InboundReactionEvent | undefined {
    if (str(event.user) === botUserId) return undefined
    const place = envelope(event)
    return {
      kind: 'reaction',
      provider: PROVIDER,
      instanceId,
      eventId: eventId ?? compositeId(['reaction', place.channel, place.ts, str(event.user), str(event.reaction), action]),
      occurredAt: Number.isFinite(Number(event.event_ts)) ? Math.round(Number(event.event_ts) * 1000) : Date.now(),
      receivedAt: Date.now(),
      ref: { destination: destination(place.channel), messageId: place.ts },
      actor: { providerUserId: str(event.user) },
      emoji: str(event.reaction),
      action,
    }
  }

  function memberJoined(event: Record<string, unknown>, eventId?: string): InboundLifecycleEvent | undefined {
    if (str(event.user) !== botUserId) return undefined
    const channel = str(event.channel)
    return {
      kind: 'lifecycle',
      provider: PROVIDER,
      instanceId,
      eventId: eventId ?? compositeId(['bot_added', channel, str(event.event_ts)]),
      occurredAt: Number.isFinite(Number(event.event_ts)) ? Math.round(Number(event.event_ts) * 1000) : Date.now(),
      receivedAt: Date.now(),
      event: 'bot_added',
      spaceId: channel,
    }
  }

  return { appMention, message, blockActions, reaction, memberJoined }
}
