/**
 * Fixture replay: canned Socket Mode payloads flow through the captured
 * socket handlers (the real wire path) and come out as mapped
 * InboundEvents; outbound operations are asserted against recorded
 * WebClient calls. No sockets involved — structural doubles only.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ApprovalActionValue } from '@qm/approvals'
import { APPROVAL_VALUE_KIND, parseApprovalValue } from '@qm/approvals'
import type { InboundEvent } from '@qm/im-core'
import { IM_UNSUPPORTED_OP } from '@qm/im-core'
import { createInboundMapper, createSlackApprovalCardRenderer, createSlackProvider, slackApprovalCard, SLACK_APPROVAL_ACTION } from '../src/index.ts'
import type { SlackClientsLike, SlackHandlerPayload, SlackIdentity, SlackProviderConfig, SlackSocketLike } from '../src/index.ts'

const config: SlackProviderConfig = { appToken: 'xapp-test', botToken: 'xoxb-test', instanceId: 'test' }
const identity: SlackIdentity = { botUserId: 'U_BOT', botId: 'B_BOT' }

function mapper(): ReturnType<typeof createInboundMapper> {
  return createInboundMapper(config, identity)
}

test('mapper: app_mention replays to an addressed channel message with the bot mention stripped', () => {
  const event = mapper().appMention({
    channel: 'C1',
    user: 'U1',
    text: '<@U_BOT> deploy please',
    ts: '1700000000.000100',
    event_id: 'Ev1',
  }, 'Ev1')
  assert.equal(event.kind, 'message')
  assert.equal(event.provider, 'slack')
  assert.equal(event.instanceId, 'test')
  assert.equal(event.eventId, 'Ev1')
  assert.equal(event.mentionedBot, true)
  assert.equal(event.text, 'deploy please')
  assert.equal(event.containerKind, 'channel')
  assert.equal(event.replyToMessageId, '1700000000.000100')
  assert.deepEqual(event.destination, { type: 'slack', target: 'C1' })
})

test('mapper: dm and unaddressed channel messages carry honest addressing for the bridge', () => {
  const dm = mapper().message({ channel: 'D1', channel_type: 'im', user: 'U1', text: 'hello &amp; bye', ts: '1700000000.000001' })
  assert.equal(dm?.containerKind, 'dm')
  assert.equal(dm?.text, 'hello & bye', 'entities decoded')
  assert.equal(dm?.mentionedBot, undefined, 'dms are addressed without a mention token')

  const chatter = mapper().message({ channel: 'C1', channel_type: 'channel', user: 'U2', text: 'anyone around?', ts: '1700000000.000002' })
  assert.equal(chatter?.containerKind, 'channel')
  assert.equal(chatter?.mentionedBot, undefined, 'unaddressed chatter stays unaddressed')
})

test('mapper: threaded messages keep the thread id and the triggering ts', () => {
  const threaded = mapper().message({
    channel: 'C1', channel_type: 'channel', user: 'U1', text: '<@U_BOT> do it', ts: '1700000000.000300', thread_ts: '1700000000.000200',
  })
  assert.equal(threaded?.threadId, '1700000000.000200')
  assert.equal(threaded?.replyToMessageId, '1700000000.000300')
  assert.deepEqual(threaded?.destination, { type: 'slack', target: 'C1', threadId: '1700000000.000200' })
})

test('mapper: loop guard — own-bot messages, bot-authored payloads and edit subtypes are dropped', () => {
  const m = mapper()
  assert.equal(m.message({ channel: 'C1', channel_type: 'channel', user: 'U_BOT', text: 'echo', ts: '1' }), undefined)
  assert.equal(m.message({ channel: 'C1', channel_type: 'channel', bot_id: 'B_BOT', text: 'echo', ts: '2' }), undefined)
  assert.equal(m.message({ channel: 'C1', channel_type: 'channel', subtype: 'message_changed', message: {}, ts: '3' }), undefined)
  assert.equal(m.message({ channel: 'C1', channel_type: 'channel', subtype: 'message_deleted', deleted_ts: '4', ts: '5' }), undefined)
})

test('mapper: without an envelope event_id the composite id is stable per channel+ts', () => {
  const m = mapper()
  const fixture = { channel: 'C1', channel_type: 'im', user: 'U1', text: 'hi', ts: '1700000000.000010', client_msg_id: 'c1' }
  const first = m.message(fixture)
  const second = m.message(fixture)
  assert.equal(first?.eventId, second?.eventId)
  assert.match(first?.eventId ?? '', /^msg:C1:1700000000\.000010:c1$/)
})

test('mapper: block_actions replays to an interaction whose string value parses as an approval', () => {
  const value: ApprovalActionValue = {
    kind: APPROVAL_VALUE_KIND, runId: 'run-9', sessionId: 's-9', requestId: 's-9:deploy', command: 'deploy', decision: 'approve',
  }
  const event = mapper().blockActions({
    channel: { id: 'C1' },
    message: { ts: '1700000000.000100' },
    user: { id: 'U2', username: 'bob' },
    actions: [{ action_id: SLACK_APPROVAL_ACTION.approve, value: JSON.stringify(value), type: 'button', action_ts: '1700000001.000001' }],
  })
  assert.equal(event?.kind, 'interaction')
  assert.equal(event.ref.messageId, '1700000000.000100')
  assert.deepEqual(event.ref.destination, { type: 'slack', target: 'C1' })
  assert.equal(event.actor.providerUserId, 'U2')
  assert.deepEqual(parseApprovalValue(event.action.value), value)
})

test('mapper: reactions map with added/removed and self-reactions are dropped', () => {
  const m = mapper()
  const added = m.reaction({ channel: 'C1', ts: '1700000000.000100', event_ts: '1700000001', user: 'U2', reaction: '+1' }, 'added')
  assert.equal(added?.kind, 'reaction')
  assert.equal(added?.emoji, '+1')
  assert.equal(added?.action, 'added')
  assert.equal(m.reaction({ channel: 'C1', ts: '1', user: 'U_BOT', reaction: 'eyes' }, 'added'), undefined)
})

test('mapper: the bot joining a channel is a bot_added lifecycle, other joins are ignored', () => {
  const m = mapper()
  const joined = m.memberJoined({ channel: 'C1', user: 'U_BOT', event_ts: '1700000002' })
  assert.equal(joined?.kind, 'lifecycle')
  assert.equal(joined?.event, 'bot_added')
  assert.equal(joined?.spaceId, 'C1')
  assert.equal(m.memberJoined({ channel: 'C1', user: 'U2', event_ts: '1700000003' }), undefined)
})

type Handler = (payload: SlackHandlerPayload) => void | Promise<void>

function socketDouble() {
  const handlers = new Map<string, Handler[]>()
  const socket: SlackSocketLike = {
    on(name, handler) {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => {
        const current = handlers.get(name) ?? []
        handlers.set(name, current.filter((h) => h !== handler))
      }
    },
    connect: async () => {},
    disconnect: async () => {},
  }
  return {
    socket,
    async dispatch(name: string, payload: SlackHandlerPayload): Promise<void> {
      for (const handler of handlers.get(name) ?? []) await handler(payload)
    },
    has(name: string): boolean {
      return (handlers.get(name) ?? []).length > 0
    },
  }
}

function clientsDouble(options: { auth?: { user_id?: string; bot_id?: string } } = {}) {
  const calls = {
    postMessage: [] as Array<Record<string, unknown>>,
    update: [] as Array<Record<string, unknown>>,
    delete: [] as Array<Record<string, unknown>>,
    uploadV2: [] as Array<Record<string, unknown>>,
  }
  const clients: SlackClientsLike = {
    auth: { test: async () => options.auth ?? { user_id: 'U_BOT', bot_id: 'B_BOT' } },
    chat: {
      postMessage: async (args) => {
        calls.postMessage.push(args)
        return { ts: '1700000009.000001', channel: String(args.channel) }
      },
      update: async (args) => {
        calls.update.push(args)
        return { ts: String(args.ts), channel: String(args.channel) }
      },
      delete: async (args) => {
        calls.delete.push(args)
        return { ts: String(args.ts), channel: String(args.channel) }
      },
    },
    files: {
      uploadV2: async (args) => {
        calls.uploadV2.push(args)
        return {}
      },
    },
    users: {
      list: async (args) => ({
        members: [{ id: 'U1', is_bot: false, profile: { real_name: 'Alice', email: 'a@example.com' } }],
        response_metadata: { next_cursor: String(args?.cursor ?? '') === 'page2' ? '' : 'page2' },
      }),
    },
    conversations: {
      list: async (args) => ({
        channels: [
          { id: 'C1', name: 'general', is_private: false },
          { id: 'C2', name: 'secret', is_private: true },
          { id: 'D1', is_im: true },
          { id: 'G1', is_mpim: true },
        ],
        response_metadata: { next_cursor: String(args?.cursor ?? '') === 'page2' ? '' : 'page2' },
      }),
    },
  }
  return { clients, calls }
}

async function startedProvider(overrides: { clients?: SlackClientsLike; socket?: SlackSocketLike } = {}) {
  const emitted: InboundEvent[] = []
  const sock = overrides.socket ?? socketDouble().socket
  const clients = overrides.clients ?? clientsDouble().clients
  const provider = createSlackProvider(config, {
    socketFactory: () => sock,
    clientsFactory: () => clients,
  })
  await provider.start({
    name: 'slack:test',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    signal: new AbortController().signal,
    emit: async (events) => {
      emitted.push(...(Array.isArray(events) ? events : [events]))
    },
  })
  return { provider, emitted, sock, clients }
}

test('provider: start connects the socket and replays fixtures through the wire path', async () => {
  const wire = socketDouble()
  const { provider, emitted } = await startedProvider({ socket: wire.socket })
  const acked: number[] = []
  try {
    for (const name of ['app_mention', 'message', 'block_actions', 'reaction_added', 'reaction_removed', 'member_joined_channel']) {
      assert.ok(wire.has(name), `${name} handler registered`)
    }
    await wire.dispatch('app_mention', {
      ack: () => acked.push(1),
      body: { event_id: 'Ev_1' },
      event: { channel: 'C1', user: 'U1', text: '<@U_BOT> hi', ts: '1700000000.000001' },
    })
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0]?.kind, 'message')
    assert.equal(acked.length, 1, 'socket mode envelope acknowledged')
    await provider.stop()
    await wire.dispatch('message', {
      ack: () => acked.push(1),
      body: { channel: 'D1', channel_type: 'im', user: 'U1', text: 'after stop', ts: '1700000000.000002' },
    })
    assert.equal(emitted.length, 1, 'no intake after stop')
  } finally {
    await provider.stop()
  }
})

test('provider: markdown bodies convert to mrkdwn text; threads ride thread_ts', async () => {
  const double = clientsDouble()
  const { provider } = await startedProvider({ clients: double.clients })
  try {
    const destination = { type: 'slack', target: 'C1' } as const
    const receipts = await provider.outbound([
      { op: 'send', destination, body: { markdown: '**bold** move' } },
      { op: 'send', destination, body: { markdown: 'in thread' }, threadId: '1700000000.000100' },
      { op: 'send', destination, body: { text: 'reply' }, replyToMessageId: '1700000000.000200' },
    ])
    assert.equal(double.calls.postMessage.length, 3)
    assert.equal(double.calls.postMessage[0]?.text, '*bold* move')
    assert.equal(double.calls.postMessage[1]?.thread_ts, '1700000000.000100')
    assert.equal(double.calls.postMessage[2]?.thread_ts, '1700000000.000200')
    assert.equal(receipts[0]?.op, 'send')
    assert.equal(receipts[0]?.ref?.messageId, '1700000009.000001')
  } finally {
    await provider.stop()
  }
})

test('provider: card bodies ride blocks and edit/delete hit the right ts', async () => {
  const double = clientsDouble()
  const { provider } = await startedProvider({ clients: double.clients })
  try {
    const destination = { type: 'slack', target: 'C1' } as const
    const card = slackApprovalCard({
      runId: 'run-1', sessionId: 's-1', approvals: [{ requestId: 's-1:deploy', command: 'deploy', reason: 'needs sign-off' }],
    })
    const ref = { destination, messageId: '1700000000.000300' }
    const receipts = await provider.outbound([
      { op: 'send', destination, body: { card } },
      { op: 'edit', ref, body: { text: 'updated' } },
      { op: 'delete', ref },
    ])
    const blocks = double.calls.postMessage[0]?.blocks
    assert.ok(Array.isArray(blocks) && blocks.length === 2, 'card sent as block kit blocks')
    assert.equal(double.calls.update[0]?.ts, '1700000000.000300')
    assert.equal(double.calls.delete[0]?.ts, '1700000000.000300')
    assert.equal(receipts[2]?.op, 'delete')
  } finally {
    await provider.stop()
  }
})

test('provider: reserved operations report the unsupported sentinel', async () => {
  const { provider } = await startedProvider()
  try {
    const destination = { type: 'slack', target: 'C1' } as const
    const ref = { destination, messageId: '1700000000.000001' }
    await assert.rejects(
      provider.outbound([{ op: 'react', ref, emoji: '+1', action: 'add' }]),
      (error: { code?: string }) => error.code === IM_UNSUPPORTED_OP,
    )
    await assert.rejects(
      provider.outbound([{ op: 'uploadFile', destination, file: { name: 'x', mimetype: 'text/plain', blobId: 'b', sizeBytes: 1 }, content: new Uint8Array() }]),
      (error: { code?: string }) => error.code === IM_UNSUPPORTED_OP,
    )
  } finally {
    await provider.stop()
  }
})

test('provider: collectDirectory paginates people and spaces with full-roster replace', async () => {
  const double = clientsDouble()
  const { provider } = await startedProvider({ clients: double.clients })
  try {
    const push = await provider.collectDirectory!()
    assert.equal(push.provider, 'slack')
    assert.equal(push.instanceId, 'test')
    assert.deepEqual(push.replace, ['people', 'spaces'])
    assert.ok((push.spaces ?? []).length >= 4, 'channels from both pages collected')
    assert.ok((push.people ?? []).length >= 2, 'humans from both pages collected (bots skipped)')
    assert.equal(push.people?.[0]?.email, 'a@example.com')
  } finally {
    await provider.stop()
  }
})

test('provider: format converts canonical markdown to the mrkdwn body', () => {
  const provider = createSlackProvider(config, {})
  assert.deepEqual(provider.format('# Title'), { text: '*Title*' })
})

test('slack approval card round-trips decisions through JSON button values', () => {
  const card = slackApprovalCard({
    runId: 'run-1', sessionId: 'session-1', approvals: [{ requestId: 'session-1:deploy', command: 'deploy', reason: 'needs sign-off' }],
  })
  const blocks = card['blocks'] as Array<{ type: string; elements?: Array<Record<string, unknown>> }>
  const actions = blocks.find((block) => block.type === 'actions')?.elements ?? []
  assert.equal(actions.length, 2)
  const approve = JSON.parse(String(actions[0]?.value)) as ApprovalActionValue
  const reject = JSON.parse(String(actions[1]?.value)) as ApprovalActionValue
  assert.equal(approve.decision, 'approve')
  assert.equal(approve.requestId, 'session-1:deploy')
  assert.equal(approve.command, 'deploy')
  assert.deepEqual(parseApprovalValue(String(actions[1]?.value)), reject)
  const renderer = createSlackApprovalCardRenderer()
  assert.deepEqual(renderer.render({ runId: 'r', sessionId: 's', approvals: [] }), slackApprovalCard({ runId: 'r', sessionId: 's', approvals: [] }))
})
