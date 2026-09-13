/**
 * M4 20.1 automated acceptance: one core, two live provider adapters.
 * Real `createFeishuProvider` and `createSlackProvider` instances (mock
 * transports) register into a single IM registry behind one bridge; turns
 * from both channels run through the same orchestrator and replies route
 * back to the originating provider — with each provider's own approval
 * card renderer feeding its native card shape and clicks round-tripping.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@qm/cordis'
import { createTurnRunner } from '@qm/api'
import { createMemoryApprovalStore } from '@qm/approvals'
import { createImRegistry } from '@qm/im-core/runtime'
import type { ImRegistryHandle } from '@qm/im-core/runtime'
import type { FeishuChannelLike, FeishuProviderConfig } from '@qm/im-feishu'
import { createFeishuProvider } from '@qm/im-feishu'
import type { SlackClientsLike, SlackHandlerPayload, SlackProviderConfig, SlackSocketLike } from '@qm/im-slack'
import { createSlackProvider, SLACK_APPROVAL_ACTION } from '@qm/im-slack'
import { createHarnessRouter, createMockHarness, OrchestratorService, type MockTurnStep } from '@qm/orchestrator'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { IdentityService, ResolutionService } from '@qm/types'
import { APPROVAL_VALUE_KIND, createImTurnBridge, type ImTurnBridge } from '../src/index.ts'

function devResolution(): ResolutionService {
  return {
    resolve: async () => ({ systemPrompt: 'test', orgScopeId: 'org:test' }),
    scopeFor: () => 'org:test',
  }
}

function devIdentity(): IdentityService {
  return {
    isInternal: (p) => p.type === 'internal',
    audienceIsAllInternal: (audience) => audience.every((p) => p.type === 'internal'),
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return condition()
}

type AnyHandler = (payload: never) => void | Promise<void>

function feishuChannelDouble() {
  const calls = { send: [] as Array<Record<string, unknown>>, updateCard: [] as Array<Record<string, unknown>> }
  const handlers = new Map<string, AnyHandler>()
  const channel = {
    connect: async () => {},
    disconnect: async () => {},
    on: (nameOrHandlers: string | Record<string, AnyHandler>, handler?: AnyHandler) => {
      if (typeof nameOrHandlers === 'string') {
        if (handler) handlers.set(nameOrHandlers, handler)
      } else {
        for (const [name, fn] of Object.entries(nameOrHandlers)) {
          if (fn) handlers.set(name, fn)
        }
      }
      return () => handlers.clear()
    },
    send: async (to: string, input: Record<string, unknown>, opts?: Record<string, unknown>) => {
      calls.send.push({ to, input, ...(opts ?? {}) })
      return { messageId: `om_out_${calls.send.length}` }
    },
    editMessage: async () => {},
    updateCard: async (messageId: string, card: object) => {
      calls.updateCard.push({ messageId, card })
    },
    recallMessage: async () => {},
    downloadResource: async () => Buffer.from(''),
    getChatInfo: async () => ({}),
  } as unknown as FeishuChannelLike
  return {
    channel,
    calls,
    async emit(name: string, payload: unknown): Promise<void> {
      const handler = handlers.get(name)
      await handler?.(payload as never)
    },
  }
}

function feishuMessageFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: 'om_in_1',
    chatId: 'oc_chat1',
    chatType: 'group',
    senderId: 'ou_user1',
    senderName: 'Alice',
    content: 'feishu hello',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: 1_700_000_000_000,
    raw: { event_id: 'fe_evt_1' },
    ...overrides,
  }
}

function slackSocketDouble() {
  const handlers = new Map<string, Array<(payload: SlackHandlerPayload) => void | Promise<void>>>()
  const socket: SlackSocketLike = {
    on(name, handler) {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== handler))
    },
    connect: async () => {},
    disconnect: async () => {},
  }
  return {
    socket,
    async dispatch(name: string, payload: SlackHandlerPayload): Promise<void> {
      for (const handler of handlers.get(name) ?? []) await handler(payload)
    },
  }
}

function slackClientsDouble() {
  const calls = { postMessage: [] as Array<Record<string, unknown>>, update: [] as Array<Record<string, unknown>> }
  const clients: SlackClientsLike = {
    auth: { test: async () => ({ user_id: 'U_BOT', bot_id: 'B_BOT' }) },
    chat: {
      postMessage: async (args) => {
        calls.postMessage.push(args)
        return { ts: '1700000100.000001', channel: String(args.channel) }
      },
      update: async (args) => {
        calls.update.push(args)
        return { ts: String(args.ts) }
      },
      delete: async () => ({}),
    },
    users: { list: async () => ({ members: [] }) },
    conversations: { list: async () => ({ channels: [] }) },
  }
  return { clients, calls }
}

const feishuConfig: FeishuProviderConfig = {
  appId: 'cli_test',
  appSecret: '[redacted-credential]',
  instanceId: 'dual',
}

const slackConfig: SlackProviderConfig = { appToken: 'xapp-test', botToken: 'xoxb-test', instanceId: 'dual' }

interface DualHarness {
  runs: ReturnType<typeof createMemoryRunStore>
  bridge: ImTurnBridge
  feishu: ReturnType<typeof feishuChannelDouble>
  slack: { wire: ReturnType<typeof slackSocketDouble>; api: ReturnType<typeof slackClientsDouble> }
  dispose(): Promise<void>
}

async function dualSetup(script: MockTurnStep[] = []): Promise<DualHarness> {
  const sessions = createMemorySessionStore()
  const runs = createMemoryRunStore()
  const harnessRouter = createHarnessRouter({ defaultId: 'mock' })
  harnessRouter.register(createMockHarness(script.length ? { script } : {}))
  const orchestrator = new OrchestratorService(new Context(), {
    sessions,
    runs,
    harness: harnessRouter,
    identity: devIdentity(),
    resolution: devResolution(),
    rateLimiter: { check: async () => ({ allowed: true }) },
  })
  const runner = createTurnRunner({ orchestrator, runs })
  runner.start()

  const feishu = feishuChannelDouble()
  const slack = { wire: slackSocketDouble(), api: slackClientsDouble() }

  let bridge: ImTurnBridge | undefined
  const registry: ImRegistryHandle = createImRegistry({
    onEvent: (events) => (bridge ? bridge.sink(events) : Promise.resolve()),
  })
  bridge = createImTurnBridge(
    { runs, sessions, resolution: devResolution(), im: registry },
    { approvalStore: createMemoryApprovalStore() },
  )
  await bridge.start()
  const disposeFeishu = await registry.register(createFeishuProvider(feishuConfig, { channelFactory: () => feishu.channel }))
  const disposeSlack = await registry.register(createSlackProvider(slackConfig, {
    socketFactory: () => slack.wire.socket,
    clientsFactory: () => slack.api.clients,
  }))

  return {
    runs,
    bridge,
    feishu,
    slack,
    dispose: async () => {
      await runner.stop()
      await bridge.stop()
      await disposeFeishu()
      await disposeSlack()
    },
  }
}

test('20.1: replies from both channels route back through their own provider', async () => {
  const t = await dualSetup()
  try {
    await t.feishu.emit('message', feishuMessageFixture())
    assert.ok(await waitFor(() => t.feishu.calls.send.length === 1), 'feishu reply delivered')
    assert.equal((t.feishu.calls.send[0]?.input as { markdown?: string }).markdown, 'echo: feishu hello')
    assert.equal(t.slack.api.calls.postMessage.length, 0, 'feishu reply never leaks to slack')

    await t.slack.wire.dispatch('app_mention', {
      ack: () => {},
      body: { event_id: 'slk_1' },
      event: { channel: 'C1', user: 'U1', text: '<@U_BOT> slack hello', ts: '1700000000.000001' },
    })
    assert.ok(await waitFor(() => t.slack.api.calls.postMessage.length === 1), 'slack reply delivered')
    const posted = t.slack.api.calls.postMessage[0] ?? {}
    assert.equal(posted.text, 'echo: slack hello', 'reply converted through the mrkdwn pipeline')
    assert.equal(posted.channel, 'C1')
    assert.equal(posted.thread_ts, '1700000000.000001', 'reply threads onto the triggering message')
    assert.equal(t.feishu.calls.send.length, 1, 'slack reply never leaks to feishu')

    const all = await t.runs.list()
    assert.equal(all.length, 2, 'both channels submitted through the same core')
    assert.deepEqual(
      all.map((run) => run.request.surface).sort(),
      ['feishu', 'slack'],
    )
  } finally {
    await t.dispose()
  }
})

test('20.1: pending approvals render per provider and clicks round-trip on both', async () => {
  const pause: MockTurnStep = { reply: '', pausedOnApproval: true, pendingApprovals: [{ command: 'deploy', reason: 'needs sign-off' }] }
  const t = await dualSetup([pause, pause])
  try {
    await t.feishu.emit('message', feishuMessageFixture({ content: 'feishu deploy', raw: { event_id: 'fe_evt_2' } }))
    assert.ok(await waitFor(() => t.feishu.calls.updateCard.length === 1 || t.feishu.calls.send.length >= 1), 'feishu approval card out')
    const feishuCard = t.feishu.calls.send[0]?.input as { card?: { elements?: Array<{ tag?: string; actions?: Array<{ value?: Record<string, unknown> }> }> } }
    assert.ok(feishuCard?.card?.elements, 'feishu card carries lark elements')
    const feishuActions = feishuCard.card!.elements!.find((element) => element.tag === 'action')?.actions ?? []
    assert.equal(feishuActions.length, 2, 'lark card carries both buttons')
    const feishuApprove = feishuActions[0]?.value

    await t.slack.wire.dispatch('app_mention', {
      ack: () => {},
      body: { event_id: 'slk_2' },
      event: { channel: 'C1', user: 'U1', text: '<@U_BOT> slack deploy', ts: '1700000010.000001' },
    })
    assert.ok(await waitFor(() => t.slack.api.calls.postMessage.length >= 1), 'slack approval card out')
    const slackPosted = t.slack.api.calls.postMessage[0] ?? {}
    const blocks = slackPosted.blocks as Array<{ type?: string; elements?: Array<{ value?: string }> }> | undefined
    assert.ok(Array.isArray(blocks), 'slack card carries block kit blocks')
    const slackActions = blocks?.find((block) => block.type === 'actions')?.elements ?? []
    assert.equal(slackActions.length, 2, 'block kit card carries both buttons')
    const slackApprove = JSON.parse(String(slackActions[0]?.value)) as Record<string, unknown>
    assert.equal(slackApprove.kind, APPROVAL_VALUE_KIND, 'slack button value is the JSON-encoded approval value')

    const all = await t.runs.list()
    assert.equal(all.length, 2)
    const feishuRequestId = (all.find((run) => run.request.surface === 'feishu')?.result?.pendingApprovals ?? [])[0]?.requestId
    const slackRequestId = (all.find((run) => run.request.surface === 'slack')?.result?.pendingApprovals ?? [])[0]?.requestId
    assert.ok(feishuRequestId && slackRequestId)
    assert.equal(feishuApprove?.requestId, feishuRequestId, 'lark button value carries the requestId')
    assert.equal(slackApprove.requestId, slackRequestId, 'block kit button value carries the requestId')

    await t.feishu.emit('cardAction', {
      messageId: 'om_card_1',
      chatId: 'oc_chat1',
      operator: { openId: 'ou_user1' },
      action: { value: feishuApprove, tag: 'button' },
      raw: { event_id: 'fe_evt_click' },
    })
    assert.ok(await waitFor(async () => (await t.runs.list()).filter((run) => run.request.approval).length === 1), 'feishu click resumed its turn')

    await t.slack.wire.dispatch('block_actions', {
      ack: () => {},
      body: {
        channel: { id: 'C1' },
        message: { ts: '1700000100.000001' },
        user: { id: 'U1' },
        actions: [{ action_id: SLACK_APPROVAL_ACTION.approve, value: String(slackActions[0]?.value), type: 'button', action_ts: '1700000011.000001' }],
      },
    })
    assert.ok(await waitFor(async () => (await t.runs.list()).filter((run) => run.request.approval).length === 2), 'both clicks submitted approval turns')

    const approvals = (await t.runs.list()).filter((run) => run.request.approval)
    assert.deepEqual(
      approvals.map((run) => run.request.approval?.approved).sort(),
      [true, true],
    )
    assert.deepEqual(
      approvals.map((run) => run.request.surface).sort(),
      ['feishu', 'slack'],
      'each click rode its own provider',
    )
  } finally {
    await t.dispose()
  }
})
