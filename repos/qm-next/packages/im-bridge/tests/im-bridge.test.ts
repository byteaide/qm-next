/**
 * ImTurnBridge: inbound message → run submission → terminal → delivery,
 * approval-card interaction round-trip, eventId dedup, guest refusal
 * notices, and route isolation for non-IM runs.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@qm/cordis'
import { createTurnRunner } from '@qm/api'
import type { ImCapabilities, ImProvider, ImProviderStartContext, InboundInteractionEvent, InboundMessageEvent, OutboundOperation, SendOperation } from '@qm/im-core'
import { createImRegistry } from '@qm/im-core/runtime'
import { createHarnessRouter, createMockHarness, OrchestratorService, type MockTurnStep } from '@qm/orchestrator'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { IdentityService, ResolutionService } from '@qm/types'
import { APPROVAL_VALUE_KIND, approvalRequestCard, createImTurnBridge, parseApprovalValue, type ApprovalActionValue, type ImTurnBridge } from '../src/index.ts'

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

function recorderProvider(sent: OutboundOperation[], cells: RecorderCells): ImProvider {
  return {
    provider: 'feishu',
    instanceId: 'test',
    capabilities,
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

function interactionEvent(value: ApprovalActionValue, eventId = 'e2'): InboundInteractionEvent {
  return {
    kind: 'interaction',
    provider: 'feishu',
    instanceId: 'test',
    eventId,
    occurredAt: 3,
    receivedAt: 4,
    ref: { destination: { type: 'feishu', target: 'oc_chat1', threadId: 'om_thread1' }, messageId: 'om_card1' },
    actor: { providerUserId: 'u1', displayName: 'User One' },
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
  bridge: ImTurnBridge
  cells: RecorderCells
  sent: OutboundOperation[]
  dispose(): Promise<void>
}

async function setup(opts: { script?: MockTurnStep[]; actorType?: 'internal' | 'guest' } = {}): Promise<Harness> {
  const sessions = createMemorySessionStore()
  const runs = createMemoryRunStore()
  const harnessRouter = createHarnessRouter({ defaultId: 'mock' })
  harnessRouter.register(createMockHarness({ ...(opts.script ? { script: opts.script } : {}) }))
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
  const sent: OutboundOperation[] = []
  const cells: RecorderCells = {}
  let bridge: ImTurnBridge | undefined
  const registry = createImRegistry({ onEvent: (events) => (bridge ? bridge.sink(events) : Promise.resolve()) })
  bridge = createImTurnBridge(
    { runs, sessions, resolution: devResolution(), im: registry },
    { ...(opts.actorType ? { actorType: opts.actorType } : {}) },
  )
  await bridge.start()
  const disposer = await registry.register(recorderProvider(sent, cells))
  return {
    runs,
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
    assert.equal(run.status, 'done')
    assert.equal(run.request.surface, 'feishu')
    assert.equal(run.request.actor.id, 'feishu:u1')
    assert.equal(run.request.conversation.threadRef, 'feishu:oc_chat1:om_thread1')
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

test('pending approval delivers a card; clicking approve and reject submits approval turns', async () => {
  const t = await setup({
    script: [{ reply: '', pausedOnApproval: true, pendingApprovals: [{ command: 'deploy', reason: 'needs sign-off' }] }],
  })
  try {
    await t.cells.ctx!.emit(messageEvent())
    assert.ok(await waitFor(() => t.sent.length === 1), 'expected approval card delivery')
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

    await t.cells.ctx!.emit(interactionEvent(approveValue))
    assert.ok(await waitFor(() => t.sent.length === 2), 'expected approve reply delivery')
    await t.cells.ctx!.emit(interactionEvent(rejectValue, 'e3'))
    assert.ok(await waitFor(() => t.sent.length === 3), 'expected reject reply delivery')

    const all = await t.runs.list()
    assert.equal(all.length, 3)
    const approveRun = all.find((run) => run.request.text === 'Approve: deploy')
    const rejectRun = all.find((run) => run.request.text === 'Reject: deploy')
    assert.ok(approveRun && rejectRun)
    assert.deepEqual(approveRun.request.approval, { requestId: approveValue.requestId, approved: true })
    assert.equal(approveRun.request.text, 'Approve: deploy')
    assert.deepEqual(rejectRun.request.approval, { requestId: rejectValue.requestId, approved: false })
    assert.equal(rejectRun.request.conversation.threadRef, 'feishu:oc_chat1:om_thread1')
    const approveReply = t.sent[1] as SendOperation | undefined
    const rejectReply = t.sent[2] as SendOperation | undefined
    assert.equal(approveReply?.body.markdown, 'echo: Approve: deploy')
    assert.equal(rejectReply?.body.markdown, 'echo: Reject: deploy')
  } finally {
    await t.dispose()
  }
})

test('registry dedup keeps a duplicate eventId from double-submitting', async () => {
  const t = await setup()
  try {
    const event = messageEvent()
    await t.cells.ctx!.emit(event)
    await t.cells.ctx!.emit(event)
    assert.ok(await waitFor(async () => (await t.runs.list()).length === 1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal((await t.runs.list()).length, 1)
    assert.equal(t.sent.length, 1)
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
    assert.ok(await waitFor(async () => (await t.runs.list()).every((run) => run.status === 'done')))
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

test('approvalRequestCard keeps request context and both decisions on the buttons', () => {
  const card = approvalRequestCard('run-1', 'session-1', [
    { requestId: 'session-1:deploy', command: 'deploy', reason: 'needs sign-off' },
  ])
  const elements = card['elements'] as Array<{ tag: string; actions?: Array<{ value: ApprovalActionValue }> }>
  const actions = elements.find((element) => element.tag === 'action')?.actions
  assert.equal(actions?.length, 2)
  assert.deepEqual(actions?.[0]?.value, {
    kind: APPROVAL_VALUE_KIND,
    runId: 'run-1',
    sessionId: 'session-1',
    requestId: 'session-1:deploy',
    command: 'deploy',
    decision: 'approve',
  })
  assert.equal(actions?.[1]?.value.decision, 'reject')
})
