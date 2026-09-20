/**
 * Postgres intake stores: the durable twins run the same contract as the
 * memory inbox (accept/dedup on the composite Intake Key, markTurn
 * first-writer-wins, monotonic cursors, idempotent dead letters,
 * markRedelivered). Cases activate when QM_NEXT_PG_URL points at a
 * reachable server.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPostgresIntakeCursorStore,
  createPostgresIntakeDeadLetterStore,
  createPostgresIntakeInbox,
} from '@qm/im-core/runtime'
import type { InboundMessageEvent } from '@qm/im-core'

const pgUrl = process.env.QM_NEXT_PG_URL

function messageEvent(provider: string, eventId: string, text: string): InboundMessageEvent {
  return {
    kind: 'message',
    provider,
    instanceId: 'pg',
    eventId,
    occurredAt: 1_000,
    receivedAt: 2_000,
    destination: { type: provider, target: 'chat-1' },
    actor: { providerUserId: 'u1' },
    text,
  }
}

test('postgres intake inbox: idempotent accept on the composite key, seq order', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  const inbox = createPostgresIntakeInbox(pgUrl!)
  t.after(() => inbox.close())

  const first = await inbox.accept(messageEvent('p5-inbox', 'evt-1', 'hello'), 5_000)
  assert.equal(first.duplicate, false)
  assert.equal(first.record.seq > 0, true)
  assert.equal(first.record.acceptedAt, 5_000)

  const duplicate = await inbox.accept(messageEvent('p5-inbox', 'evt-1', 'hello'))
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.record.id, first.record.id)

  const otherProvider = await inbox.accept(messageEvent('p5-other', 'evt-1', 'other'))
  assert.equal(otherProvider.duplicate, false, 'same eventId under a different provider is distinct')

  const second = await inbox.accept(messageEvent('p5-inbox', 'evt-2', 'two'))
  assert.ok(
    second.record.seq > first.record.seq,
    'seq is monotonic (the counter is global to the inbox, not per test)',
  )

  const after = await inbox.listAfterSeq(first.record.seq - 1)
  assert.ok(after.map((r) => r.seq).includes(first.record.seq))
  const afterFirst = await inbox.listAfterSeq(first.record.seq, 10)
  assert.ok(afterFirst.map((r) => r.seq).includes(second.record.seq), 'second record sits above the cursor')
  assert.deepEqual(
    [...afterFirst.map((r) => r.seq)].sort((a, b) => a - b),
    afterFirst.map((r) => r.seq),
    'listAfterSeq returns ascending seq order',
  )
  assert.equal((await inbox.get(first.record.id))?.eventId, 'evt-1')
})

test('postgres intake inbox: markTurn first-writer-wins', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  const inbox = createPostgresIntakeInbox(pgUrl!)
  t.after(() => inbox.close())
  const { record } = await inbox.accept(messageEvent('p5-turn', 'evt-1', 'hello'))
  assert.equal(await inbox.markTurn(record.id, 'run-1'), true)
  assert.equal((await inbox.get(record.id))?.turnId, 'run-1')
  assert.equal(await inbox.markTurn(record.id, 'run-2'), false)
  assert.equal((await inbox.get(record.id))?.turnId, 'run-1')
})

test('postgres intake cursors: monotonic advance', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  const cursors = createPostgresIntakeCursorStore(pgUrl!)
  t.after(() => cursors.close())
  assert.equal(await cursors.get('p5-sub'), null)
  await cursors.advance('p5-sub', 7, 1)
  assert.equal(await cursors.get('p5-sub'), 7)
  await cursors.advance('p5-sub', 3, 2)
  assert.equal(await cursors.get('p5-sub'), 7, 'a stale write never moves a cursor backwards')
  await cursors.advance('p5-sub', 9, 3)
  assert.equal(await cursors.get('p5-sub'), 9)
})

test('postgres intake dead letters: idempotent record, admin redelivery mark', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  const deadLetters = createPostgresIntakeDeadLetterStore(pgUrl!)
  t.after(() => deadLetters.close())
  const letter = {
    id: 'p5-dl-1',
    subscriber: 'mirror',
    intakeId: 'p5-intake-1',
    provider: 'p5',
    eventId: 'evt-1',
    seq: 1,
    attempts: 3,
    lastError: 'mirror unavailable',
    failedAt: 100,
    redeliveryUrl: '/admin/im/intake/dead-letters/p5-intake-1/replay',
  }
  await deadLetters.record(letter)
  await deadLetters.record(letter)
  const listed = await deadLetters.list({ subscriber: 'mirror' })
  assert.equal(listed.filter((l) => l.id === 'p5-dl-1').length, 1, 'idempotent per (subscriber, intakeId)')
  assert.equal((await deadLetters.get('p5-dl-1'))?.redeliveryUrl, letter.redeliveryUrl)
  assert.equal(await deadLetters.markRedelivered('p5-dl-1', { actor: 'admin-1', at: 200 }), true)
  const stored = await deadLetters.get('p5-dl-1')
  assert.equal(stored?.redeliveredAt, 200)
  assert.equal(stored?.redeliveredBy, 'admin-1')
  assert.equal(await deadLetters.markRedelivered('p5-dl-1', { actor: 'admin-2', at: 300 }), false)
})
