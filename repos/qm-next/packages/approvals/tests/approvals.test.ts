/**
 * Approvals parity suite: the same behavioral cases run against the
 * in-memory and Postgres implementations of the frozen ApprovalStore
 * contract, plus the approval value codec and the ambient minimal slice.
 * Postgres cases activate when QM_NEXT_PG_URL points at a reachable server;
 * otherwise they skip (memory cases always run).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { InboundMessageEvent } from '@qm/im-core'
import type { Destination, Principal, TurnInput } from '@qm/types'
import {
  APPROVAL_VALUE_KIND,
  createAmbientService,
  createKeywordAmbientJudge,
  createMemoryApprovalStore,
  createMemoryChannelPolicyStore,
  createNoopAmbientJudge,
  encodeApprovalValue,
  parseApprovalValue,
  type AmbientJudge,
  type AmbientRoute,
  type ApprovalActionValue,
  type ApprovalRecordInput,
  type ApprovalStore,
} from '../src/index.ts'
import { APPROVALS_SCHEMA_STATEMENTS, createPostgresApprovalStore } from '../src/postgres-approval-store.ts'
import { Pool } from 'pg'

const DESTINATION: Destination = { type: 'feishu', target: 'oc_chat1' }
const REQUESTER: Principal = { id: 'feishu:u1', type: 'internal', displayName: 'User One' }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

let seq = 0

function recordInput(overrides: Partial<ApprovalRecordInput> = {}): ApprovalRecordInput {
  seq += 1
  return {
    requestId: `req-${seq}`,
    runId: `run-${seq}`,
    sessionId: `sess-${seq}`,
    command: 'deploy prod',
    reason: 'needs sign-off',
    requester: REQUESTER,
    destination: DESTINATION,
    ...overrides,
  }
}

interface Harness {
  store: ApprovalStore
  close(): Promise<void>
}

const pgUrl = process.env.QM_NEXT_PG_URL

function memoryHarness(): () => Promise<Harness> {
  return async () => ({ store: createMemoryApprovalStore(), close: async () => undefined })
}

async function resetApprovalsTable(): Promise<boolean> {
  if (!pgUrl) return false
  const probe = new Pool({ connectionString: pgUrl, connectionTimeoutMillis: 3000 })
  try {
    await probe.query('SELECT 1')
  } catch {
    return false
  } finally {
    await probe.end().catch(() => undefined)
  }
  const { createPgPool } = await import('@qm/store')
  const pool = createPgPool(pgUrl, APPROVALS_SCHEMA_STATEMENTS)
  await pool.query('SELECT 1')
  await pool.q('DELETE FROM approvals')
  await pool.close()
  return true
}

function pgHarness(): () => Promise<Harness> {
  return async () => {
    await resetApprovalsTable()
    const store = createPostgresApprovalStore(pgUrl!)
    return { store, close: async () => store.close?.() }
  }
}

async function approvalStoreCases(t: import('node:test').TestContext, make: () => Promise<Harness>): Promise<void> {
  await t.test('record + get roundtrip preserves the full record', async () => {
    const h = await make()
    try {
      const input = recordInput({
        purpose: 'ship the release',
        summary: 'deploy api v2',
        kind: 'approval',
        threadId: 'om_thread1',
      })
      const recorded = await h.store.record(input)
      assert.equal(recorded.status, 'pending')
      assert.equal(recorded.requesterId, REQUESTER.id)
      assert.equal(recorded.kind, 'approval')
      assert.deepEqual(recorded.destination, DESTINATION)
      assert.equal(recorded.threadId, 'om_thread1')
      const fetched = await h.store.get(input.requestId)
      assert.deepEqual(fetched, recorded)
    } finally {
      await h.close()
    }
  })

  await t.test('record keeps the first row per requestId', async () => {
    const h = await make()
    try {
      const input = recordInput()
      const first = await h.store.record(input)
      const second = await h.store.record({ ...input, command: 'changed' })
      assert.deepEqual(second, first)
      assert.equal(second.command, 'deploy prod')
    } finally {
      await h.close()
    }
  })

  await t.test('decide approves exactly once; duplicate clicks dedupe', async () => {
    const h = await make()
    try {
      const input = recordInput()
      await h.store.record(input)
      const first = await h.store.decide(input.requestId, { approved: true, decidedBy: REQUESTER.id })
      assert.equal(first.outcome, 'decided')
      assert.equal(first.approved, true)
      assert.ok(first.outcome === 'decided' && first.record.status === 'approved')
      assert.equal(first.outcome === 'decided' && first.record.decidedBy, REQUESTER.id)
      const second = await h.store.decide(input.requestId, { approved: true, decidedBy: REQUESTER.id })
      assert.equal(second.outcome, 'already_decided')
      assert.equal(second.approved, true)
    } finally {
      await h.close()
    }
  })

  await t.test('reject transitions to rejected', async () => {
    const h = await make()
    try {
      const input = recordInput()
      await h.store.record(input)
      const result = await h.store.decide(input.requestId, { approved: false, decidedBy: REQUESTER.id })
      assert.equal(result.outcome, 'decided')
      assert.equal(result.approved, false)
      assert.ok(result.outcome === 'decided' && result.record.status === 'rejected')
    } finally {
      await h.close()
    }
  })

  await t.test('only the requester may decide; the record stays pending', async () => {
    const h = await make()
    try {
      const input = recordInput()
      await h.store.record(input)
      const intruder = await h.store.decide(input.requestId, { approved: true, decidedBy: 'feishu:intruder' })
      assert.equal(intruder.outcome, 'forbidden')
      assert.ok(intruder.outcome === 'forbidden' && intruder.record.status === 'pending')
      const legit = await h.store.decide(input.requestId, { approved: true, decidedBy: REQUESTER.id })
      assert.equal(legit.outcome, 'decided')
    } finally {
      await h.close()
    }
  })

  await t.test('unknown request ids are not found', async () => {
    const h = await make()
    try {
      const result = await h.store.decide('req-missing', { approved: true, decidedBy: REQUESTER.id })
      assert.deepEqual(result, { outcome: 'not_found' })
      assert.equal(await h.store.get('req-missing'), null)
    } finally {
      await h.close()
    }
  })

  await t.test('re-recording never resurrects a decided record', async () => {
    const h = await make()
    try {
      const input = recordInput()
      await h.store.record(input)
      await h.store.decide(input.requestId, { approved: true, decidedBy: REQUESTER.id })
      const again = await h.store.record(input)
      assert.equal(again.status, 'approved')
      assert.ok(again.decidedAt)
    } finally {
      await h.close()
    }
  })

  await t.test('listPending returns pending records newest-first with optional limit', async () => {
    const h = await make()
    try {
      const a = await h.store.record(recordInput())
      await sleep(2)
      const b = await h.store.record(recordInput())
      await sleep(2)
      const c = await h.store.record(recordInput())
      const pending = await h.store.listPending()
      assert.equal(pending.length, 3)
      assert.deepEqual(pending.map((r) => r.requestId), [c.requestId, b.requestId, a.requestId])
      const limited = await h.store.listPending({ limit: 2 })
      assert.deepEqual(limited.map((r) => r.requestId), [c.requestId, b.requestId])
    } finally {
      await h.close()
    }
  })
}

test('approval store: memory implementation', async (t) => {
  await approvalStoreCases(t, memoryHarness())
})

test('approval store: postgres implementation', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  if (!(await resetApprovalsTable())) return t.skip('postgres unreachable at QM_NEXT_PG_URL')
  await approvalStoreCases(t, pgHarness())
})

test('approval decisions survive a restart on postgres', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  if (!(await resetApprovalsTable())) return t.skip('postgres unreachable at QM_NEXT_PG_URL')
  const first = createPostgresApprovalStore(pgUrl!)
  const input = recordInput()
  await first.record(input)
  await first.close?.()
  const restarted = createPostgresApprovalStore(pgUrl!)
  try {
    const fetched = await restarted.get(input.requestId)
    assert.ok(fetched)
    assert.equal(fetched.status, 'pending')
    const decided = await restarted.decide(input.requestId, { approved: true, decidedBy: REQUESTER.id })
    assert.equal(decided.outcome, 'decided')
  } finally {
    await restarted.close?.()
  }
})

test('approval value codec round-trips objects and JSON strings', () => {
  const value: ApprovalActionValue = {
    kind: APPROVAL_VALUE_KIND,
    runId: 'run-1',
    sessionId: 'sess-1',
    requestId: 'req-1',
    command: 'deploy',
    decision: 'approve',
  }
  assert.deepEqual(parseApprovalValue(value), value)
  assert.deepEqual(parseApprovalValue(JSON.stringify(value)), value)
  assert.deepEqual(parseApprovalValue(encodeApprovalValue(value)), value)
  assert.equal(parseApprovalValue('not json'), null)
  assert.equal(parseApprovalValue(null), null)
  assert.equal(parseApprovalValue({ kind: 'other', runId: 'r1', requestId: 'q', command: 'c', decision: 'approve' }), null)
  assert.equal(parseApprovalValue({ kind: APPROVAL_VALUE_KIND, requestId: 'q', command: 'c', decision: 'approve' }), null)
  assert.equal(
    parseApprovalValue({ kind: APPROVAL_VALUE_KIND, runId: 'r1', requestId: 'q', command: 'c', decision: 'maybe' }),
    null,
  )
})

let ambientSeq = 0

function ambientEvent(overrides: Partial<InboundMessageEvent> = {}): InboundMessageEvent {
  ambientSeq += 1
  return {
    kind: 'message',
    provider: 'feishu',
    instanceId: 'test',
    eventId: `ambient-${ambientSeq}`,
    occurredAt: 1,
    receivedAt: 2,
    destination: { type: 'feishu', target: 'oc_chat1' },
    actor: { providerUserId: 'u9', displayName: 'Chatter' },
    text: 'anyone knows the deploy window?',
    ...overrides,
  }
}

function engagingJudge(text: string): AmbientJudge {
  return { consider: async () => ({ engage: true, text }) }
}

interface AmbientRig {
  submits: Array<{ input: TurnInput; route: AmbientRoute }>
  policy: ReturnType<typeof createMemoryChannelPolicyStore>
}

function ambientRig(judge: AmbientJudge = engagingJudge('Engaging: someone asked about deploys')): AmbientRig & { service: ReturnType<typeof createAmbientService> } {
  const submits: Array<{ input: TurnInput; route: AmbientRoute }> = []
  const policy = createMemoryChannelPolicyStore()
  const service = createAmbientService({
    policy,
    judge,
    submit: async (input, route) => {
      submits.push({ input, route })
    },
  })
  return { submits, policy, service }
}

test('ambient is inert unless the container policy enables it and the judge engages', async () => {
  const rig = ambientRig()
  await rig.service.observe(ambientEvent())
  assert.equal(rig.submits.length, 0, 'no policy → no ambient turn')
  const noopRig = ambientRig(createNoopAmbientJudge())
  await noopRig.policy.setAmbient('feishu:oc_chat1', true)
  await noopRig.service.observe(ambientEvent())
  assert.equal(noopRig.submits.length, 0, 'enabled policy + noop judge → still no ambient turn')
  const engaged = ambientRig()
  await engaged.policy.setAmbient('feishu:oc_chat1', true)
  await engaged.service.observe(ambientEvent())
  assert.equal(engaged.submits.length, 1)
  const { input, route } = engaged.submits[0]!
  assert.deepEqual(input.origin, { kind: 'ambient' })
  assert.equal(input.text, 'Engaging: someone asked about deploys')
  assert.equal(input.actor.id, 'feishu:u9')
  assert.equal(input.actor.type, 'internal')
  assert.equal(input.conversation.threadRef, 'feishu:oc_chat1')
  assert.equal(route.destination.target, 'oc_chat1')
})

test('ambient with a thread routes the turn back into the thread', async () => {
  const rig = ambientRig()
  await rig.policy.setAmbient('feishu:oc_chat1', true)
  await rig.service.observe(ambientEvent({ threadId: 'om_t1' }))
  assert.equal(rig.submits.length, 1)
  const { input, route } = rig.submits[0]!
  assert.equal(input.conversation.threadRef, 'feishu:oc_chat1:om_t1')
  assert.equal(route.threadId, 'om_t1')
})

test('ambient skips mention and bot events even when enabled', async () => {
  const rig = ambientRig()
  await rig.policy.setAmbient('feishu:oc_chat1', true)
  await rig.service.observe(ambientEvent({ mentionedBot: true }))
  await rig.service.observe(ambientEvent({ actor: { providerUserId: 'bot1', isBot: true } }))
  assert.equal(rig.submits.length, 0)
})

test('the default judge port is a no-op', async () => {
  const verdict = await createNoopAmbientJudge().consider({
    provider: 'feishu',
    destination: DESTINATION,
    actor: { providerUserId: 'u9' },
    text: 'hello',
    occurredAt: 0,
  })
  assert.deepEqual(verdict, { engage: false })
})

test('the keyword stub judge engages on case-insensitive matches and star, verbatim text', async () => {
  const judge = createKeywordAmbientJudge('Deploy')
  const candidate = {
    provider: 'feishu',
    destination: DESTINATION,
    actor: { providerUserId: 'u9' },
    text: 'anyone knows the DEPLOY window?',
    occurredAt: 0,
  }
  const hit = await judge.consider(candidate)
  assert.deepEqual(hit, { engage: true }, 'case-insensitive keyword match engages with the text untouched')
  assert.equal((await judge.consider({ ...candidate, text: 'lunch anyone?' })).engage, false)
  const star = createKeywordAmbientJudge('*')
  assert.deepEqual(await star.consider({ ...candidate, text: 'anything at all' }), { engage: true })
  assert.equal(createKeywordAmbientJudge('  ').consider === undefined, false)
  assert.equal((await createKeywordAmbientJudge('   ').consider(candidate)).engage, false, 'blank keyword never engages')
})
