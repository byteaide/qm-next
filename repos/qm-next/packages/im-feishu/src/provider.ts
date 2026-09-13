/**
 * The Feishu IM provider: ImProvider implementation over the SDK's
 * `createLarkChannel` (websocket transport). Spike conclusions applied:
 * card actions ride the WS `card.action.trigger` event, markdown converts
 * via the channel's builtin converter, edits only support text/post.
 */
import { createLarkChannel } from '@larksuiteoapi/node-sdk'
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'
import { IM_UNSUPPORTED_OP, type ImCapabilities, type ImProvider, type ImProviderStartContext, type OutboundOperation, type OutboundReceipt } from '@qm/im-core'
import type { Destination, OutgoingAttachment } from '@qm/types'
import { createLarkApprovalCardRenderer } from './card-renderer.ts'
import { createInboundMapper, type InboundMapperDeps } from './map-inbound.ts'
import type { FeishuChannelLike, FeishuProviderConfig, FeishuProviderDeps } from './types.ts'

const PROVIDER = 'feishu'

/** The SDK's `domain` takes an enum or a full base URL — never the short key. */
const LARK_BASE_URLS = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
} as const

function unsupported(op: OutboundOperation['op'], detail: string): Error {
  const error = new Error(`feishu: operation "${op}" unsupported: ${detail}`) as Error & { code: typeof IM_UNSUPPORTED_OP }
  error.code = IM_UNSUPPORTED_OP
  return error
}

function capabilities(): ImCapabilities {
  return {
    threads: true,
    edit: true,
    delete: true,
    react: false,
    uploadFile: false,
    interactive: true,
    streaming: true,
    directorySync: true,
    markdown: 'converted',
  }
}

function defaultChannelFactory(config: FeishuProviderConfig): FeishuChannelLike {
  return createLarkChannel({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: LARK_BASE_URLS[config.domain ?? 'feishu'],
    transport: 'websocket',
    // SDK-level group admission defaults to requireMention:true, which
    // drops un-@mentioned chatter before it reaches the core — ambient
    // needs those events. Core owns addressing: the bridge routes
    // mentions/DMs to human turns and ambient candidates to the judge.
    policy: { requireMention: false },
    ...(config.verificationToken || config.encryptKey
      ? { webhook: { ...(config.verificationToken ? { verificationToken: config.verificationToken } : {}), ...(config.encryptKey ? { encryptKey: config.encryptKey } : {}) } }
      : {}),
    wsConfig: { pingTimeout: config.pingTimeoutSec ?? 30 },
    handshakeTimeoutMs: 10_000,
    includeRawEvent: true,
  }) as unknown as FeishuChannelLike
}

export function createFeishuProvider(config: FeishuProviderConfig, deps: FeishuProviderDeps = {}): ImProvider {
  const logger = deps.logger ?? console
  const factory = deps.channelFactory ?? defaultChannelFactory
  let channel: FeishuChannelLike | undefined
  let startCtx: ImProviderStartContext | undefined
  const unwire: Array<() => void> = []

  const mapperDeps: InboundMapperDeps = { warn: (message) => logger.warn(`feishu:${config.instanceId}: ${message}`) }
  if (deps.blobs) {
    const blobs = deps.blobs
    mapperDeps.stageResource = async (fileKey, type, name) => {
      const content = await channel!.downloadResource(fileKey, type === 'image' ? 'image' : 'file')
      return blobs.stage(content, { ...(name ? { name } : {}), mimetype: type })
    }
  }
  const mapper = createInboundMapper(config, mapperDeps)

  async function sendOp(op: Extract<OutboundOperation, { op: 'send' }>): Promise<OutboundReceipt> {
    const ch = requireChannel()
    const body = op.body
    const options = op.replyToMessageId
      ? { replyTo: op.replyToMessageId, replyInThread: true }
      : op.threadId
        ? { replyTo: op.threadId, replyInThread: true }
        : undefined

    const primary = body.text !== undefined
      ? { text: body.text }
      : body.markdown !== undefined
        ? { markdown: body.markdown }
        : body.card !== undefined
          ? { card: body.card }
          : undefined
    if (!primary && !(body.attachments?.length)) {
      throw new Error('feishu: send operation carries no text, markdown, card or attachments')
    }

    let lastMessageId = ''
    if (primary) {
      const receipt = await ch.send(op.destination.target, primary, options)
      lastMessageId = receipt.messageId
    }
    for (const attachment of body.attachments ?? []) {
      const source = await readAttachment(attachment)
      const input = attachment.mimetype.startsWith('image/')
        ? { image: { source } }
        : { file: { source, fileName: attachment.name } }
      const receipt = await ch.send(op.destination.target, input, options)
      lastMessageId = receipt.messageId
    }
    return { op: 'send', ref: { destination: op.destination, messageId: lastMessageId } }
  }

  async function readAttachment(attachment: OutgoingAttachment): Promise<Buffer> {
    if (!deps.blobs) throw unsupported('send', `attachment "${attachment.name}" has no blob port to read "${attachment.blobId}"`)
    return Buffer.from(await deps.blobs.read(attachment.blobId))
  }

  async function outbound(ops: readonly OutboundOperation[]): Promise<OutboundReceipt[]> {
    const ch = requireChannel()
    const receipts: OutboundReceipt[] = []
    for (const op of ops) {
      switch (op.op) {
        case 'send': {
          receipts.push(await sendOp(op))
          break
        }
        case 'edit': {
          if (op.body.card !== undefined) {
            await ch.updateCard(op.ref.messageId, op.body.card)
          } else {
            const text = op.body.text ?? op.body.markdown
            if (text === undefined) throw new Error('feishu: edit operation carries no text/markdown/card body')
            await ch.editMessage(op.ref.messageId, text)
          }
          receipts.push({ op: 'edit', ref: op.ref })
          break
        }
        case 'delete': {
          await ch.recallMessage(op.ref.messageId)
          receipts.push({ op: 'delete' })
          break
        }
        case 'uploadFile': {
          throw unsupported('uploadFile', 'feishu uploads ride with send; put the attachment on the send body')
        }
        case 'react': {
          throw unsupported('react', 'reserved position; v1 ships no reaction features')
        }
      }
    }
    return receipts
  }

  function requireChannel(): FeishuChannelLike {
    if (!channel) throw new Error('feishu provider is not started')
    return channel
  }

  function handleWireMessage(msg: NormalizedMessage): Promise<void> {
    const ctx = startCtx
    if (!ctx) return Promise.resolve()
    return mapper.message(msg).then((event) => ctx.emit(event))
  }

  return {
    provider: PROVIDER,
    instanceId: config.instanceId,
    capabilities,
    approvalCardRenderer: createLarkApprovalCardRenderer(),
    async start(ctx: ImProviderStartContext): Promise<void> {
      startCtx = ctx
      channel = factory(config)
      const offHandlers = channel.on({
        message: (msg) => handleWireMessage(msg),
        cardAction: (evt) => ctx.emit(mapper.cardAction(evt)),
        reaction: (evt) => ctx.emit(mapper.reaction(evt)),
        botAdded: (evt) => ctx.emit(mapper.botAdded(evt)),
      })
      unwire.push(offHandlers)
      await channel.connect()
      ctx.logger.info(`feishu:${config.instanceId} connected`)
    },
    async stop(): Promise<void> {
      for (const off of unwire.splice(0)) off()
      if (channel) {
        await channel.disconnect()
        channel = undefined
      }
      startCtx = undefined
    },
    outbound,
    format(markdown: string) {
      return { markdown }
    },
    async collectDirectory() {
      const ch = requireChannel()
      if (!ch.rawClient) throw new Error('feishu: collectDirectory requires the raw client (not available in this channel)')
      const spaces: Array<{ spaceId: string; name?: string; kind: 'channel' | 'group' | 'dm'; isPrivate?: boolean; isExternal?: boolean }> = []
      let pageToken: string | undefined
      for (;;) {
        const page = await ch.rawClient.im.v1.chat.list({ params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) } })
        for (const item of page.data?.items ?? []) {
          if (!item.chat_id) continue
          const kind = item.chat_type === 'p2p' ? 'dm' : 'group'
          spaces.push({
            spaceId: item.chat_id,
            ...(item.name ? { name: item.name } : {}),
            kind,
            ...(item.external ? { isExternal: true } : {}),
          })
        }
        if (!page.data?.has_more || !page.data.page_token) break
        pageToken = page.data.page_token
      }
      return { provider: PROVIDER, instanceId: config.instanceId, spaces, replace: ['spaces'], syncedAt: Date.now() }
    },
    destination(chatId: string, threadId?: string): Destination {
      return threadId ? { type: PROVIDER, target: chatId, threadId } : { type: PROVIDER, target: chatId }
    },
  }
}
