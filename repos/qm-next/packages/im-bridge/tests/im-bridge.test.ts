/**
 * ImTurnBridge: inbound message → run submission → terminal → delivery,
 * approval-card interaction round-trip, eventId dedup, guest refusal
 * notices, and route isolation for non-IM runs.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@qm/cordis'
import { createTurnRunner } from '@qm/api'
import {
  AGENT_REQUEST_VALUE_KIND,
  createMemoryAgentRequestStore,
  createMemoryAmbientCursorStore,
  createMemoryAmbientJudgmentStore,
  createMemoryApprovalStore,
  createMemoryChannelPolicyStore,
  createMemoryTargetApprovalStore,
  encodeAgentRequestValue,
  type AmbientCursorStore,
  type AmbientJudge,
  type AmbientJudgmentStore,
  type AgentRequestStore,
} from '@qm/approvals'
import { createInMemoryEventLog, createMemorySequenceAllocator, createMemorySessionReservationStore } from '@qm/concurrency'
import type { ImCapabilities, ImProvider, ImProviderStartContext, InboundInteractionEvent, InboundMessageEvent, OutboundOperation, SendOperation } from '@qm/im-core'
import { createImRegistry } from '@qm/im-core/runtime'
import { createHarnessRouter, createMockHarness, OrchestratorService, type MockTurnStep } from '@qm/orchestrator'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { IdentityService, KeychainAsk, ResolutionService } from '@qm/types'
import { APPROVAL_VALUE_KIND, approvalRequestNotice, createImTurnBridge, DEFAULT_ACK_REACTIONS, imRunResultDelivery, parseApprovalValue, type ApprovalActionValue, type ApprovalCardRenderer, type ImReplyRoute, type ImTurnBridge, type ImTurnBridgeAck, type ImTurnBridgeAgentRequests, type ImTurnBridgeAmbient, type ImTurnBridgeAskResolutions } from '../src/index.ts'
import type { Run } from '@qm/types'

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

interface RecorderCells {
  ctx?: ImProviderStartContext
}

/**
 * Provider-owned card rendering, test double: same structured button
 * values the real feishu renderer produces.
 */
const testCardRenderer: ApprovalCardRenderer = {
  render: ({ runId, sessionId, approvals }) => ({
    elements: [
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            value: {
              kind: APPROVAL_VALUE_KIND,
              runId,
              sessionId,
              requestId: approvals[0]?.requestId ?? '',
              command: approvals[0]?.command ?? '',
              decision: 'approve',
            },
          },
          {
            tag: 'button',
            value: {
              kind: APPROVAL_VALUE_KIND,
              runId,
              sessionId,
              requestId: approvals[0]?.requestId ?? '',
              command: approvals[0]?.command ?? '',
              decision: 'reject',
            },
          },
        ],
      },
    ],
  }),
}

function recorderProvider(
  sent: OutboundOperation[],
  cells: RecorderCells,
  withCardRenderer = true,
  reactSupport = false,
): ImProvider {
  return {
    provider: 'feishu',
    instanceId: 'test',
    capabilities: reactSupport
      ? () => ({ ...capabilities(), react: true })
      : capabilities,
    ...(withCardRenderer ? { approvalCardRenderer: testCardRenderer } : {}),
    start: async (ctx) => {
      cells.ctx = ctx
    },
    stop: async () => {},
    outbound: async (ops) => {
      sent.push(...ops)
      return ops.map((op) =>
        op.op === 'send'
          ? { op: 'send', ref: { destination: op.destination, messageId: `msg-${sent.length}` } }
          : { op: op.op },
      )
    },
    format: (markdown) => ({ markdown }),
    destination: (chatId, threadId) =>
      threadId ? { type: 'feishu', target: chatId, threadId } : { type: 'feishu', target: chatId },
  }
}

function messageEvent(overrides: Partial<InboundMessageEvent> = {}): InboundMessageEvent {
  return {
    kind: 'message',
    provider: 'feishu',
    instanceId: 'test',
    eventId: 'e1',
    occurredAt: 1,
    receivedAt: 2,
    destination: { type: 'feishu', target: 'oc_chat1' },
    actor: { providerUserId: 'u1', displayName: 'User One' },
    text: 'hello bot',
    threadId: 'om_thread1',
    ...overrides,
  }
}

function interactionEvent(
  value: ApprovalActionValue,
  eventId = 'e2',
  actor: InboundInteractionEvent['actor'] = { providerUserId: 'u1', displayName: 'User One' },
): InboundInteractionEvent {
  return {
    kind: 'interaction',
    provider: 'feishu',
    instanceId: 'test',
    eventId,
    occurredAt: 3,
    receivedAt: 4,
    ref: { destination: { type: 'feishu', target: 'oc_chat1', threadId: 'om_thread1' }, messageId: 'om_card1' },
    actor,
    action: { value },
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

interface Harness {
  runs: ReturnType<typeof createMemoryRunStore>
  /** ADR-0010 continuation executor — the target ApprovalStore. */
  approvalsTarget: ReturnType<typeof createMemoryTargetApprovalStore>
  bridge: ImTurnBridge
  cells: RecorderCells
  sent: OutboundOperation[]
  dispose(): Promise<void>
}

async function setup(
  opts: {
    script?: MockTurnStep[]
    actorType?: 'internal' | 'guest'
    /** Ambient ingredients: containers preloaded into a memory policy. */
    ambient?: {
      containers: string[]
      judge: AmbientJudge
      cursors?: AmbientCursorStore
      judgments?: AmbientJudgmentStore
      self?: { name?: string; mentionId?: string }
      judgeModel?: string
    }
    /** When false the provider ships no card renderer (fallback-path tests). */
    providerCardRenderer?: boolean
    /** Provider advertises the react capability (ack-reaction tests). */
    react?: boolean
    /** Reaction-as-ack options; absent means no acks. */
    ack?: ImTurnBridgeAck
    /** Wall-clock delay injected into every mock turn (ack-timing tests). */
    turnDelayMs?: number
    /** Agent-request ingredients (tests inject the store + DM resolver). */
    agentRequests?: ImTurnBridgeAgentRequests
    /** Keychain-ask sweep ingredients (tests inject the stub keychain). */
    askResolutions?: ImTurnBridgeAskResolutions
  } = {},
): Promise<Harness> {
  const sessions = createMemorySessionStore()
  const runs = createMemoryRunStore()
  const log = createInMemoryEventLog({ allocator: createMemorySequenceAllocator() })
  const approvalsTarget = createMemoryTargetApprovalStore()
  const reservations = createMemorySessionReservationStore()
  const harnessRouter = createHarnessRouter({ defaultId: 'mock' })
  harnessRouter.register(
    createMockHarness({
      ...(opts.script ? { script: opts.script } : {}),
      ...(opts.turnDelayMs !== undefined ? { turnDelayMs: opts.turnDelayMs } : {}),
    }),
  )
  const orchestrator = new OrchestratorService(new Context(), {
    sessions,
    runs,
    harness: harnessRouter,
    identity: devIdentity(),
    resolution: devResolution(),
    rateLimiter: { check: async () => ({ allowed: true }) },
    runEventLog: log.bus,
  })
  // ADR-0010 continuation executor — the runner suspends pending
  // approvals and the continuation lane resumes them; clicks route
  // through the target glue (no successor Run).
  const runner = createTurnRunner({
    orchestrator,
    runs,
    runEventLog: log.bus,
    approvals: approvalsTarget,
    reservations,
  })
  runner.start()
  const sent: OutboundOperation[] = []
  const cells: RecorderCells = {}
  let bridge: ImTurnBridge | undefined
  const registry = createImRegistry({ onEvent: (events) => (bridge ? bridge.sink(events) : Promise.resolve()) })
  const approvalStore = createMemoryApprovalStore()
  let ambient: ImTurnBridgeAmbient | undefined
  if (opts.ambient) {
    const policy = createMemoryChannelPolicyStore()
    for (const container of opts.ambient.containers) await policy.setAmbient(container, true)
    ambient = {
      policy,
      judge: opts.ambient.judge,
      ...(opts.ambient.cursors ? { cursors: opts.ambient.cursors } : {}),
      ...(opts.ambient.judgments ? { judgments: opts.ambient.judgments } : {}),
      ...(opts.ambient.self ? { self: opts.ambient.self } : {}),
      ...(opts.ambient.judgeModel ? { judgeModel: opts.ambient.judgeModel } : {}),
    }
  }
  bridge = createImTurnBridge(
    { runs, sessions, resolution: devResolution(), im: registry },
    {
      ...(opts.actorType ? { actorType: opts.actorType } : {}),
      approvalStore,
      approvalContinuation: { approvals: approvalsTarget, runs, runEventLog: log.bus, reservations },
      ...(ambient ? { ambient } : {}),
      ...(opts.ack ? { ack: opts.ack } : {}),
      ...(opts.agentRequests ? { agentRequests: opts.agentRequests } : {}),
      ...(opts.askResolutions ? { askResolutions: opts.askResolutions } : {}),
    },
  )
  await bridge.start()
  const disposer = await registry.register(recorderProvider(sent, cells, opts.providerCardRenderer !== false, opts.react === true))
  return {
    runs,
    approvalsTarget,
    bridge,
    cells,
    sent,
    dispose: async () => {
      await runner.stop()
      await bridge.stop()
      await disposer()
    },
  }
}

test('inbound message submits a run and the terminal reply is delivered in-thread', async () => {
  const t = await setup()
  try {
    await t.cells.ctx!.emit(messageEvent())
    assert.ok(await waitFor(() => t.sent.length === 1), 'expected one delivery')
    const op = t.sent[0] as SendOperation
    assert.equal(op.op, 'send')
    assert.deepEqual(op.destination, { type: 'feishu', target: 'oc_chat1' })
    assert.deepEqual(op.body, { markdown: 'echo: hello bot' })
    assert.equal(op.threadId, 'om_thread1')
    const all = await t.runs.list()
    assert.equal(all.length, 1)
    const run = all[0]
    assert.ok(run)
    assert.equal(run.targetState, 'succeeded')
    assert.equal(run.request.surface, 'feishu')
    assert.equal(run.request.actor.id, 'feishu:u1')
    assert.equal(run.request.conversation.threadRef, 'feishu:oc_chat1:om_thread1')
  } finally {
    await t.dispose()
  }
})

test('ambient: unaddressed channel chatter in an enabled container goes to the judge, not a human turn', async () => {
  const judged: string[] = []
  const judge: AmbientJudge = {
    consider: async (candidate) => {
      judged.push(candidate.text)
      return { engage: true }
    },
  }
  const t = await setup({ ambient: { containers: ['feishu:oc_chat1'], judge } })
  try {
    await t.cells.ctx!.emit(messageEvent({ eventId: 'amb-1', mentionedBot: false, containerKind: 'channel' }))
    assert.ok(await waitFor(() => t.sent.length === 1), 'expected the ambient reply delivery')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(judged, ['hello bot'], 'the judge saw exactly the overheard text')
    const all = await t.runs.list()
    assert.equal(all.length, 1, 'no human turn — the only run is the ambient turn')
    const run = all[0]
    assert.ok(run)
    assert.deepEqual(run.request.origin, { kind: 'ambient' })
    assert.equal(run.request.conversation.threadRef, 'feishu:oc_chat1:om_thread1')
    const op = t.sent[0] as SendOperation
    assert.deepEqual(op.body, { markdown: 'echo: hello bot' }, 'the ambient reply delivers like any reply')
    assert.equal(op.threadId, 'om_thread1', 'ambient replies stay in the overheard thread')
  } finally {
    await t.dispose()
  }
})

test('ambient observability: judgments and cursors ride the bridge options', async () => {
  const judgments = createMemoryAmbientJudgmentStore()
  const cursors = createMemoryAmbientCursorStore()
  const t = await setup({
    ambient: {
      containers: ['feishu:oc_chat1'],
      judge: { consider: async () => ({ engage: true, reason: 'test verdict' }) },
      judgments,
      cursors,
      judgeModel: 'test-mini',
    },
  })
  try {
    await t.cells.ctx!.emit(messageEvent({ eventId: 'amb-obs-1', mentionedBot: false, containerKind: 'channel' }))
    assert.ok(await waitFor(() => t.sent.length === 1), 'expected the ambient reply delivery')
    const listed = await judgments.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.decision, 'act')
    assert.equal(listed[0]!.reason, 'test verdict')
    assert.equal(listed[0]!.model, 'test-mini')
    assert.equal(listed[0]!.container, 'feishu:oc_chat1')
    const cursor = await cursors.get('feishu:feishu:oc_chat1')
    assert.ok(cursor, 'the judged message advanced the container cursor')
    assert.ok(cursor!.lastJudgedTs.length > 0)
    assert.ok((cursor!.lastJudgedAt ?? 0) > 0)
  } finally {
    await t.dispose()
  }
})

test('ambient: mentioned and dm messages keep the human path even in an enabled container', async () => {
  const judge: AmbientJudge = {
    consider: async () => {
      throw new Error('judge must not be consulted for addressed messages')
    },
  }
  const t = await setup({ ambient: { containers: ['feishu:oc_chat1'], judge } })
  try {
    await t.cells.ctx!.emit(messageEvent({ eventId: 'm-1', mentionedBot: true, containerKind: 'channel' }))
    assert.ok(await waitFor(() => t.sent.length === 1), 'expected the mention echo')
    await t.cells.ctx!.emit(messageEvent({ eventId: 'm-2', mentionedBot: false, containerKind: 'dm' }))
    assert.ok(await waitFor(() => t.sent.length === 2), 'expected the dm echo')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal((await t.runs.list()).length, 2, 'two human turns, zero ambient turns')
  } finally {
    await t.dispose()
  }
})

test('ambient: unaddressed chatter outside enabled containers is dropped, not echoed', async () => {
  const judge: AmbientJudge = {
    consider: async () => {
      throw new Error('judge must not be consulted outside enabled containers')
    },
  }
  const t = await setup({ ambient: { containers: ['feishu:oc_other'], judge } })
  try {
    await t.cells.ctx!.emit(messageEvent({ eventId: 'm-3', mentionedBot: false, containerKind: 'channel' }))
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(t.sent.length, 0, 'no delivery — unaddressed chatter without policy is dropped')
    assert.equal((await t.runs.list()).length, 0, 'no run — unaddressed chatter without policy is dropped')
  } finally {
    await t.dispose()
  }
})

test('mentions and DMs submit human turns even without ambient ingredients', async () => {
  const t = await setup()
  try {
    await t.cells.ctx!.emit(messageEvent({ eventId: 'm-4', mentionedBot: true, containerKind: 'channel' }))
    assert.ok(await waitFor(() => t.sent.length === 1), 'mention echo delivered')
    await t.cells.ctx!.emit(messageEvent({ eventId: 'm-5', mentionedBot: false, containerKind: 'dm' }))
    assert.ok(await waitFor(() => t.sent.length === 2), 'dm echo delivered')
    await t.cells.ctx!.emit(messageEvent({ eventId: 'm-6', mentionedBot: false, containerKind: 'channel' }))
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal((await t.runs.list()).length, 2, 'unaddressed group chatter submits nothing without ambient')
  } finally {
    await t.dispose()
  }
})

test('a failed run delivers the failure notice', async () => {
  const t = await setup({ script: [new Error('boom')] })
  try {
    await t.cells.ctx!.emit(messageEvent())
    assert.ok(await waitFor(() => t.sent.length === 1), 'expected failure delivery')
    const op = t.sent[0] as SendOperation
    assert.deepEqual(op.body, { text: "⚠️ I couldn't finish that turn: boom" })
    const failedRun = (await t.runs.list())[0]
    assert.ok(failedRun)
    assert.equal(failedRun.result?.status, 'failed')
  } finally {
    await t.dispose()
  }
})

test('pending approval records durably; approve resumes the same Run and a duplicate click is deduped', async () => {
  const t = await setup({
    script: [{ reply: '', pausedOnApproval: true, pendingApprovals: [{ command: 'deploy', reason: 'needs sign-off' }] }],
  })
  try {
    await t.cells.ctx!.emit(messageEvent())
    assert.ok(await waitFor(() => t.sent.length === 1), 'expected approval card delivery at suspension')
    const cardOp = t.sent[0] as SendOperation
    assert.equal(cardOp.op, 'send')
    assert.ok(cardOp.body.card)
    const elements = (cardOp.body.card as { elements: Array<{ tag: string; actions?: Array<{ value: ApprovalActionValue }> }> })['elements']
    const actions = elements.find((element) => element.tag === 'action')?.actions
    assert.equal(actions?.length, 2, 'card carries approve and reject buttons')
    const [approveAction, rejectAction] = actions ?? []
    assert.ok(approveAction && rejectAction)
    const approveValue = approveAction.value
    const rejectValue = rejectAction.value
    assert.equal(approveValue.kind, APPROVAL_VALUE_KIND)
    assert.equal(approveValue.decision, 'approve')
    assert.equal(approveValue.command, 'deploy')

    const firstRun = (await t.runs.list())[0]
    assert.ok(firstRun)
    assert.equal(firstRun.result?.status, 'pending_approval')
    assert.equal(approveValue.requestId, firstRun.result?.pendingApprovals?.[0]?.requestId)

    // ADR-0010 — the request is durable in the target registry, tied to
    // the SAME Run and the original requester.
    const recorded = await t.approvalsTarget.get(approveValue.requestId)
    assert.ok(recorded, 'pending approval was recorded before the card went out')
    assert.equal(recorded.status, 'pending')
    assert.equal(recorded.requesterPrincipalId, 'feishu:u1')
    assert.equal(recorded.runId, firstRun.id)

    await t.cells.ctx!.emit(interactionEvent(approveValue))
    assert.ok(await waitFor(() => t.sent.length === 2), 'expected approve notice delivery')

    // The SAME Run resumed and completed; the terminal reply delivers.
    assert.ok(
      await waitFor(async () => (await t.runs.get(firstRun.id))?.targetState === 'succeeded'),
      'the same Run resumed to success',
    )
    assert.ok(await waitFor(() => t.sent.length === 3), 'approve notice + terminal reply')
    const approveReply = t.sent[2] as SendOperation | undefined
    assert.equal(approveReply?.body.markdown, 'echo: hello bot')

    await t.cells.ctx!.emit(interactionEvent(rejectValue, 'e3'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal((await t.runs.list()).length, 1, 'duplicate click on a decided approval submits nothing — and no successor Run ever exists')
    assert.equal(t.sent.length, 3, 'duplicate click delivers nothing')

    const decided = await t.approvalsTarget.get(approveValue.requestId)
    assert.ok(decided)
    assert.equal(decided.status, 'approved')
  } finally {
    await t.dispose()
  }
})

test('a click by anyone but the requester is refused with a notice and the approval stays pending', async () => {
  const t = await setup({
    script: [{ reply: '', pausedOnApproval: true, pendingApprovals: [{ command: 'deploy', reason: 'needs sign-off' }] }],
  })
  try {
    await t.cells.ctx!.emit(messageEvent())
    assert.ok(await waitFor(() => t.sent.length === 1), 'expected approval card delivery')
    const cardOp = t.sent[0] as SendOperation
    const elements = (cardOp.body.card as { elements: Array<{ tag: string; actions?: Array<{ value: ApprovalActionValue }> }> })['elements']
    const approveValue = elements.find((element) => element.tag === 'action')?.actions?.[0]?.value
    assert.ok(approveValue)

    await t.cells.ctx!.emit(interactionEvent(approveValue, 'e-click-2', { providerUserId: 'u2', displayName: 'User Two' }))
    assert.ok(await waitFor(() => t.sent.length === 2), 'expected refusal notice delivery')
    const notice = t.sent[1] as SendOperation
    assert.match((notice.body as { text: string })['text'], /Only the person who requested/)
    assert.equal((await t.runs.list()).length, 1, 'non-requester click submits no turn')

    const stillPending = await t.approvalsTarget.get(approveValue.requestId)
    assert.ok(stillPending)
    assert.equal(stillPending.status, 'pending')

    await t.cells.ctx!.emit(interactionEvent(approveValue, 'e-click-3'))
    assert.ok(
      await waitFor(async () => (await t.runs.get((await t.runs.list())[0]!.id))?.targetState === 'succeeded'),
      'requester can still decide afterwards — the same Run resumes',
    )
    const decided = await t.approvalsTarget.get(approveValue.requestId)
    assert.ok(decided)
    assert.equal(decided.status, 'approved')
  } finally {
    await t.dispose()
  }
})

test('a click on an unknown approval is answered with an expired notice', async () => {
  const t = await setup()
  try {
    await t.cells.ctx!.emit(
      interactionEvent(
        {
          kind: APPROVAL_VALUE_KIND,
          runId: 'run-missing',
          sessionId: 'sess-missing',
          requestId: 'req-missing',
          command: 'deploy',
          decision: 'approve',
        },
        'e-unknown',
      ),
    )
    assert.ok(await waitFor(() => t.sent.length === 1), 'expected expired notice delivery')
    const notice = t.sent[0] as SendOperation
    assert.match((notice.body as { text: string })['text'], /could not be found/)
    assert.equal((await t.runs.list()).length, 0)
  } finally {
    await t.dispose()
  }
})

test('registry passes repeat deliveries through; dedup is the durable intake accept (KV-007 removed)', async () => {
  // This harness wires the registry directly to `bridge.sink` (the
  // production path routes through the durable Intake Inbox instead).
  // The registry must NOT drop repeat deliveries itself — duplicate
  // recognition lives in the durable accept (provider + eventId,
  // ADR-0008), covered by im-intake-wiring.test.ts (redelivery creates
  // no second Turn; restart maps redelivery to the same Turn).
  const t = await setup()
  try {
    const event = messageEvent()
    await t.cells.ctx!.emit(event)
    await t.cells.ctx!.emit(event)
    assert.ok(await waitFor(async () => (await t.runs.list()).length === 2), 'repeat deliveries reach the sink unfiltered')
  } finally {
    await t.dispose()
  }
})

test('guest actors are refused and the refusal is delivered', async () => {
  const t = await setup({ actorType: 'guest' })
  try {
    await t.cells.ctx!.emit(messageEvent())
    assert.ok(await waitFor(() => t.sent.length === 1), 'expected refusal delivery')
    const op = t.sent[0] as SendOperation
    assert.match((op.body as { text: string })['text'], /internal-only/)
  } finally {
    await t.dispose()
  }
})

test('non-IM runs terminate without deliveries', async () => {
  const t = await setup()
  try {
    await t.runs.enqueue({
      sessionId: 'session-1',
      request: {
        surface: 'api',
        actor: { id: 'user-1', type: 'internal' },
        conversation: { kind: 'dm', threadRef: 'thread-1', audience: [] },
        origin: { kind: 'direct' },
        text: 'api hi',
      },
    })
    assert.ok(await waitFor(async () => (await t.runs.list()).every((run) => run.targetState === 'succeeded')))
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(t.sent.length, 0)
  } finally {
    await t.dispose()
  }
})

test('approval value parsing accepts only well-formed qm approval values', () => {  assert.equal(parseApprovalValue(null), null)
  assert.equal(parseApprovalValue('approve'), null)
  assert.equal(parseApprovalValue({ kind: 'other', runId: 'r1', requestId: 'q', command: 'c', decision: 'approve' }), null)
  assert.equal(parseApprovalValue({ kind: APPROVAL_VALUE_KIND, requestId: 'q', command: 'c', decision: 'approve' }), null)
  assert.equal(
    parseApprovalValue({ kind: APPROVAL_VALUE_KIND, runId: 'r1', requestId: 'q', command: 'c', decision: 'maybe' }),
    null,
  )
  const value = { kind: APPROVAL_VALUE_KIND, runId: 'r1', sessionId: 's1', requestId: 'q', command: 'c', decision: 'reject' }
  assert.deepEqual(parseApprovalValue(value), value)
})

test('approvalRequestNotice keeps the request context in plain neutral text', () => {
  const notice = approvalRequestNotice([{ requestId: 'session-1:deploy', command: 'deploy', reason: 'needs sign-off' }])
  assert.match(notice, /`deploy`/)
  assert.match(notice, /needs sign-off/)
  const multi = approvalRequestNotice([
    { requestId: 'a', command: 'deploy', reason: 'needs sign-off' },
    { requestId: 'b', command: 'migrate', reason: 'needs sign-off' },
  ])
  assert.match(multi, /\+1 more/)
})

test('pending approval without any card renderer delivers the neutral text notice', async () => {
  const t = await setup({
    providerCardRenderer: false,
    script: [{ reply: '', pausedOnApproval: true, pendingApprovals: [{ command: 'deploy', reason: 'needs sign-off' }] }],
  })
  try {
    await t.cells.ctx!.emit(messageEvent())
    assert.ok(await waitFor(() => t.sent.length === 1), 'expected fallback notice delivery')
    const op = t.sent[0] as SendOperation
    assert.equal(op.body.card, undefined, 'no provider-native card without a renderer')
    assert.match(op.body.text ?? '', /Approval needed before I can run `deploy`/)
  } finally {
    await t.dispose()
  }
})

test('ack reaction: reacts while the run is in flight, removed when the reply delivers', async () => {
  const picks: Array<{ outcome: string; icon: string | undefined; picked: string | undefined; ts: string }> = []
  const t = await setup({
    react: true,
    turnDelayMs: 150,
    ack: {
      delayMs: 20,
      pick: async () => 'eyes',
      onPick: (rec) => picks.push({ outcome: rec.outcome, icon: rec.icon, picked: rec.picked, ts: rec.ts }),
    },
  })
  try {
    await t.cells.ctx!.emit(messageEvent({ eventId: 'ack-1', replyToMessageId: 'om_trigger' }))
    assert.ok(await waitFor(() => t.sent.length >= 3), 'expected remove + send after the ack')
    await new Promise((resolve) => setTimeout(resolve, 50))
    const add = t.sent.find((op) => op.op === 'react' && op.action === 'add') as Extract<OutboundOperation, { op: 'react' }> | undefined
    const remove = t.sent.find((op) => op.op === 'react' && op.action === 'remove') as Extract<OutboundOperation, { op: 'react' }> | undefined
    assert.ok(add, 'the ack reaction was applied')
    assert.equal(add.emoji, 'eyes')
    assert.equal(add.ref.messageId, 'om_trigger', 'the reaction lands on the trigger message')
    assert.ok(remove, 'the ack reaction was removed on delivery')
    assert.equal(remove.emoji, 'eyes')
    const sendIndex = t.sent.findIndex((op) => op.op === 'send')
    const removeIndex = t.sent.findIndex((op) => op.op === 'react' && op.action === 'remove')
    assert.ok(removeIndex !== -1 && removeIndex < sendIndex, 'removal precedes the reply delivery')
    assert.equal(picks.length, 1)
    assert.equal(picks[0]!.outcome, 'picked')
    assert.equal(picks[0]!.icon, 'eyes')
    assert.equal(picks[0]!.ts, 'om_trigger')
  } finally {
    await t.dispose()
  }
})

test('ack reaction: skipped when the run finished before the delay fires', async () => {
  const t = await setup({
    react: true,
    ack: { delayMs: 30, candidates: ['eyes'] },
  })
  try {
    await t.cells.ctx!.emit(messageEvent({ eventId: 'ack-2', replyToMessageId: 'om_trigger' }))
    assert.ok(await waitFor(() => t.sent.length === 1), 'expected only the reply delivery')
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(t.sent.filter((op) => op.op === 'react').length, 0, 'no reaction once the run is terminal')
  } finally {
    await t.dispose()
  }
})

test('ack reaction: declined picker falls back to a random candidate and records declined', async () => {
  const picks: Array<{ outcome: string; icon: string | undefined }> = []
  const t = await setup({
    react: true,
    turnDelayMs: 120,
    ack: {
      delayMs: 20,
      candidates: ['eyes'],
      pick: async () => undefined,
      onPick: (rec) => picks.push({ outcome: rec.outcome, icon: rec.icon }),
    },
  })
  try {
    await t.cells.ctx!.emit(messageEvent({ eventId: 'ack-3', replyToMessageId: 'om_trigger' }))
    assert.ok(await waitFor(() => t.sent.length >= 3))
    assert.equal(picks[0]!.outcome, 'declined')
    assert.equal(picks[0]!.icon, 'eyes', 'the random fallback came from the candidate list')
  } finally {
    await t.dispose()
  }
})

test('ack reaction: inert when the provider lacks the react capability', async () => {
  const t = await setup({
    ack: { delayMs: 10 },
  })
  try {
    await t.cells.ctx!.emit(messageEvent({ eventId: 'ack-4', replyToMessageId: 'om_trigger' }))
    assert.ok(await waitFor(() => t.sent.length === 1))
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(t.sent.filter((op) => op.op === 'react').length, 0, 'no reaction without provider support')
  } finally {
    await t.dispose()
  }
})

test('DEFAULT_ACK_REACTIONS mirrors the qm candidate list', () => {
  assert.deepEqual(DEFAULT_ACK_REACTIONS, ['eyes', 'mag', 'hourglass_flowing_sand', 'telescope', 'saluting_face'])
})

function agentRequestRig(store: AgentRequestStore): ImTurnBridgeAgentRequests {
  return {
    store,
    resolveDm: async (provider, targetUserId) =>
      targetUserId === 'ou_unknown' ? null : { destination: { type: provider, target: `oc_dm_${targetUserId}` } },
    originLabel: 'The deploy channel agent',
    targetLabel: (targetUserId) => `your personal agent (${targetUserId})`,
  }
}

test('agent request: reply directive DMs the target, approval runs a personal turn back into the thread', async () => {
  const t = await setup({
    script: [{ reply: 'Deploy info below.\n[[ask-agent: <@ou_target> | check my private deploy notes]]' }, { reply: 'deploy notes say Friday' }],
    agentRequests: agentRequestRig(createMemoryAgentRequestStore()),
  })
  try {
    await t.cells.ctx!.emit(messageEvent({ eventId: 'ar-1', replyToMessageId: 'om_origin' }))
    assert.ok(await waitFor(() => t.sent.length >= 2), 'expected the cleaned reply plus the DM')
    const dm = t.sent.find((op) => (op as SendOperation).destination.target === 'oc_dm_ou_target') as SendOperation
    assert.ok(dm, 'the DM went to the resolved target destination')
    assert.ok(dm.body.text?.includes('asks your personal agent (ou_target)'), 'no renderer method on the test card — neutral text fallback')
    assert.ok(dm.body.text?.includes('check my private deploy notes'))
    const reply = t.sent.find((op) => (op as SendOperation).destination.target === 'oc_chat1') as SendOperation
    assert.equal(reply.body.markdown, 'Deploy info below.\n', 'the directive is stripped from the visible reply')

    const runs = await t.runs.list()
    assert.equal(runs.length, 1)
    const requestId = `${runs[0]!.id}:ar0`
    await t.cells.ctx!.emit({
      kind: 'interaction',
      provider: 'feishu',
      instanceId: 'test',
      eventId: 'ar-click-1',
      occurredAt: 3,
      receivedAt: 4,
      ref: { destination: { type: 'feishu', target: 'oc_dm_ou_target' }, messageId: 'om_dm1' },
      actor: { providerUserId: 'ou_target', displayName: 'Target' },
      action: { value: encodeAgentRequestValue({ kind: AGENT_REQUEST_VALUE_KIND, requestId, decision: 'approve' }) },
    } as InboundInteractionEvent)
    assert.ok(await waitFor(() => t.sent.length >= 3), 'expected the personal result delivery')
    await new Promise((resolve) => setTimeout(resolve, 50))
    const allRuns = await t.runs.list()
    assert.equal(allRuns.length, 2)
    const personal = allRuns.find((r) => r.request.actor.id === 'feishu:ou_target')
    assert.ok(personal, 'the personal turn ran as the target user')
    assert.equal(personal.request.conversation.kind, 'dm')
    assert.equal(personal.request.conversation.threadRef, 'feishu:dm:ou_target')
    assert.ok(personal.request.text.includes('check my private deploy notes'))
    const result = t.sent[t.sent.length - 1] as SendOperation
    assert.deepEqual(result.body, { markdown: 'deploy notes say Friday' }, 'the personal result delivers like any reply')
    assert.equal(result.threadId, 'om_thread1', 'the result lands in the origin thread')
    assert.equal(result.replyToMessageId, 'om_origin')
  } finally {
    await t.dispose()
  }
})

test('agent request: decline posts the notice to the origin thread and no personal turn runs', async () => {
  const t = await setup({
    script: [{ reply: '[[ask-agent: <@ou_target> | tidy the scratch dir]]' }],
    agentRequests: agentRequestRig(createMemoryAgentRequestStore()),
  })
  try {
    await t.cells.ctx!.emit(messageEvent({ eventId: 'ar-2', replyToMessageId: 'om_origin' }))
    assert.ok(await waitFor(() => t.sent.length >= 1))
    const runs = await t.runs.list()
    const requestId = `${runs[0]!.id}:ar0`
    await t.cells.ctx!.emit({
      kind: 'interaction',
      provider: 'feishu',
      instanceId: 'test',
      eventId: 'ar-click-2',
      occurredAt: 3,
      receivedAt: 4,
      ref: { destination: { type: 'feishu', target: 'oc_dm_ou_target' }, messageId: 'om_dm2' },
      actor: { providerUserId: 'ou_target' },
      action: { value: encodeAgentRequestValue({ kind: AGENT_REQUEST_VALUE_KIND, requestId, decision: 'reject' }) },
    } as InboundInteractionEvent)
    assert.ok(await waitFor(() => t.sent.length >= 2))
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal((await t.runs.list()).length, 1, 'no personal turn after a decline')
    const notice = t.sent[t.sent.length - 1] as SendOperation
    assert.match(notice.body.text ?? '', /declined/i)
    assert.equal(notice.destination.target, 'oc_chat1', 'the decline notice posts back to the origin thread')
  } finally {
    await t.dispose()
  }
})

test('agent request: a click by anyone but the target is refused and the request stays pending', async () => {
  const store = createMemoryAgentRequestStore()
  const t = await setup({
    script: [{ reply: '[[ask-agent: <@ou_target> | water the plants]]' }],
    agentRequests: agentRequestRig(store),
  })
  try {
    await t.cells.ctx!.emit(messageEvent({ eventId: 'ar-3', replyToMessageId: 'om_origin' }))
    assert.ok(await waitFor(() => t.sent.length >= 1))
    const runs = await t.runs.list()
    const requestId = `${runs[0]!.id}:ar0`
    await t.cells.ctx!.emit({
      kind: 'interaction',
      provider: 'feishu',
      instanceId: 'test',
      eventId: 'ar-click-3',
      occurredAt: 3,
      receivedAt: 4,
      ref: { destination: { type: 'feishu', target: 'oc_dm_ou_target' }, messageId: 'om_dm3' },
      actor: { providerUserId: 'ou_stranger' },
      action: { value: encodeAgentRequestValue({ kind: AGENT_REQUEST_VALUE_KIND, requestId, decision: 'approve' }) },
    } as InboundInteractionEvent)
    assert.ok(await waitFor(() => t.sent.length >= 2))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const refusal = t.sent[t.sent.length - 1] as SendOperation
    assert.match(refusal.body.text ?? '', /Only the person who was asked/)
    const record = await store.get(requestId)
    assert.equal(record?.status, 'pending', 'a forbidden click never decides')
  } finally {
    await t.dispose()
  }
})

test('agent request: an unresolvable DM destination leaves the request pending with a warning', async () => {
  const store = createMemoryAgentRequestStore()
  const t = await setup({
    script: [{ reply: '[[ask-agent: <@ou_unknown> | open the vault]]' }],
    agentRequests: agentRequestRig(store),
  })
  try {
    await t.cells.ctx!.emit(messageEvent({ eventId: 'ar-4', replyToMessageId: 'om_origin' }))
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(t.sent.length, 0, 'the cleaned reply is empty (qm drops it) and no DM resolves')
    const runs = await t.runs.list()
    const record = await store.get(`${runs[0]!.id}:ar0`)
    assert.equal(record?.status, 'pending')
  } finally {
    await t.dispose()
  }
})

const sweepAsk: KeychainAsk = {
  id: 'ask-1',
  credentialId: 'cred-1',
  ownerId: 'feishu:ou_owner',
  requesterId: 'feishu:ou_requester',
  requesterScopeId: 'personal:feishu:ou_requester',
  purpose: 'post to the release channel',
  status: 'approved',
  createdAt: 1,
  expiresAt: 2,
  grantId: 'grant-9',
}

test('keychain-ask sweep: a resolved ask runs as a personal turn in the requester DM', async () => {
  const marked: string[] = []
  const t = await setup({
    script: [{ reply: 'release posted' }],
    askResolutions: {
      keychain: {
        unnotifiedResolvedAsks: async () => (marked.includes(sweepAsk.id) ? [] : [sweepAsk]),
        markAskNotified: async (id) => {
          marked.push(id)
        },
        getGrant: async () => ({ mode: 'once', purpose: 'release posting' }),
      },
      sweepMs: 20,
      resolveDm: async (provider, userId) => ({ destination: { type: provider, target: `oc_dm_${userId}` } }),
    },
  })
  try {
    assert.ok(await waitFor(() => marked.includes(sweepAsk.id)), 'the sweep fired and marked the ask')
    assert.ok(await waitFor(() => t.sent.length >= 1), 'the personal reply delivered to the DM')
    const runs = await t.runs.list()
    const personal = runs.find((r) => r.request.actor.id === sweepAsk.requesterId)
    assert.ok(personal, 'the turn ran as the requester')
    assert.equal(personal.request.surface, 'keychain-ask')
    assert.equal(personal.request.conversation.kind, 'dm')
    assert.equal(personal.request.conversation.threadRef, 'feishu:dm:ou_requester')
    assert.match(personal.request.text, /approved by its owner \(feishu:ou_owner\): one-time grant `grant-9`/)
    assert.match(personal.request.text, /verbatim: "release posting"/)
    const result = t.sent.find((op) => (op as SendOperation).destination.target === 'oc_dm_ou_requester') as SendOperation
    assert.ok(result, 'the result landed in the requester DM')
    assert.deepEqual(result.body, { markdown: 'release posted' })
  } finally {
    await t.dispose()
  }
})

test('keychain-ask sweep: an unresolvable DM is marked notified with no run and no delivery', async () => {
  const marked: string[] = []
  const t = await setup({
    askResolutions: {
      keychain: {
        unnotifiedResolvedAsks: async () => (marked.includes(sweepAsk.id) ? [] : [sweepAsk]),
        markAskNotified: async (id) => {
          marked.push(id)
        },
      },
      sweepMs: 20,
      resolveDm: async () => null,
    },
  })
  try {
    assert.ok(await waitFor(() => marked.includes(sweepAsk.id)), 'the ask was marked to avoid a pinning retry loop')
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal((await t.runs.list()).length, 0)
    assert.equal(t.sent.length, 0)
  } finally {
    await t.dispose()
  }
})

function deliveryRun(result: Record<string, unknown>): Run {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    status: 'done',
    targetState: 'succeeded',
    runSource: 'legacy',
    request: { surface: 'feishu', actor: { id: 'u1', type: 'internal' }, conversation: {} as never, origin: { kind: 'ambient' } as never, text: 'hi' },
    result: result as never,
    deliveryState: null,
    dedupKey: null,
    attempts: 1,
    errorAttempts: 0,
  } as unknown as Run
}

const replyRoute: ImReplyRoute = { destination: { type: 'feishu', target: 'oc_1' }, conversation: { kind: 'channel' } as never }

test('run-result delivery: turn attachments ride the reply body (playground slice)', () => {
  const attachments = [{ name: 'demo.html', mimetype: 'text/html', sizeBytes: 10, blobId: 'blob_1' }]
  const delivered = imRunResultDelivery(deliveryRun({ status: 'ok', reply: 'made it', attachments }), replyRoute)
  assert.ok(delivered)
  assert.deepEqual((delivered.op as SendOperation).body, { markdown: 'made it', attachments })
})

test('run-result delivery: an attachments-only turn still delivers, with no empty text', () => {
  const attachments = [{ name: 'demo.html', mimetype: 'text/html', sizeBytes: 10, blobId: 'blob_1' }]
  const delivered = imRunResultDelivery(deliveryRun({ status: 'ok', reply: '', attachments }), replyRoute, 'text')
  assert.ok(delivered)
  assert.deepEqual((delivered.op as SendOperation).body, { attachments })
})

test('run-result delivery: an empty ok turn with no files sends nothing', () => {
  assert.equal(imRunResultDelivery(deliveryRun({ status: 'ok', reply: '' }), replyRoute), null)
  assert.equal(imRunResultDelivery(deliveryRun({ status: 'ok' }), replyRoute), null)
})

test('run-result delivery: approvals keep the card precedence over attachments (qm parity)', () => {
  const attachments = [{ name: 'demo.html', mimetype: 'text/html', sizeBytes: 10, blobId: 'blob_1' }]
  const delivered = imRunResultDelivery(
    deliveryRun({ status: 'ok', reply: 'made it', pendingApprovals: [{ requestId: 'r1', command: 'rm', reason: 'destructive' }], attachments }),
    replyRoute,
  )
  assert.ok(delivered)
  assert.equal(((delivered.op as SendOperation).body as { text?: string }).text, approvalRequestNotice([{ requestId: 'r1', command: 'rm', reason: 'destructive' }]))
  assert.equal(((delivered.op as SendOperation).body as { attachments?: unknown }).attachments, undefined)
})
