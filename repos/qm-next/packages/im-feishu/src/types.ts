/**
 * Feishu provider configuration and the structural channel subset the
 * adapter consumes. Tests inject a mock channel; production wires the real
 * `createLarkChannel` (spike 6.0: WS transport, card actions ride the WS
 * `card.action.trigger` event).
 */
import type {
  CardActionEvent,
  ChatInfo,
  NormalizedMessage,
  ReactionEvent,
  BotAddedEvent,
} from '@larksuiteoapi/node-sdk'
import type { ImBlobs, ImLogger } from '@qm/im-core'

/** Provider config (schemastery schema in index.ts mirrors these fields). */
export interface FeishuProviderConfig {
  /** Feishu open-platform app id (`cli_*`). */
  appId: string
  appSecret: string
  /** Instance label within qm-next (e.g. "prod"). */
  instanceId: string
  /** Event/card callback verification; needed for signed callback validation. */
  verificationToken?: string
  encryptKey?: string
  /** "feishu" (default) or "lark". */
  domain?: 'feishu' | 'lark'
  /** Liveness watchdog seconds (spike: keep above server ping cadence ~1min). */
  pingTimeoutSec?: number
}

/**
 * Structural slice of the SDK's LarkChannel the adapter touches. Keeping it
 * structural lets fixture tests inject recordings instead of a live socket.
 */
export interface FeishuChannelLike {
  connect(): Promise<void>
  disconnect(): Promise<void>
  on(name: 'message', handler: (msg: NormalizedMessage) => void | Promise<void>): () => void
  on(name: 'cardAction', handler: (evt: CardActionEvent) => void | Promise<void>): () => void
  on(name: 'reaction', handler: (evt: ReactionEvent) => void): () => void
  on(name: 'botAdded', handler: (evt: BotAddedEvent) => void): () => void
  on(handlers: {
    message?: (msg: NormalizedMessage) => void | Promise<void>
    cardAction?: (evt: CardActionEvent) => void | Promise<void>
    reaction?: (evt: ReactionEvent) => void
    botAdded?: (evt: BotAddedEvent) => void
  }): () => void
  send(to: string, input: Record<string, unknown>, opts?: { replyTo?: string; replyInThread?: boolean }): Promise<{ messageId: string; chunkIds?: string[] }>
  editMessage(messageId: string, text: string): Promise<void>
  updateCard(messageId: string, card: object): Promise<void>
  recallMessage(messageId: string): Promise<void>
  downloadResource(fileKey: string, type: 'image' | 'file'): Promise<Buffer>
  getChatInfo(chatId: string): Promise<ChatInfo>
  /** Directory pulls need the raw API surface; absent in minimal test doubles. */
  rawClient?: {
    im: {
      v1: {
        chat: {
          list(payload?: { params?: { page_size?: number; page_token?: string } }): Promise<{
            code?: number
            data?: {
              items?: Array<{ chat_id?: string; name?: string; chat_type?: string; external?: boolean; owner_id?: string; user_count?: string }>
              page_token?: string
              has_more?: boolean
            }
          }>
        }
        messageReaction: {
          create(payload: { path: { message_id: string }; data: { reaction_type: { emoji_type: string } } }): Promise<{
            code?: number
            data?: { reaction_id?: string }
          }>
          list(payload: { path: { message_id: string }; params?: { emoji_type?: string; page_size?: number } }): Promise<{
            code?: number
            data?: { items?: Array<{ reaction_id?: string }> }
          }>
          delete(payload: { path: { message_id: string; reaction_id: string } }): Promise<{ code?: number }>
        }
      }
    }
  }
}

export interface FeishuProviderDeps {
  /** Override the channel constructor (fixture tests inject recordings). */
  channelFactory?: (config: FeishuProviderConfig) => FeishuChannelLike
  logger?: ImLogger
  /** Blob port; when absent, inbound files are dropped with a warning. */
  blobs?: ImBlobs
}
