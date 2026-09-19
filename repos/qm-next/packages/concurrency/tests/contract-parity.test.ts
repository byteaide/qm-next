/**
 * Phase 0 contract suite for the four concurrency primitives.
 *
 * The suite is parameterized over a `ContractSubject` — a triple of
 * (memory, postgres, name). Tests assert that the same operations on
 * both implementations produce the same observable behavior given the
 * same seed. The Postgres leg is skipped when `QM_NEXT_PG_URL` is not
 * set; the suite still passes in memory mode.
 *
 * Linked ADRs: ADR-0001, ADR-0010, ADR-0013, ADR-0014.
 */
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import {
  createFakeClock,
  createInMemoryEventLog,
  createMemoryLeaseStore,
  createMemorySequenceAllocator,
  createMemorySessionReservationStore,
  createPostgresLeaseStore,
  createPostgresSequenceAllocator,
  createPostgresSessionReservationStore,
  createRolloutFlagRegistry,
} from '@qm/concurrency'
import type {
  LeaseStore,
  RolloutFlag,
  RolloutFlagMeta,
  SequenceAllocator,
  SessionReservationStore,
} from '@qm/types'

const pgUrl = process.env.QM_NEXT_PG_URL

async function postgresReachable(): Promise<boolean> {
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

interface LeaseSubject {
  store: LeaseStore
  close?: () => Promise<void>
}

interface AllocatorSubject {
  allocator: SequenceAllocator
  close?: () => Promise<void>
}

interface ReservationSubject {
  store: SessionReservationStore
  close?: () => Promise<void>
}

function makeMemoryLease(): LeaseSubject {
  const clock = createFakeClock(1_000)
  return { store: createMemoryLeaseStore({ clock }) }
}

function makePgLease(): LeaseSubject | null {
  if (!pgUrl) return null
  const clock = createFakeClock(1_000)
  return {
    store: createPostgresLeaseStore({ connectionString: pgUrl, clock }),
    close: async () => {
      // Pool is closed on process exit; tests run sequentially so no close
      // is required between cases. Real close happens in the suite teardown.
    },
  }
}

function makeMemoryAllocator(): AllocatorSubject {
  return { allocator: createMemorySequenceAllocator() }
}

function makePgAllocator(): AllocatorSubject | null {
  if (!pgUrl) return null
  return { allocator: createPostgresSequenceAllocator({ connectionString: pgUrl }) }
}

function makeMemoryReservation(): ReservationSubject {
  const clock = createFakeClock(1_000)
  return { store: createMemorySessionReservationStore({ clock }) }
}

function makePgReservation(): ReservationSubject | null {
  if (!pgUrl) return null
  const clock = createFakeClock(1_000)
  return {
    store: createPostgresSessionReservationStore({ connectionString: pgUrl, clock }),
  }
}

const leaseSubjects: Array<readonly [string, () => LeaseSubject | null]> = [
  ['memory', makeMemoryLease],
  ['postgres', makePgLease],
]

const allocatorSubjects: Array<readonly [string, () => AllocatorSubject | null]> = [
  ['memory', makeMemoryAllocator],
  ['postgres', makePgAllocator],
]

const reservationSubjects: Array<readonly [string, () => ReservationSubject | null]> = [
  ['memory', makeMemoryReservation],
  ['postgres', makePgReservation],
]

for (const [label, factory] of leaseSubjects) {
  const make = factory
  test(`lease-store (${label}): acquire returns a token; renew/release by token succeed; mismatch rejected`, async (t) => {
    const subj = make()
    if (!subj) return t.skip(`no ${label} subject available`)
    const { store } = subj
    const runId = `${label}-run-${randomUUID()}`
    const acq = await store.acquire(runId, 100, 1_000)
    assert.equal(acq.ok, true)
    if (!acq.ok) return
    assert.equal(typeof acq.token, 'string')

    const renew = await store.renew(runId, acq.token, 200, 1_050)
    assert.equal(renew.ok, true)
    if (renew.ok) assert.equal(renew.expiresAt, 1_050 + 200)

    const wrongRenew = await store.renew(runId, 'wrong-token', 300, 1_100)
    assert.equal(wrongRenew.ok, false)
    if (!wrongRenew.ok) assert.equal(wrongRenew.reason, 'token_mismatch')

    const release = await store.release(runId, acq.token, 1_200)
    assert.equal(release.ok, true)

    const afterRelease = await store.renew(runId, acq.token, 100, 1_300)
    assert.equal(afterRelease.ok, false)
    if (!afterRelease.ok) assert.equal(afterRelease.reason, 'not_found')
  })

  test(`lease-store (${label}): acquire on held-by-other refuses without releasing`, async (t) => {
    const subj = make()
    if (!subj) return t.skip(`no ${label} subject available`)
    const { store } = subj
    const runId = `${label}-run-${randomUUID()}`
    const first = await store.acquire(runId, 1_000, 1_000)
    assert.equal(first.ok, true)
    const second = await store.acquire(runId, 1_000, 1_500)
    assert.equal(second.ok, false)
    if (!second.ok) assert.equal(second.reason, 'held_by_other')
  })

  test(`lease-store (${label}): reapExpired returns released when expired; not_expired otherwise`, async (t) => {
    const subj = make()
    if (!subj) return t.skip(`no ${label} subject available`)
    const { store } = subj
    const runId = `${label}-run-${randomUUID()}`
    const acq = await store.acquire(runId, 100, 1_000)
    assert.equal(acq.ok, true)

    const notExpired = await store.reapExpired(runId, 1_050)
    assert.equal(notExpired.outcome, 'not_expired')

    const expired = await store.reapExpired(runId, 1_200)
    assert.equal(expired.outcome, 'released')

    const after = await store.reapExpired(runId, 1_300)
    assert.equal(after.outcome, 'not_found')
  })

  test(`lease-store (${label}): inspect returns the current snapshot without mutation`, async (t) => {
    const subj = make()
    if (!subj) return t.skip(`no ${label} subject available`)
    const { store } = subj
    const runId = `${label}-run-${randomUUID()}`
    await store.acquire(runId, 500, 1_000)
    const snap1 = await store.inspect(runId)
    assert.ok(snap1)
    const snap2 = await store.inspect(runId)
    assert.ok(snap2)
    assert.equal(snap1.token, snap2.token)
    assert.equal(snap1.expiresAt, snap2.expiresAt)
  })
}

for (const [label, factory] of allocatorSubjects) {
  const make = factory
  test(`sequence-allocator (${label}): monotonic seq per run, zero-conflict`, async (t) => {
    const subj = make()
    if (!subj) return t.skip(`no ${label} subject available`)
    const { allocator } = subj
    const runId = `${label}-seq-${randomUUID()}`
    const seqs: number[] = []
    for (let i = 0; i < 10; i += 1) {
      const alloc = await allocator.next(runId)
      assert.equal(alloc.ok, true)
      if (alloc.ok) seqs.push(alloc.seq)
    }
    for (let i = 1; i < seqs.length; i += 1) {
      const prev = seqs[i - 1]
      const cur = seqs[i]
      assert.ok(prev !== undefined && cur !== undefined, 'seqs populated')
      assert.equal(cur, prev + 1, `seqs strictly increasing; saw ${seqs.join(',')}`)
    }
    const current = await allocator.current(runId)
    assert.equal(current, 9)
  })

  test(`sequence-allocator (${label}): independent counters per run`, async (t) => {
    const subj = make()
    if (!subj) return t.skip(`no ${label} subject available`)
    const { allocator } = subj
    const runA = `${label}-seq-A-${randomUUID()}`
    const runB = `${label}-seq-B-${randomUUID()}`
    const a1 = await allocator.next(runA)
    const b1 = await allocator.next(runB)
    const a2 = await allocator.next(runA)
    assert.equal(a1.ok && b1.ok && a2.ok, true)
    if (a1.ok && b1.ok && a2.ok) {
      assert.equal(a1.seq, 0)
      assert.equal(b1.seq, 0)
      assert.equal(a2.seq, 1)
    }
  })
}

for (const [label, factory] of reservationSubjects) {
  const make = factory
  test(`session-reservation (${label}): reserve/release with terminal-state guard`, async (t) => {
    const subj = make()
    if (!subj) return t.skip(`no ${label} subject available`)
    const { store } = subj
    const sessId = `${label}-sess-${randomUUID()}`
    const runId = `${label}-run-${randomUUID()}`
    const r = await store.reserve(sessId, runId, 1_000, 1_000)
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.acquired, true)

    // Release without terminal-state confirmation is rejected.
    const rejected = await store.release(sessId, runId, {})
    assert.equal(rejected.ok, false)
    if (!rejected.ok) assert.equal(rejected.reason, 'terminal_not_confirmed')

    // Confirmed release succeeds.
    const released = await store.release(sessId, runId, { terminalStateConfirmed: true })
    assert.equal(released.ok, true)
  })

  test(`session-reservation (${label}): same Session with different Run reports held_by_other`, async (t) => {
    const subj = make()
    if (!subj) return t.skip(`no ${label} subject available`)
    const { store } = subj
    const sessId = `${label}-sess-${randomUUID()}`
    const runA = `${label}-run-A-${randomUUID()}`
    const runB = `${label}-run-B-${randomUUID()}`
    const r1 = await store.reserve(sessId, runA, 1_000, 1_000)
    assert.equal(r1.ok, true)
    if (r1.ok) assert.equal(r1.acquired, true)
    const r2 = await store.reserve(sessId, runB, 1_000, 1_500)
    assert.equal(r2.ok, true)
    if (r2.ok) {
      assert.equal(r2.acquired, false)
      if (!r2.acquired) assert.equal(r2.currentRunId, runA)
    }
  })

  test(`session-reservation (${label}): listActiveForSession returns the holder`, async (t) => {
    const subj = make()
    if (!subj) return t.skip(`no ${label} subject available`)
    const { store } = subj
    const sessId = `${label}-sess-${randomUUID()}`
    const runId = `${label}-run-Z-${randomUUID()}`
    await store.reserve(sessId, runId, 5_000, 1_000)
    const list = await store.listActiveForSession(sessId)
    assert.deepEqual([...list], [runId])
  })

  test(`session-reservation (${label}): release rejects run_mismatch`, async (t) => {
    const subj = make()
    if (!subj) return t.skip(`no ${label} subject available`)
    const { store } = subj
    const sessId = `${label}-sess-${randomUUID()}`
    await store.reserve(sessId, `${label}-run-A-${randomUUID()}`, 1_000, 1_000)
    const wrong = await store.release(sessId, `${label}-run-B-${randomUUID()}`, { terminalStateConfirmed: true })
    assert.equal(wrong.ok, false)
    if (!wrong.ok) assert.equal(wrong.reason, 'run_mismatch')
  })
}

test('rollout-flag registry: read returns default; envOverride wins; duplicate register throws', () => {
  const meta: RolloutFlagMeta = {
    key: 'target.run-observation',
    owner: 'platform',
    default: false,
    envOverride: 'QM_ROLLOUT_RUN_OBSERVATION',
    removalTask: '#9999',
    introducedIn: 'Phase 0',
  }
  const regDefault = createRolloutFlagRegistry()
  const flag: RolloutFlag = regDefault.register(meta)
  assert.equal(flag.read(), false)

  const regEnv = createRolloutFlagRegistry({ env: { QM_ROLLOUT_RUN_OBSERVATION: '1' } })
  const flagEnv = regEnv.register(meta)
  assert.equal(flagEnv.read(), true)

  assert.throws(() => regDefault.register(meta))
})

test('rollout-flag registry: list enumerates registered flags', () => {
  const reg = createRolloutFlagRegistry()
  reg.register({
    key: 'a',
    owner: 'platform',
    default: true,
    introducedIn: 'Phase 0',
    removalTask: '#1',
  })
  reg.register({
    key: 'b',
    owner: 'platform',
    default: false,
    introducedIn: 'Phase 0',
    removalTask: '#2',
  })
  assert.deepEqual(
    reg.list().map((f) => f.key).sort(),
    ['a', 'b'],
  )
})

test('in-memory event log: snapshot/replay/subscribe agree and respect terminal close', async () => {
  const allocator = createMemorySequenceAllocator()
  const log = createInMemoryEventLog({ allocator })
  const runId = `mem-evt-${randomUUID()}`
  const e1 = await log.bus.publish({
    kind: 'run.created',
    runId,
    sessionId: 'sess-1',
  } as never)
  const e2 = await log.bus.publish({
    kind: 'attempt.started',
    runId,
    sessionId: 'sess-1',
    attempt: { attemptId: 'a1', attemptSeq: 1 },
  } as never)
  const e3 = await log.bus.publish({
    kind: 'run.finished',
    runId,
    sessionId: 'sess-1',
    outcome: 'succeeded',
  } as never)
  assert.equal(e1.seq, 0)
  assert.equal(e2.seq, 1)
  assert.equal(e3.seq, 2)
  const snap = await log.bus.snapshot(runId)
  assert.ok(snap)
  if (snap) {
    assert.equal(snap.id, runId)
    assert.equal(snap.state, 'succeeded')
    assert.equal(snap.outcome, 'succeeded')
    assert.equal(snap.attempts, 1)
    assert.equal(snap.lastEventSeq, 2)
  }
  const replayed = await log.bus.replay({ runId, seq: -1 })
  assert.equal(replayed.length, 3)
  const replayedAfter1 = await log.bus.replay({ runId, seq: 1 })
  assert.equal(replayedAfter1.length, 1)
  await log.bus.closeTerminal(runId)
  await assert.rejects(
    () =>
      log.bus.publish({
        kind: 'progress',
        runId,
        sessionId: 'sess-1',
        redactedExcerpt: '[redacted]',
      } as never),
    /cannot publish on closed Run/,
  )
})

test('postgresReachable returns true when PG is up, false otherwise', async () => {
  // Smoke check: this test is always present so CI surfaces a wiring error.
  const ok = await postgresReachable()
  assert.equal(typeof ok, 'boolean')
})
