/**
 * The Slack IM provider: ImProvider implementation over `@slack/socket-mode`
 * (websocket transport — no public callback URL, mirroring the Feishu
 * long-connection choice) plus `@slack/web-api` for outbound. Markdown
 * converts through the ported mrkdwn pipeline; approval cards are Block Kit.
 */
import { SocketModeClient } from '@slack/socket-mode'
import { WebClient } from '@slack/web-api'
import { IM_UNSUPPORTED_OP, type ImApprovalCardRenderer, type ImCapabilities, type ImProvider, type ImProviderStartContext, type InboundEvent, type OutboundOperation, type OutboundReceipt } from '@qm/im-core'
import type { Destination, OutgoingAttachment } from '@qm/types'
import { createSlackApprovalCardRenderer } from './card-renderer.ts'
import { createInboundMapper, type SlackIdentity } from './map-inbound.ts'
import { toSlackMrkdwn } from './mrkdwn.ts'
import type { SlackClientsLike, SlackProviderConfig, SlackProviderDeps, SlackSocketLike } from './types.ts'

const PROVIDER = 'slack'

function unsupported(op: OutboundOperation['op'], detail: string): Error {
  const error = new Error(`slack: operation "${op}" unsupported: ${detail}`) as Error & { code: typeof IM_UNSUPPORTED_OP }
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
    streaming: false,
    directorySync: true,
    markdown: 'converted',
  }
}

function defaultSocketFactory(config: SlackProviderConfig): SlackSocketLike {
  const socket = new SocketModeClient({ appToken: config.appToken })
  return {
    on: (name, handler) => {
      socket.on(name as never, handler as never)
      return () => socket.off(name as never, handler as never)
    },
    connect: () => socket.start().then(() => undefined),
    disconnect: () => socket.disconnect(),
  }
}

function defaultClientsFactory(config: SlackProviderConfig): SlackClientsLike {
  const client = new WebClient(config.botToken)
  return client as unknown as SlackClientsLike
}

/** Outbound body → chat payload pieces (text wins for plain, blocks for cards). */
function bodyToArgs(body: { text?: string; markdown?: string; card?: Record<string, unknown> }): { text?: string; blocks?: unknown[] } {
  if (body.card !== undefined) {
    const blocks = (body.card as { blocks?: unknown[] }).blocks
    return Array.isArray(blocks) ? { blocks } : { text: JSON.stringify(body.card) }
  }
  if (body.text !== undefined) return { text: body.text }
  if (body.markdown !== undefined) return { text: toSlackMrkdwn(body.markdown) }
  return {}
}

export function createSlackProvider(config: SlackProviderConfig, deps: SlackProviderDeps = {}): ImProvider {
  const logger = deps.logger ?? console
  const socketFactory = deps.socketFactory ?? defaultSocketFactory
  const clientsFactory = deps.clientsFactory ?? defaultClientsFactory
  let socket: SlackSocketLike | undefined
  let clients: SlackClientsLike | undefined
  let startCtx: ImProviderStartContext | undefined
  let identity: SlackIdentity = { botUserId: '' }
  const unwire: Array<() => void> = []

  function requireClients(): SlackClientsLike {
    if (!clients) throw new Error('slack provider is not started')
    return clients
  }

  function emitMapped(map: () => InboundEvent | undefined): Promise<void> {
    const ctx = startCtx
    if (!ctx) return Promise.resolve()
    const event = map()
    return event === undefined ? Promise.resolve() : ctx.emit(event)
  }

  async function sendOp(op: Extract<OutboundOperation, { op: 'send' }>): Promise<OutboundReceipt> {
    const api = requireClients()
    const args: Record<string, unknown> = {
      channel: op.destination.target,
      ...(op.threadId ? { thread_ts: op.threadId } : {}),
      ...(op.replyToMessageId ? { thread_ts: op.replyToMessageId } : {}),
      ...bodyToArgs(op.body),
    }
    const attachments = op.body.attachments ?? []
    if (op.body.text === undefined && op.body.markdown === undefined && op.body.card === undefined && attachments.length === 0) {
      throw new Error('slack: send operation carries no text, markdown, card or attachments')
    }
    const sent = await api.chat.postMessage(args)
    const lastTs = attachments.length > 0 ? await uploadAttachments(op, String(sent.ts ?? '')) : String(sent.ts ?? '')
    return { op: 'send', ref: { destination: op.destination, messageId: lastTs } }
  }

  async function uploadAttachments(op: Extract<OutboundOperation, { op: 'send' }>, threadTs: string): Promise<string> {
    const api = requireClients()
    if (!api.files) throw unsupported('send', `attachment upload needs the files API (missing on this client)`)
    let lastTs = threadTs
    for (const attachment of op.body.attachments ?? []) {
      const content = await readAttachment(attachment)
      const result = await api.files.uploadV2({
        channel_id: op.destination.target,
        file: { data: content, filename: attachment.name },
        ...(threadTs || op.threadId || op.replyToMessageId ? { thread_ts: threadTs || op.threadId || op.replyToMessageId } : {}),
        title: attachment.name,
      })
      const ts = extractUploadedTs(result)
      if (ts) lastTs = ts
    }
    return lastTs
  }

  function extractUploadedTs(result: unknown): string | undefined {
    type Shared = { ts?: string }
    const files = (result as { files?: Array<{ shares?: Record<string, Record<string, Shared[]>> }> }).files
    if (!files?.length) return undefined
    for (const share of Object.values(files[0]!.shares ?? {})) {
      for (const message of Object.values(share)) {
        const ts = message[0]?.ts
        if (ts) return ts
      }
    }
    return undefined
  }

  async function readAttachment(attachment: OutgoingAttachment): Promise<Buffer> {
    if (!deps.blobs) throw unsupported('send', `attachment "${attachment.name}" has no blob port to read "${attachment.blobId}"`)
    return Buffer.from(await deps.blobs.read(attachment.blobId))
  }

  async function outbound(ops: readonly OutboundOperation[]): Promise<OutboundReceipt[]> {
    const api = requireClients()
    const receipts: OutboundReceipt[] = []
    for (const op of ops) {
      switch (op.op) {
        case 'send': {
          receipts.push(await sendOp(op))
          break
        }
        case 'edit': {
          const args = {
            channel: op.ref.destination.target,
            ts: op.ref.messageId,
            ...bodyToArgs(op.body),
          }
          if (args.text === undefined && args.blocks === undefined) {
            throw new Error('slack: edit operation carries no text/markdown/card body')
          }
          await api.chat.update(args)
          receipts.push({ op: 'edit', ref: op.ref })
          break
        }
        case 'delete': {
          await api.chat.delete({ channel: op.ref.destination.target, ts: op.ref.messageId })
          receipts.push({ op: 'delete' })
          break
        }
        case 'uploadFile': {
          throw unsupported('uploadFile', 'slack uploads ride with send; put the attachment on the send body')
        }
        case 'react': {
          throw unsupported('react', 'reserved position; v1 ships no reaction features')
        }
      }
    }
    return receipts
  }

  const approvalCardRenderer: ImApprovalCardRenderer = createSlackApprovalCardRenderer()

  return {
    provider: PROVIDER,
    instanceId: config.instanceId,
    capabilities,
    approvalCardRenderer,
    async start(ctx: ImProviderStartContext): Promise<void> {
      startCtx = ctx
      clients = clientsFactory(config)
      const auth = await clients.auth.test()
      identity = {
        botUserId: String(auth.user_id ?? ''),
        ...(auth.bot_id ? { botId: String(auth.bot_id) } : {}),
      }
      const mapper = createInboundMapper(config, identity, { warn: (message) => logger.warn(`slack:${config.instanceId}: ${message}`) })
      const ack = (payload: { ack: () => void }): void => {
        try {
          payload.ack()
        } catch (error) {
          logger.warn(`slack:${config.instanceId}: ack failed`, error)
        }
      }
      socket = socketFactory(config)
      unwire.push(socket.on('app_mention', async (payload) => {
        ack(payload)
        await emitMapped(() => mapper.appMention(payload.event ?? payload.body, str0((payload.body as { event_id?: unknown }).event_id)))
      }))
      unwire.push(socket.on('message', async (payload) => {
        ack(payload)
        await emitMapped(() => mapper.message(payload.event ?? payload.body, str0((payload.body as { event_id?: unknown }).event_id)))
      }))
      unwire.push(socket.on('block_actions', async (payload) => {
        ack(payload)
        await emitMapped(() => mapper.blockActions(payload.body))
      }))
      unwire.push(socket.on('reaction_added', async (payload) => {
        ack(payload)
        await emitMapped(() => mapper.reaction(payload.event ?? payload.body, 'added'))
      }))
      unwire.push(socket.on('reaction_removed', async (payload) => {
        ack(payload)
        await emitMapped(() => mapper.reaction(payload.event ?? payload.body, 'removed'))
      }))
      unwire.push(socket.on('member_joined_channel', async (payload) => {
        ack(payload)
        await emitMapped(() => mapper.memberJoined(payload.event ?? payload.body))
      }))
      await socket.connect()
      ctx.logger.info(`slack:${config.instanceId} connected as ${identity.botUserId || '(unknown user)'}`)
    },
    async stop(): Promise<void> {
      for (const off of unwire.splice(0)) off()
      if (socket) {
        await socket.disconnect()
        socket = undefined
      }
      clients = undefined
      startCtx = undefined
    },
    outbound,
    format(markdown: string) {
      return { text: toSlackMrkdwn(markdown) }
    },
    async collectDirectory() {
      const api = requireClients()
      const spaces: Array<{ spaceId: string; name?: string; kind: 'channel' | 'group' | 'dm'; isPrivate?: boolean }> = []
      let spaceCursor: string | undefined
      for (;;) {
        const page = await api.conversations.list({
          types: 'public_channel,private_channel,mpim,im',
          limit: 200,
          ...(spaceCursor ? { cursor: spaceCursor } : {}),
        })
        for (const channel of page.channels ?? []) {
          const id = String(channel.id ?? '')
          if (!id) continue
          const kind = channel.is_im === true ? 'dm' : channel.is_mpim === true ? 'group' : 'channel'
          spaces.push({
            spaceId: id,
            ...(typeof channel.name === 'string' && channel.name ? { name: channel.name } : {}),
            kind,
            ...(channel.is_private === true ? { isPrivate: true } : {}),
          })
        }
        spaceCursor = page.response_metadata?.next_cursor || undefined
        if (!spaceCursor) break
      }
      const people: Array<{ providerUserId: string; displayName?: string; email?: string; type: 'internal' }> = []
      let userCursor: string | undefined
      for (;;) {
        const page = await api.users.list({ limit: 200, ...(userCursor ? { cursor: userCursor } : {}) })
        for (const member of page.members ?? []) {
          const id = String(member.id ?? '')
          if (!id || member.is_bot === true) continue
          const profile = (member.profile as { email?: unknown; real_name?: unknown } | undefined) ?? {}
          people.push({
            providerUserId: id,
            ...(typeof profile.real_name === 'string' && profile.real_name ? { displayName: profile.real_name } : {}),
            ...(typeof profile.email === 'string' && profile.email ? { email: profile.email } : {}),
            type: 'internal',
          })
        }
        userCursor = page.response_metadata?.next_cursor || undefined
        if (!userCursor) break
      }
      return {
        provider: PROVIDER,
        instanceId: config.instanceId,
        people,
        spaces,
        replace: ['people', 'spaces'],
        syncedAt: Date.now(),
      }
    },
    destination(chatId: string, threadId?: string): Destination {
      return threadId ? { type: PROVIDER, target: chatId, threadId } : { type: PROVIDER, target: chatId }
    },
  }
}

function str0(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}
