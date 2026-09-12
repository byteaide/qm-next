/**
 * Fixture replay: canned SDK events flow through the captured channel
 * handlers (the real wire path) and come out as mapped InboundEvents;
 * outbound operations are asserted against recorded channel calls.
 * No sockets involved — the channel is a structural mock.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { CardActionEvent, NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type { ImBlobs } from '@qm/im-core'
import { IM_UNSUPPORTED_OP } from '@qm/im-core'
import { createFeishuProvider, createInboundMapper } from '../src/index.ts'
import type { FeishuChannelLike, FeishuProviderConfig } from '../src/index.ts'

const config: FeishuProviderConfig = {
  appId: 'cli_test',
  appSecret: 'secret',
  instanceId: 'test',
}

function messageFixture(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: 'om_123',
    chatId: 'oc_chat1',
    chatType: 'group',
    senderId: 'ou_user1',
    senderName: 'Alice',
    content: 'hello bot',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: 1_700_000_000_000,
    threadId: 'omt_root1',
    raw: { event_id: 'evt_1' },
    ...overrides,
  } as NormalizedMessage
}

function cardFixture(overrides: Partial<CardActionEvent> = {}): CardActionEvent {
  return {
    messageId: 'om_card1',
    chatId: 'oc_chat1',
    operator: { openId: 'ou_user2', name: 'Bob' },
    action: { value: { action: 'approve', runId: 'run-9' }, tag: 'button' },
    raw: { event_id: 'evt_card_1' },
    ...overrides,
  } as CardActionEvent
}

test('mapper: message fixture replays to InboundMessageEvent with dedup id, thread and actor', async () => {
  const mapper = createInboundMapper(config)
  const event = await mapper.message(messageFixture())
  assert.equal(event.kind, 'message')
  assert.equal(event.provider, 'feishu')
  assert.equal(event.instanceId, 'test')
  assert.equal(event.eventId, 'evt_1', 'raw event_id wins for dedup')
  assert.deepEqual(event.destination, { type: 'feishu', target: 'oc_chat1', threadId: 'omt_root1' })
  assert.deepEqual(event.actor, { providerUserId: 'ou_user1', displayName: 'Alice' })
  assert.equal(event.mentionedBot, true)
  assert.equal(event.threadId, 'omt_root1')
})

test('mapper: without raw event_id the fallback id is stable per message+time', async () => {
  const mapper = createInboundMapper(config)
  const msg = messageFixture({ raw: undefined })
  const first = await mapper.message(msg)
  const second = await mapper.message(msg)
  assert.equal(first.eventId, second.eventId)
  assert.match(first.eventId, /^msg:om_123:/)
})

test('mapper: resources stage through the blob port when present, drop with warning when not', async () => {
  const warnings: string[] = []
  const staged: string[] = []
  const blobs: ImBlobs = {
    stage: async (content, meta) => {
      staged.push(`${meta?.name}:${content.length}`)
      return { name: meta?.name ?? 'file', mimetype: meta?.mimetype ?? 'application/octet-stream', sizeBytes: content.length, blobId: 'blob_1' }
    },
    read: async () => Buffer.from('x'),
  }
  const mapper = createInboundMapper(config, {
    stageResource: (fileKey) => blobs.stage(Buffer.from('bytes'), { name: fileKey, mimetype: 'image/png' }),
    warn: (m) => warnings.push(m),
  })
  const msg = messageFixture({
    resources: [{ type: 'image', fileKey: 'img_key1' }],
  })
  const stagedEvent = await mapper.message(msg)
  assert.equal(stagedEvent.attachments?.[0]?.blobId, 'blob_1')
  assert.deepEqual(staged, ['img_key1:5'])

  const bare = createInboundMapper(config, { warn: (m) => warnings.push(m) })
  const dropped = await bare.message(msg)
  assert.equal(dropped.attachments, undefined)
  assert.equal(warnings.length, 1, 'drop warned once')
})

test('mapper: card action replays to interaction with value round-trip', () => {
  const mapper = createInboundMapper(config)
  const event = mapper.cardAction(cardFixture())
  assert.equal(event.kind, 'interaction')
  assert.equal(event.eventId, 'evt_card_1')
  assert.deepEqual(event.action.value, { action: 'approve', runId: 'run-9' })
  assert.equal(event.ref.messageId, 'om_card1')
  assert.deepEqual(event.ref.destination, { type: 'feishu', target: 'oc_chat1' })
  assert.equal(event.actor.providerUserId, 'ou_user2')
})

test('mapper: reaction and botAdded fixtures replay to their kinds', () => {
  const mapper = createInboundMapper(config)
  const reaction = mapper.reaction({ messageId: 'om_1', operator: { openId: 'ou_1' }, emojiType: 'THUMBSUP', action: 'added' })
  assert.equal(reaction.kind, 'reaction')
  assert.equal(reaction.emoji, 'THUMBSUP')
  assert.equal(reaction.action, 'added')
  const lifecycle = mapper.botAdded({ chatId: 'oc_new', operator: { openId: 'ou_1' } })
  assert.equal(lifecycle.kind, 'lifecycle')
  assert.equal(lifecycle.event, 'bot_added')
  assert.equal(lifecycle.spaceId, 'oc_new')
})

interface RecordedSend {
  to: string
  input: Record<string, unknown>
  opts?: { replyTo?: string; replyInThread?: boolean }
}

type ChannelHandlers = {
  message?: (msg: NormalizedMessage) => void | Promise<void>
  cardAction?: (evt: CardActionEvent) => void | Promise<void>
  reaction?: (evt: { messageId: string; operator: { openId: string }; emojiType: string; action: 'added' | 'removed' }) => void
  botAdded?: (evt: { chatId: string; operator: { openId: string } }) => void
}

function mockChannel(overrides: Partial<FeishuChannelLike> = {}): {
  channel: FeishuChannelLike
  sends: RecordedSend[]
  dispatch: {
    message: (msg: NormalizedMessage) => Promise<void>
    cardAction: (evt: CardActionEvent) => Promise<void>
  }
} {
  const sends: RecordedSend[] = []
  const handlers: ChannelHandlers = {}
  const channel: FeishuChannelLike = {
    connect: async () => {},
    disconnect: async () => {},
    on: (nameOrHandlers: string | Partial<ChannelHandlers>, maybeHandler?: unknown): (() => void) => {
      if (typeof nameOrHandlers === 'string') {
        ;(handlers as Record<string, unknown>)[nameOrHandlers] = maybeHandler
        return () => {}
      }
      Object.assign(handlers, nameOrHandlers)
      return () => {}
    },
    send: async (to: string, input: Record<string, unknown>, opts?: { replyTo?: string; replyInThread?: boolean }) => {
      sends.push({ to, input, ...(opts ? { opts } : {}) })
      return { messageId: `om_sent_${sends.length}` }
    },
    editMessage: async () => {},
    updateCard: async () => {},
    recallMessage: async () => {},
    downloadResource: async () => Buffer.from('bytes'),
    getChatInfo: async () => ({ chatId: 'oc_chat1', chatType: 'group' }),
    ...overrides,
  }
  return {
    channel,
    sends,
    dispatch: {
      message: async (msg) => { await handlers.message?.(msg) },
      cardAction: async (evt) => { await handlers.cardAction?.(evt) },
    },
  }
}

function providerHarness(overrides: Partial<FeishuChannelLike> = {}, blobs?: ImBlobs) {
  const { channel, sends, dispatch } = mockChannel(overrides)
  const provider = createFeishuProvider(config, {
    channelFactory: () => channel,
    ...(blobs ? { blobs } : {}),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  })
  const emitted: unknown[] = []
  const startCtx = {
    name: 'feishu:test',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    signal: new AbortController().signal,
    emit: async (events: unknown | readonly unknown[]) => {
      for (const e of Array.isArray(events) ? events : [events]) emitted.push(e)
    },
    ...(blobs ? { blobs } : {}),
  }
  return { provider, start: () => provider.start(startCtx as never), emitted, sends, dispatch }
}

test('provider start wires handlers, replays a fixture message through emit, stop disconnects', async () => {
  const { provider, start, emitted, dispatch } = providerHarness()
  await start()
  assert.deepEqual(provider.capabilities(), {
    threads: true, edit: true, delete: true, react: false, uploadFile: false,
    interactive: true, streaming: true, directorySync: true, markdown: 'converted',
  })
  await dispatch.message(messageFixture())
  assert.equal(emitted.length, 1)
  assert.equal((emitted[0] as { eventId: string }).eventId, 'evt_1')
  await dispatch.cardAction(cardFixture())
  assert.equal((emitted[1] as { kind: string }).kind, 'interaction')
  await provider.stop()
  await assert.rejects(
    () => provider.outbound([{ op: 'send', destination: { type: 'feishu', target: 'oc' }, body: { text: 'x' } }]),
    /not started/,
  )
})

test('outbound: text, markdown and card sends replay to channel sends with thread options', async () => {
  const { provider, sends, start } = providerHarness()
  await start()

  await provider.outbound([{ op: 'send', destination: { type: 'feishu', target: 'oc_chat1' }, body: { text: 'plain' } }])
  await provider.outbound([{ op: 'send', destination: { type: 'feishu', target: 'oc_chat1' }, body: { markdown: '**hi**' }, replyToMessageId: 'om_root' }])
  await provider.outbound([{ op: 'send', destination: { type: 'feishu', target: 'oc_chat1' }, body: { card: { elements: [] } }, threadId: 'omt_root' }])

  assert.equal(sends.length, 3)
  assert.deepEqual(sends[0]!.input, { text: 'plain' })
  assert.deepEqual(sends[0]!.to, 'oc_chat1')
  assert.deepEqual(sends[1]!.input, { markdown: '**hi**' })
  assert.deepEqual(sends[1]!.opts, { replyTo: 'om_root', replyInThread: true }, 'replyToMessageId maps to thread reply')
  assert.deepEqual(sends[2]!.input, { card: { elements: [] } })
  assert.deepEqual(sends[2]!.opts, { replyTo: 'omt_root', replyInThread: true }, 'threadId maps to thread reply')
})

test('outbound: attachment send reads bytes through the blob port and posts a file message', async () => {
  const reads: string[] = []
  const blobs: ImBlobs = {
    stage: async () => { throw new Error('unused') },
    read: async (blobId: string) => {
      reads.push(blobId)
      return Buffer.from('attachment-bytes')
    },
  }
  const { provider, sends, start } = providerHarness({}, blobs)
  await start()
  const receipts = await provider.outbound([
    {
      op: 'send',
      destination: { type: 'feishu', target: 'oc_chat1' },
      body: {
        text: 'see attached',
        attachments: [{ name: 'report.pdf', mimetype: 'application/pdf', sizeBytes: 16, blobId: 'blob_pdf1' }],
      },
    },
  ])
  assert.deepEqual(reads, ['blob_pdf1'])
  assert.equal(sends.length, 2, 'text first, then the file message')
  assert.deepEqual(sends[1]!.input, { file: { source: Buffer.from('attachment-bytes'), fileName: 'report.pdf' } })
  assert.equal(receipts[0]?.ref?.messageId, 'om_sent_2', 'receipt points at the last message')
})

test('outbound: edit routes text → editMessage and card → updateCard; delete recalls', async () => {
  const edits: Array<{ messageId: string; text: string }> = []
  const cardUpdates: Array<{ messageId: string; card: object }> = []
  const recalls: string[] = []
  const { provider, start } = providerHarness({
    editMessage: async (messageId, text) => {
      edits.push({ messageId, text })
    },
    updateCard: async (messageId, card) => {
      cardUpdates.push({ messageId, card })
    },
    recallMessage: async (messageId) => {
      recalls.push(messageId)
    },
  })
  await start()
  const ref = { destination: { type: 'feishu', target: 'oc_chat1' }, messageId: 'om_1' }
  await provider.outbound([{ op: 'edit', ref, body: { text: 'updated' } }])
  await provider.outbound([{ op: 'edit', ref, body: { card: { header: {} } } }])
  await provider.outbound([{ op: 'delete', ref }])
  assert.deepEqual(edits, [{ messageId: 'om_1', text: 'updated' }])
  assert.deepEqual(cardUpdates, [{ messageId: 'om_1', card: { header: {} } }])
  assert.deepEqual(recalls, ['om_1'])
})

test('outbound: react and uploadFile are reserved positions rejected with the contract sentinel', async () => {
  const { provider, start } = providerHarness()
  await start()
  const ref = { destination: { type: 'feishu', target: 'oc_chat1' }, messageId: 'om_1' }
  await assert.rejects(
    () => provider.outbound([{ op: 'react', ref, emoji: 'THUMBSUP', action: 'add' }]),
    (error: Error & { code?: string }) => error.code === IM_UNSUPPORTED_OP,
  )
  await assert.rejects(
    () => provider.outbound([{ op: 'uploadFile', destination: { type: 'feishu', target: 'oc' }, file: { name: 'f', mimetype: 'text/plain', sizeBytes: 1, blobId: 'b' }, content: new Uint8Array() }]),
    (error: Error & { code?: string }) => error.code === IM_UNSUPPORTED_OP,
  )
})
