/**
 * Phase 1 Run Event Log contract suite.
 *
 * Asserts that the in-memory and Postgres implementations of the
 * Target Run Event Bus produce bit-identical observable behavior
 * given the same logical operations. The Postgres leg is skipped
 * when QM_NEXT_PG_URL is unset; CI exports it.
 *
 * Linked ADRs: ADR-0001, ADR-0013, ADR-0014.
 */
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { createInMemoryEventLog } from '@qm/concurrency'
import { createMemorySequenceAllocator, createPostgresSequenceAllocator } from '@qm/concurrency'
import { createPostgresRunEventLog } from '../src/postgres-run-event-log.ts'
import type { TargetRunEvent, TargetRunEventBus } from '@qm/types'

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

interface EventLogSubject {
  bus: TargetRunEventBus
  close?: () => Promise<void>
}

function makeMemorySubject(): EventLogSubject {
  const log = createInMemoryEventLog({
    allocator: createMemorySequenceAllocator(),
  })
  return { bus: log.bus }
}

async function makePgSubject(): Promise<EventLogSubject | null> {
  if (!pgUrl) return null
  const log = createPostgresRunEventLog({
    connectionString: pgUrl,
    allocator: createPostgresSequenceAllocator({ connectionString: pgUrl }),
  })
  return { bus: log.bus }
}

test('run-event-log (memory): monotonic per-Run seq; terminal close blocks further publish', async () => {
  const subj = makeMemorySubject()
  const bus = subj.bus
  const runId = `mem-run-${randomUUID()}`
  const e1 = await bus.publish({ kind: 'run.created', runId, sessionId: 'sess-A' } as never)
  const e2 = await bus.publish({ kind: 'attempt.started', runId, sessionId: 'sess-A', attempt: { attemptId: 'a1', attemptSeq: 1 } } as never)
  const e3 = await bus.publish({ kind: 'run.finished', runId, sessionId: 'sess-A', outcome: 'succeeded' } as never)
  assert.equal(e1.seq, 0)
  assert.equal(e2.seq, 1)
  assert.equal(e3.seq, 2)
  await bus.closeTerminal(runId)
  await assert.rejects(
    () => bus.publish({ kind: 'progress', runId, sessionId: 'sess-A', redactedExcerpt: '[x]' } as never),
    /cannot publish on closed Run/,
  )
})

test('run-event-log (memory): snapshot + replay agree; subscribe replays then delivers live', async () => {
  const subj = makeMemorySubject()
  const bus = subj.bus
  const runId = `mem-replay-${randomUUID()}`
  const events: TargetRunEvent[] = []
  for (let i = 0; i < 3; i += 1) {
    events.push(
      await bus.publish({
        kind: 'attempt.started',
        runId,
        sessionId: 'sess-A',
        attempt: { attemptId: `a${i}`, attemptSeq: i + 1 },
      } as never),
    )
  }
  const snap = await bus.snapshot(runId)
  assert.ok(snap)
  if (snap) {
    assert.equal(snap.id, runId)
    assert.equal(snap.attempts, 3)
    assert.equal(snap.lastEventSeq, 2)
  }
  const replay = await bus.replay({ runId, seq: -1 })
  assert.equal(replay.length, 3)
  const replayAfter1 = await bus.replay({ runId, seq: 1 })
  assert.equal(replayAfter1.length, 1)
  const received: TargetRunEvent[] = []
  const unsub = bus.subscribe({ runId, seq: -1 }, (e) => {
    received.push(e)
  })
  await new Promise((r) => setTimeout(r, 10))
  await bus.publish({ kind: 'progress', runId, sessionId: 'sess-A', redactedExcerpt: '[live]' } as never)
  await new Promise((r) => setTimeout(r, 10))
  unsub()
  assert.ok(received.length >= 4)
})

test('run-event-log (postgres, skipped without PG): same shape when PG is up', async (t) => {
  const ok = await postgresReachable()
  if (!ok) return t.skip('QM_NEXT_PG_URL not reachable')
  const subj = await makePgSubject()
  if (!subj) return t.skip('no PG subject')
  const bus = subj.bus
  const runId = `pg-run-${randomUUID()}`
  const e1 = await bus.publish({ kind: 'run.created', runId, sessionId: 'sess-PG' } as never)
  const e2 = await bus.publish({ kind: 'attempt.started', runId, sessionId: 'sess-PG', attempt: { attemptId: 'a1', attemptSeq: 1 } } as never)
  assert.equal(e1.seq, 0)
  assert.equal(e2.seq, 1)
  await subj.close?.()
})

test('run-event-log: memory and Postgres both reject publish after terminal', async (t) => {
  const ok = await postgresReachable()
  if (!ok) return t.skip('QM_NEXT_PG_URL not reachable')
  const mem = makeMemorySubject()
  const pg = await makePgSubject()
  if (!pg) return t.skip('no PG subject')
  const memRun = `mem-end-${randomUUID()}`
  const pgRun = `pg-end-${randomUUID()}`
  await mem.bus.publish({ kind: 'run.finished', runId: memRun, sessionId: 's', outcome: 'succeeded' } as never)
  await pg.bus.publish({ kind: 'run.finished', runId: pgRun, sessionId: 's', outcome: 'succeeded' } as never)
  await mem.bus.closeTerminal(memRun)
  await pg.bus.closeTerminal(pgRun)
  await assert.rejects(
    () => mem.bus.publish({ kind: 'progress', runId: memRun, sessionId: 's', redactedExcerpt: 'x' } as never),
    /cannot publish on closed Run/,
  )
  await pg.close?.()
})