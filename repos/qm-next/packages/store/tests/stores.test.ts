/**
 * Store parity suite: the same behavioral cases run against the in-memory and
 * Postgres implementations of the frozen SessionStore/RunStore contracts.
 * Postgres cases activate when QM_NEXT_PG_URL points at a reachable server;
 * otherwise they skip (memory cases always run).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Run, RunStore, ScopeId, SessionStore, TurnInput } from '@qm/types'
import { createMemoryRunStore, createMemorySessionStore, RUN_SCHEMA_STATEMENTS, SESSION_SCHEMA_STATEMENTS } from '../src/index.ts'
import { createPostgresRunStore } from '../src/postgres-run-store.ts'
import { createPostgresSessionStore } from '../src/postgres-session-store.ts'
import { Pool } from 'pg'

const SCOPE: ScopeId = 'org:test'
const SURFACE = 'test'
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function turnInput(text: string): TurnInput {
  return {
    surface: SURFACE,
    actor: { id: 'user-1', type: 'internal' },
    conversation: { kind: 'dm', threadRef: `thread:${text}`, audience: [{ id: 'user-1', type: 'internal' }] },
    origin: { kind: 'direct' },
    text,
  }
}

interface StoreHarness<S> {
  store: S
  close(): Promise<void>
}

type RunHarness = StoreHarness<RunStore>
type SessionHarness = StoreHarness<SessionStore>

let sessionCounter = 0

function memoryRunHarness(): () => Promise<RunHarness> {
  return async () => ({ store: createMemoryRunStore(), close: async () => undefined })
}

function memorySessionHarness(): () => Promise<SessionHarness> {
  return async () => ({ store: createMemorySessionStore({ leaseTtlMs: 80 }), close: async () => undefined })
}

const pgUrl = process.env.QM_NEXT_PG_URL

async function resetPostgres(): Promise<boolean> {
  if (!pgUrl) return false
  const probe = new Pool({ connectionString: pgUrl, connectionTimeoutMillis: 3000 })
  try {
    await probe.query('SELECT 1')
  } catch {
    return false
  } finally {
    await probe.end().catch(() => undefined)
  }
  const { createPgPool } = await import('../src/pg-pool.ts')
  const runPool = createPgPool(pgUrl, RUN_SCHEMA_STATEMENTS)
  const sessionPool = createPgPool(pgUrl, SESSION_SCHEMA_STATEMENTS)
  await runPool.query('SELECT 1')
  await sessionPool.query('SELECT 1')
  await runPool.close()
  await sessionPool.close()
  return true
}

function freshSessionId(): string {
  sessionCounter += 1
  return `sess-${sessionCounter}`
}

async function runStoreCases(t: import('node:test').TestContext, make: () => Promise<RunHarness>): Promise<void> {
  await t.test('enqueue + claim + complete roundtrip', async () => {
    const h = await make()
    const session = freshSessionId()
    const { run } = await h.store.enqueue({ sessionId: session, request: turnInput('hello') })
    assert.equal(run.status, 'pending')
    const claimed = await h.store.claim('worker-1', 5_000)
    assert.ok(claimed)
    assert.equal(claimed.id, run.id)
    assert.equal(claimed.status, 'running')
    assert.ok(claimed.leaseToken)
    const done = h.store.waitFor(run.id)
    assert.equal(await h.store.complete(run.id, claimed.leaseToken!, { status: 'ok', reply: 'hi' }), true)
    const finished = await done
    assert.equal(finished.status, 'done')
    assert.equal(finished.result?.reply, 'hi')
    assert.equal(await h.store.complete(run.id, 'bogus', { status: 'ok' }), false)
    await h.close()
  })

  await t.test('dedupKey returns the same run', async () => {
    const h = await make()
    const session = freshSessionId()
    const first = await h.store.enqueue({ sessionId: session, request: turnInput('a'), dedupKey: 'k1' })
    const second = await h.store.enqueue({ sessionId: session, request: turnInput('a'), dedupKey: 'k1' })
    assert.equal(second.deduped, true)
    assert.equal(second.run.id, first.run.id)
    await h.close()
  })

  await t.test('one running run per session', async () => {
    const h = await make()
    const session = freshSessionId()
    await h.store.enqueue({ sessionId: session, request: turnInput('r1') })
    await h.store.enqueue({ sessionId: session, request: turnInput('r2') })
    const first = await h.store.claim('worker-1', 5_000)
    assert.ok(first)
    assert.equal(await h.store.claim('worker-2', 5_000), null)
    assert.equal(await h.store.releaseLease(first.id, first.leaseToken!), true)
    const requeued = await h.store.claim('worker-2', 5_000)
    assert.ok(requeued)
    await h.close()
  })

  await t.test('concurrent claims hand out distinct runs', async () => {
    const h = await make()
    for (let i = 0; i < 4; i++) {
      await h.store.enqueue({ sessionId: freshSessionId(), request: turnInput(`r${i}`) })
    }
    const claimed = await Promise.all(['w1', 'w2', 'w3', 'w4', 'w5'].map((w) => h.store.claim(w, 5_000)))
    const ids = claimed.filter((r): r is Run => r !== null).map((r) => r.id)
    assert.equal(ids.length, 4)
    assert.equal(new Set(ids).size, 4)
    await h.close()
  })

  await t.test('fail retries then parks at maxAttempts', async () => {
    const h = await make()
    const session = freshSessionId()
    const { run } = await h.store.enqueue({ sessionId: session, request: turnInput('boom'), maxAttempts: 2 })
    for (let attempt = 0; attempt < 2; attempt++) {
      const claimed = await h.store.claim('worker-1', 5_000)
      assert.ok(claimed)
      const { requeued } = await h.store.fail(claimed.id, claimed.leaseToken!, 'simulated crash')
      assert.equal(requeued, attempt === 0)
    }
    const parked = await h.store.get(run.id)
    assert.equal(parked?.status, 'failed')
    assert.match(parked?.result?.reason ?? '', /simulated crash/)
    await h.close()
  })

  await t.test('reapExpired requeues lapsed leases', async () => {
    const h = await make()
    const session = freshSessionId()
    const { run } = await h.store.enqueue({ sessionId: session, request: turnInput('slow') })
    const claimed = await h.store.claim('worker-1', 40)
    assert.ok(claimed)
    await sleep(90)
    const reaped = await h.store.reapExpired()
    assert.equal(reaped.requeued, 1)
    assert.equal((await h.store.get(run.id))?.status, 'pending')
    await h.close()
  })

  await t.test('withdraw only removes pending runs', async () => {
    const h = await make()
    const session = freshSessionId()
    const { run } = await h.store.enqueue({ sessionId: session, request: turnInput('x') })
    assert.equal(await h.store.withdraw(run.id), true)
    assert.equal(await h.store.get(run.id), null)
    await h.store.enqueue({ sessionId: session, request: turnInput('y') })
    const claimed = await h.store.claim('worker-1', 5_000)
    assert.ok(claimed)
    assert.equal(await h.store.withdraw(claimed.id), false)
    await h.close()
  })

  await t.test('thread queries and listings', async () => {
    const h = await make()
    const s1 = freshSessionId()
    const s2 = freshSessionId()
    await h.store.enqueue({ sessionId: s1, request: turnInput('1') })
    await h.store.enqueue({ sessionId: s2, request: turnInput('2') })
    assert.equal((await h.store.activeForThread(s1))?.sessionId, s1)
    assert.equal((await h.store.inFlightForThread(s1)).length, 1)
    assert.deepEqual((await h.store.activeSessionIds()).sort(), [s1, s2].sort())
    assert.equal((await h.store.list()).length, 2)
    await h.close()
  })
}

async function sessionStoreCases(t: import('node:test').TestContext, make: () => Promise<SessionHarness>): Promise<void> {
  await t.test('getOrCreateByThread is idempotent and heals', async () => {
    const h = await make()
    const first = await h.store.getOrCreateByThread('thread:1', 'dm', SCOPE, SURFACE)
    const second = await h.store.getOrCreateByThread('thread:1', 'dm', SCOPE, SURFACE)
    assert.equal(second.id, first.id)
    assert.equal(first.surface, SURFACE)
    const renamed = await h.store.getOrCreateByThread('thread:1', 'dm', SCOPE, SURFACE, 'New name')
    assert.equal(renamed.channelName, 'New name')
    assert.equal((await h.store.getByThread('thread:1'))?.id, first.id)
    assert.equal((await h.store.get(first.id))?.id, first.id)
    await h.close()
  })

  await t.test('lease is mutually exclusive and recoverable', async () => {
    const h = await make()
    const s = await h.store.getOrCreateByThread(`thread:${freshSessionId()}`, 'dm', SCOPE, SURFACE)
    const first = await h.store.acquireLease(s.id, 'turn')
    assert.ok(first.lease)
    const second = await h.store.acquireLease(s.id, 'turn')
    assert.equal(second.lease, null)
    assert.equal(second.heldBy, 'turn')
    assert.ok(second.heldUntil)
    await h.store.releaseLease(first.lease!)
    const third = await h.store.acquireLease(s.id)
    assert.ok(third.lease)
    await h.store.forceReleaseLease(s.id)
    const fourth = await h.store.acquireLease(s.id)
    assert.ok(fourth.lease)
    await h.close()
  })

  await t.test('expired leases can be re-acquired', async () => {
    const h = await make()
    const s = await h.store.getOrCreateByThread(`thread:${freshSessionId()}`, 'dm', SCOPE, SURFACE)
    const first = await h.store.acquireLease(s.id)
    assert.ok(first.lease)
    await sleep(120)
    const second = await h.store.acquireLease(s.id)
    assert.ok(second.lease)
    assert.notEqual(second.lease.token, first.lease!.token)
    await h.close()
  })

  await t.test('append requires lease; seq is monotonic', async () => {
    const h = await make()
    const s = await h.store.getOrCreateByThread(`thread:${freshSessionId()}`, 'dm', SCOPE, SURFACE)
    await assert.rejects(
      h.store.append({ sessionId: s.id, token: 'bogus' }, { type: 'user', payload: { text: 'x' }, scopeLabel: SCOPE }),
      /valid session lease/,
    )
    const lease = await h.store.acquireLease(s.id)
    assert.ok(lease.lease)
    const e1 = await h.store.append(lease.lease!, { type: 'user', payload: { text: 'one' }, scopeLabel: SCOPE })
    const e2 = await h.store.append(lease.lease!, { type: 'assistant', payload: { text: 'two' }, scopeLabel: SCOPE })
    assert.equal(e1.seq, 0)
    assert.equal(e1.parentSeq, null)
    assert.equal(e2.seq, 1)
    assert.equal(e2.parentSeq, 0)
    assert.equal((await h.store.getEntries(s.id)).length, 2)
    assert.deepEqual((await h.store.getEntries(s.id, { sinceSeq: 1 })).map((e) => e.seq), [1])
    assert.deepEqual((await h.store.getEntries(s.id, { limit: 1 })).map((e) => e.seq), [1])
    await h.close()
  })

  await t.test('participants add, remove and list', async () => {
    const h = await make()
    const s = await h.store.getOrCreateByThread(`thread:${freshSessionId()}`, 'channel', SCOPE, SURFACE)
    await h.store.addParticipant(s.id, 'alice')
    await h.store.addParticipant(s.id, 'bob')
    assert.deepEqual((await h.store.participantsOf(s.id)).sort(), ['alice', 'bob'])
    await h.store.removeParticipant(s.id, 'alice')
    assert.deepEqual(await h.store.participantsOf(s.id), ['bob'])
    await h.store.addParticipant(s.id, 'alice')
    assert.deepEqual((await h.store.participantsOf(s.id)).sort(), ['alice', 'bob'])
    await h.close()
  })
}

test('run store contract: memory', async (t) => {
  await runStoreCases(t, memoryRunHarness())
})

test('session store contract: memory', async (t) => {
  await sessionStoreCases(t, memorySessionHarness())
})

test(
  'run store contract: postgres',
  { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' },
  async (t) => {
    assert.ok(pgUrl)
    const ready = await resetPostgres()
    assert.ok(ready, 'postgres unreachable at QM_NEXT_PG_URL')
    const store = createPostgresRunStore(pgUrl)
    const cleanup = new Pool({ connectionString: pgUrl })
    t.after(async () => {
      await store.close()
      await cleanup.end()
    })
    await runStoreCases(t, async () => {
      await cleanup.query('TRUNCATE runs')
      return { store, close: async () => undefined }
    })
  },
)

test(
  'session store contract: postgres',
  { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' },
  async (t) => {
    assert.ok(pgUrl)
    const store = createPostgresSessionStore(pgUrl, { leaseTtlMs: 80 })
    const cleanup = new Pool({ connectionString: pgUrl })
    t.after(async () => {
      await store.close()
      await cleanup.end()
    })
    await sessionStoreCases(t, async () => {
      await cleanup.query('TRUNCATE sessions, session_entries, participants, session_leases')
      return { store, close: async () => undefined }
    })
  },
)
