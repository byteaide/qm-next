/**
 * Inbound mapping: SDK normalized events → @qm/im-core InboundEvent.
 * The mapper binds instance id, blob staging and warning sink once, so the
 * per-event functions stay pure and fixture replays stay declarative.
 */
import type { CardActionEvent, NormalizedMessage, ReactionEvent, BotAddedEvent } from '@larksuiteoapi/node-sdk'
import type { Destination, IncomingAttachment } from '@qm/types'
import type {
  InboundInteractionEvent,
  InboundLifecycleEvent,
  InboundMessageEvent,
  InboundMention,
  InboundReactionEvent,
} from '@qm/im-core'
import type { FeishuProviderConfig } from './types.ts'

const PROVIDER = 'feishu'

export interface InboundMapper {
  message(msg: NormalizedMessage, eventId?: string): Promise<InboundMessageEvent>
  cardAction(evt: CardActionEvent, eventId?: string): InboundInteractionEvent
  reaction(evt: ReactionEvent, eventId?: string): InboundReactionEvent
  botAdded(evt: BotAddedEvent, eventId?: string): InboundLifecycleEvent
}

export interface InboundMapperDeps {
  /** Downloads + stages one resource into the core blob store; omit to drop files with a warning. */
  stageResource?: (fileKey: string, type: string, name?: string) => Promise<IncomingAttachment>
  warn?(message: string): void
}

function destination(chatId: string, threadId?: string): Destination {
  return threadId ? { type: PROVIDER, target: chatId, threadId } : { type: PROVIDER, target: chatId }
}

/** Provider dedup id from the raw payload's `event_id`, when carried. */
function extractEventId(raw: unknown): string | undefined {
  if (raw && typeof raw === 'object' && 'event_id' in raw) {
    const value = (raw as { event_id?: unknown }).event_id
    if (typeof value === 'string') return value
  }
  return undefined
}

export function createInboundMapper(config: FeishuProviderConfig, deps: InboundMapperDeps = {}): InboundMapper {
  const instanceId = config.instanceId
  const warn = deps.warn ?? (() => {})

  async function message(msg: NormalizedMessage, eventId?: string): Promise<InboundMessageEvent> {
    const attachments: IncomingAttachment[] = []
    for (const resource of msg.resources) {
      if (!deps.stageResource) {
        warn(`dropping inbound ${resource.type} ${resource.fileKey}: no blob port configured`)
        continue
      }
      attachments.push(await deps.stageResource(resource.fileKey, resource.type, resource.fileName))
    }
    const mentions: InboundMention[] = msg.mentions.map((m) => ({
      actor: {
        providerUserId: m.openId ?? '',
        ...(m.name ? { displayName: m.name } : {}),
        ...(m.isBot ? { isBot: true } : {}),
      },
      ...(m.isBot ? { isBot: true } : {}),
    }))
    return {
      kind: 'message',
      provider: PROVIDER,
      instanceId,
      eventId: eventId ?? extractEventId(msg.raw) ?? `msg:${msg.messageId}:${msg.createTime}`,
      occurredAt: msg.createTime,
      receivedAt: Date.now(),
      destination: destination(msg.chatId, msg.threadId),
      actor: { providerUserId: msg.senderId, ...(msg.senderName ? { displayName: msg.senderName } : {}) },
      text: msg.content,
      ...(mentions.length ? { mentions } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(msg.threadId ? { threadId: msg.threadId } : {}),
      ...(msg.replyToMessageId ? { replyToMessageId: msg.replyToMessageId } : {}),
      mentionedBot: msg.mentionedBot,
      containerKind: msg.chatType === 'p2p' ? 'dm' : 'channel',
    }
  }

  function cardAction(evt: CardActionEvent, eventId?: string): InboundInteractionEvent {
    const action = evt.action as { value?: unknown; tag?: string; option?: string }
    return {
      kind: 'interaction',
      provider: PROVIDER,
      instanceId,
      eventId: eventId ?? extractEventId(evt.raw) ?? `card:${evt.messageId}:${evt.operator.openId}`,
      occurredAt: Date.now(),
      receivedAt: Date.now(),
      ref: { destination: destination(evt.chatId), messageId: evt.messageId },
      actor: { providerUserId: evt.operator.openId, ...(evt.operator.name ? { displayName: evt.operator.name } : {}) },
      action: {
        value: action.value,
        ...(action.tag ? { tag: action.tag } : {}),
        ...(action.option ? { option: action.option } : {}),
      },
    }
  }

  function reaction(evt: ReactionEvent, eventId?: string): InboundReactionEvent {
    return {
      kind: 'reaction',
      provider: PROVIDER,
      instanceId,
      eventId: eventId ?? extractEventId(evt.raw) ?? `reaction:${evt.messageId}:${evt.operator.openId}:${evt.emojiType}:${evt.action}`,
      occurredAt: evt.actionTime ?? Date.now(),
      receivedAt: Date.now(),
      ref: { destination: destination(''), messageId: evt.messageId },
      actor: { providerUserId: evt.operator.openId },
      emoji: evt.emojiType,
      action: evt.action,
    }
  }

  function botAdded(evt: BotAddedEvent, eventId?: string): InboundLifecycleEvent {
    return {
      kind: 'lifecycle',
      provider: PROVIDER,
      instanceId,
      eventId: eventId ?? extractEventId(evt.raw) ?? `bot_added:${evt.chatId}:${evt.operator.openId}`,
      occurredAt: Date.now(),
      receivedAt: Date.now(),
      event: 'bot_added',
      spaceId: evt.chatId,
    }
  }

  return { message, cardAction, reaction, botAdded }
}
