/**
 * Bit-identical parity: the same operation sequence must produce the
 * same observable outcome on memory and Postgres implementations of
 * each concurrency primitive. The test runs both implementations with
 * a shared FakeClock and shared sequence of `at` arguments so that
 * timestamps are deterministic.
 *
 * Postgres leg is skipped when `QM_NEXT_PG_URL` is unset.
 *
 * Linked ADRs: ADR-0001, ADR-0010, ADR-0013.
 */
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import {
  createFakeClock,
  createMemoryLeaseStore,
  createMemorySequenceAllocator,
  createMemorySessionReservationStore,
  createPostgresLeaseStore,
  createPostgresSequenceAllocator,
  createPostgresSessionReservationStore,
} from '@qm/concurrency'
import type {
  LeaseAcquireResult,
  LeaseStore,
  SessionReservationStore,
} from '@qm/types'

const pgUrl = process.env.QM_NEXT_PG_URL

async function pgAvailable(): Promise<boolean> {
  if (!pgUrl) return false
  const probe = new Pool({ connectionString: pgUrl, connectionTimeoutMillis: 3000 })
  try {
    await probe.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await probe.end().catch(() => undefined)
  }
}

function makeMemoryLease(clock = createFakeClock(1_000)) {
  return { store: createMemoryLeaseStore({ clock }), clock }
}

function makePgLease(clock = createFakeClock(1_000)) {
  if (!pgUrl) return null
  return { store: createPostgresLeaseStore({ connectionString: pgUrl, clock }), clock }
}

function makeMemorySeq() {
  return createMemorySequenceAllocator()
}

function makePgSeq() {
  if (!pgUrl) return null
  return createPostgresSequenceAllocator({ connectionString: pgUrl })
}

function makeMemoryRes(clock = createFakeClock(1_000)) {
  return { store: createMemorySessionReservationStore({ clock }), clock }
}

function makePgRes(clock = createFakeClock(1_000)) {
  if (!pgUrl) return null
  return { store: createPostgresSessionReservationStore({ connectionString: pgUrl, clock }), clock }
}

async function exerciseLease(store: LeaseStore, clock: { now(): number }, runId: string) {
  // Replace the runId with a stable marker so the two implementations
  // produce identical output sequences regardless of the UUID used.
  const TAG = '<run>'
  const seq: unknown[] = []
  const at = (offset: number): number => clock.now() + offset

  const a1: LeaseAcquireResult = await store.acquire(runId, 100, at(0))
  seq.push(['acquire', TAG, a1.ok])
  if (a1.ok) seq.push(['token-len', a1.token.length > 0])

  const a2 = await store.acquire(runId, 100, at(50))
  seq.push(['acquire', TAG, a2.ok, a2.ok ? null : a2.reason])

  if (a1.ok) {
    const r1 = await store.renew(runId, a1.token, 200, at(60))
    seq.push(['renew', r1.ok, r1.ok ? r1.expiresAt : r1.reason])
    const r2 = await store.renew(runId, 'wrong', 100, at(70))
    seq.push(['renew-wrong', r2.ok, r2.ok ? null : r2.reason])
  }

  const reap1 = await store.reapExpired(runId, at(150))
  seq.push(['reap', reap1.outcome])
  const reap2 = await store.reapExpired(runId, at(500))
  seq.push(['reap', reap2.outcome])

  if (a1.ok) {
    const rel = await store.release(runId, a1.token, at(600))
    seq.push(['release', rel.ok])
  }

  return seq
}

test('bit-identical: memory vs postgres lease store produce the same sequence of outcomes', async (t) => {
  if (!(await pgAvailable())) return t.skip('postgres not reachable')

  const memory = makeMemoryLease()
  const pg = makePgLease()
  if (!pg) return t.skip('postgres subject unavailable')

  // Distinct run ids so the suites don't collide on the same PG table.
  const memRunId = `parity-lease-mem-${randomUUID()}`
  const pgRunId = `parity-lease-pg-${randomUUID()}`
  const memoryResult = await exerciseLease(memory.store, memory.clock, memRunId)
  const pgResult = await exerciseLease(pg.store, pg.clock, pgRunId)
  assert.deepEqual(memoryResult, pgResult, 'memory and postgres produce identical outcome sequences')
})

test('bit-identical: memory vs postgres sequence allocator monotonicity agrees', async (t) => {
  if (!(await pgAvailable())) return t.skip('postgres not reachable')

  const mem = makeMemorySeq()
  const pg = makePgSeq()
  if (!pg) return t.skip('postgres subject unavailable')

  // The two implementations are independent (one is a memory map, the
  // other is a Postgres table). To verify bit-identical monotonicity we
  // exercise each in isolation with its own logical key.
  const memKey = `parity-seq-mem-${randomUUID()}`
  const pgKey = `parity-seq-pg-${randomUUID()}`
  const N = 50

  const memSeq: number[] = []
  const pgSeq: number[] = []
  for (let i = 0; i < N; i += 1) {
    const r1 = await mem.next(memKey)
    if (!r1.ok) throw new Error(`mem conflict: ${r1.reason}`)
    memSeq.push(r1.seq)
    const r2 = await pg.next(pgKey)
    if (!r2.ok) throw new Error(`pg conflict: ${r2.reason}`)
    pgSeq.push(r2.seq)
  }
  for (let i = 1; i < memSeq.length; i += 1) {
    const prev = memSeq[i - 1]
    const cur = memSeq[i]
    assert.ok(prev !== undefined && cur !== undefined, 'memSeq populated')
    assert.equal(cur, prev + 1, 'memory seq strictly increasing')
  }
  for (let i = 1; i < pgSeq.length; i += 1) {
    const prev = pgSeq[i - 1]
    const cur = pgSeq[i]
    assert.ok(prev !== undefined && cur !== undefined, 'pgSeq populated')
    assert.equal(cur, prev + 1, 'postgres seq strictly increasing')
  }
  assert.deepEqual(memSeq, pgSeq, 'both implementations produce identical 0..N-1 sequences')
})

test('bit-identical: memory vs postgres session reservation produce the same outcomes', async (t) => {
  if (!(await pgAvailable())) return t.skip('postgres not reachable')

  const mem = makeMemoryRes()
  const pg = makePgRes()
  if (!pg) return t.skip('postgres subject unavailable')

  const sessId = `parity-sess-${randomUUID()}`

  async function exercise(store: SessionReservationStore, sessionId: string) {
    const out: unknown[] = []
    const r1 = await store.reserve(sessionId, 'parity-run-1', 1_000, 1_000)
    out.push(['reserve', r1.ok, r1.ok ? r1.acquired : r1.reason])
    const r2 = await store.reserve(sessionId, 'parity-run-2', 1_000, 1_500)
    out.push([
      'reserve',
      r2.ok,
      r2.ok ? r2.acquired : r2.reason,
      r2.ok && !r2.acquired ? r2.currentRunId : null,
    ])
    const wrong = await store.release(sessionId, 'parity-run-3', { terminalStateConfirmed: true })
    out.push(['release-wrong', wrong.ok, wrong.ok ? null : wrong.reason])
    // The owner is parity-run-1; release without terminal confirmation
    // surfaces terminal_not_confirmed. (run_mismatch is checked first
    // when the caller is not the owner — tested separately.)
    const guard = await store.release(sessionId, 'parity-run-1', {})
    out.push(['release-no-confirm', guard.ok, guard.ok ? null : guard.reason])
    const ok = await store.release(sessionId, 'parity-run-1', { terminalStateConfirmed: true })
    out.push(['release-confirmed', ok.ok])
    const list = await store.listActiveForSession(sessionId)
    out.push(['list', [...list]])
    return out
  }

  // Distinct session ids so prior PG state doesn't pollute the run.
  const memResult = await exercise(mem.store, `${sessId}-mem`)
  const pgResult = await exercise(pg.store, `${sessId}-pg`)
  assert.deepEqual(memResult, pgResult, 'memory and postgres reservation outcomes agree')
})
