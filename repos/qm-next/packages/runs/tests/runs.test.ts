/**
 * Runs depth: signal/activity/state stores, turn stream, worker, reaper,
 * drain and instance registry over the memory implementations; Postgres
 * cases activate when QM_NEXT_PG_URL points at a reachable server.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import {
  createDrainController,
  createEcsTaskProtection,
  createMemoryRunActivityStore,
  createMemoryRunSignalStore,
  createMemorySessionStateBus,
  createNoopInstanceRegistry,
  createNullLedger,
  createPostgresInstanceRegistry,
  createPostgresRunActivityStore,
  createPostgresRunSignalStore,
  createPostgresSessionStateBus,
  createReaper,
  createTurnStream,
  createWorker,
  encodeWirePayload,
  processRun,
  RUN_ACTIVITY_TTL_MS,
  startSignalPoll,
} from '@qm/runs'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { Orchestrator, RunSignalStore, TurnInput, TurnResult } from '@qm/types'

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

function turnInput(text: string, overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    surface: 'api',
    actor: { type: 'internal', id: 'tester' },
    conversation: { kind: 'dm', threadRef: 'thread-1', audience: [] },
    origin: { kind: 'direct' },
    text,
    ...overrides,
  }
}

function okOrchestrator(result: Partial<TurnResult> = {}): Orchestrator & { calls: TurnInput[] } {
  const calls: TurnInput[] = []
  return {
    calls,
    async handleTurn(input: TurnInput) {
      calls.push(input)
      return { status: 'ok', reply: 'done', ...result }
    },
  }
}

test('memory run-signal store: send/take ordering, pending ids, live notification', async () => {
  const store = createMemoryRunSignalStore()
  let notified = 0
  const off = store.onSignal('run-1', () => {
    notified += 1
  })
  await store.send('run-1', { kind: 'steer', text: 'first' })
  assert.equal(notified, 1)
  await store.send('run-1', { kind: 'steer', text: 'second' })
  await store.send('run-2', { kind: 'abort' })
  assert.deepEqual(await store.pendingRunIds().then((ids) => ids.sort()), ['run-1', 'run-2'])
  const taken = await store.takePending('run-1')
  assert.deepEqual(taken.map((s) => s.text), ['first', 'second'])
  assert.deepEqual(await store.takePending('run-1'), [])
  assert.equal((await store.takePending('run-2'))[0]?.kind, 'abort')
  off()
  await store.send('run-1', { kind: 'steer', text: 'third' })
  assert.equal(notified, 2, 'unsubscribed listener sees nothing new')
  assert.deepEqual(await store.takePending('run-1').then((s) => s.map((x) => x.text)), ['third'])
})

test('startSignalPoll drains steer/abort and settles after stop with drainOnStop', async () => {
  const pending: Array<{ kind: string; text?: string; ts?: string }> = []
  const silent: RunSignalStore = {
    async send(_runId, signal) {
      pending.push(signal)
    },
    async takePending() {
      return pending.splice(0)
    },
    async pendingRunIds() {
      return pending.length ? ['run-9'] : []
    },
    async prune() {},
    onSignal: () => () => undefined,
  }
  const seen: string[] = []
  let aborted = 0
  const stop = startSignalPoll(
    silent,
    'run-9',
    {
      onSteer: async (text) => {
        seen.push(text)
      },
      onAbort: async () => {
        aborted += 1
      },
    },
    { intervalMs: 20, drainOnStop: true },
  )
  await silent.send('run-9', { kind: 'steer', text: 'a', ts: 't1' })
  await silent.send('run-9', { kind: 'steer', text: 'b' })
  await silent.send('run-9', { kind: 'abort' })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.deepEqual(seen, ['a', 'b'])
  await silent.send('run-9', { kind: 'abort' })
  await stop()
  assert.equal(aborted, 2, 'the interval consumed one abort, drainOnStop flushed the last one')
})

test('startSignalPoll redrains signals that arrive mid-drain', async () => {
  const store = createMemoryRunSignalStore()
  const seen: string[] = []
  let aborted = 0
  const stop = startSignalPoll(
    store,
    'run-7',
    {
      onSteer: async (text) => {
        seen.push(text)
      },
      onAbort: async () => {
        aborted += 1
      },
    },
    { intervalMs: 500 },
  )
  await store.send('run-7', { kind: 'steer', text: 'one' })
  await store.send('run-7', { kind: 'steer', text: 'two' })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(seen, ['one', 'two'])
  await store.send('run-7', { kind: 'abort' })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(aborted, 1)
  await stop()
})

test('memory run-activity store: append/list, per-run cap, TTL prune', async () => {
  let now = 1_000_000
  const store = createMemoryRunActivityStore(() => now)
  for (let i = 0; i < 2_050; i++) {
    await store.append('run-a', { seq: i, parentSeq: i > 0 ? i - 1 : null, type: 't', payload: { i }, createdAt: now })
  }
  const list = await store.list('run-a')
  assert.equal(list.length, 2_000)
  assert.equal(list[0]?.seq, 0, 'cap keeps the oldest entries and drops later appends')
  now += RUN_ACTIVITY_TTL_MS + 1
  await store.append('run-b', { seq: 0, parentSeq: null, type: 't', payload: null, createdAt: now })
  assert.deepEqual(await store.list('run-a'), [])
  assert.equal((await store.list('run-b')).length, 1)
})

test('memory session-state bus: subscribe/emit/unsubscribe', () => {
  const bus = createMemorySessionStateBus()
  const seen: string[] = []
  const off = bus.subscribe((e) => seen.push(e.state))
  bus.emit({ threadRef: 't1', state: 'working', at: 1 })
  bus.emit({ threadRef: 't1', state: 'idle', at: 2 })
  off()
  bus.emit({ threadRef: 't1', state: 'working', at: 3 })
  assert.deepEqual(seen, ['working', 'idle'])
})

test('turn-stream: first-block gating, snapshot cap, surface-posted listeners, end grace', async () => {
  const stream = createTurnStream({ maxChars: 20, graceMs: 10 })
  const firstBlocks: string[] = []
  const posted: number[] = []
  const off = stream.subscribe('r', {
    onFirstBlock: (text) => firstBlocks.push(text),
    onSurfacePosted: () => posted.push(1),
  })
  assert.equal(stream.alive('r'), false)
  stream.begin('r')
  assert.equal(stream.alive('r'), true)
  stream.publish('r', 'hello ')
  stream.publish('r', 'world')
  stream.noteToolCall('r')
  assert.deepEqual(firstBlocks, ['hello world'])
  assert.deepEqual(stream.firstBlock('r'), { text: 'hello world', closed: true })
  stream.publish('r', ' more text that keeps going beyond the cap')
  assert.ok((stream.snapshot('r') ?? '').length <= 20)
  stream.markSurfacePosted('r')
  assert.equal(posted.length, 1)
  assert.equal(stream.surfacePosted('r'), true)
  stream.end('r')
  assert.equal(stream.alive('r'), false)
  assert.ok(stream.snapshot('r'), 'snapshot survives through the grace window')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(stream.snapshot('r'), null)
  off()
})

test('null tool ledger never caches', async () => {
  const ledger = createNullLedger()
  assert.deepEqual(await ledger.begin('r', 0, 0), { cached: false })
  await ledger.record('r', 0, 0, 'out')
})

test('worker: claims, heartbeats, completes and drains over the memory run store', async () => {
  const runs = createMemoryRunStore()
  const sessions = createMemorySessionStore()
  const orchestrator = okOrchestrator()
  const worker = createWorker({
    runs,
    sessions,
    orchestrator,
    leaseTtlMs: 5_000,
    heartbeatIntervalMs: 50,
    pollMs: 5,
  })
  const { run } = await runs.enqueue({ sessionId: 'sess-w', request: turnInput('do it') })
  worker.start()
  const finished = await runs.waitFor(run.id, 5_000)
  assert.equal(finished.status, 'done')
  assert.equal(finished.result?.reply, 'done')
  const handled = orchestrator.calls[0]!
  assert.equal(handled.runId, run.id)
  assert.equal(handled.background, true)
  assert.equal(typeof handled.attempt, 'number')
  worker.stop()
})

test('worker: processRun fails the run on orchestrator error with retry classification', async () => {
  const runs = createMemoryRunStore()
  const { run } = await runs.enqueue({ sessionId: 'sess-f', request: turnInput('boom'), maxAttempts: 1 })
  const claimed = await runs.claim('w-f', 5_000)
  assert.ok(claimed)
  const failing: Orchestrator = {
    async handleTurn() {
      throw new Error('kaboom')
    },
  }
  await assert.rejects(
    processRun({ runs, orchestrator: failing, leaseTtlMs: 5_000, heartbeatIntervalMs: 50 }, claimed),
    /kaboom/,
  )
  const failed = await runs.waitFor(run.id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.result?.reason ?? '', /kaboom/)
})

test('worker: canClaim gate blocks claiming while draining', async () => {
  const runs = createMemoryRunStore()
  const sessions = createMemorySessionStore()
  const orchestrator = okOrchestrator()
  const worker = createWorker({
    runs,
    sessions,
    orchestrator,
    leaseTtlMs: 5_000,
    pollMs: 5,
    canClaim: () => false,
  })
  await runs.enqueue({ sessionId: 'sess-g', request: turnInput('held') })
  worker.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(orchestrator.calls.length, 0)
  await worker.stop()
})

test('reaper: requeues expired leases and releases stranded session leases', async () => {
  const runs = createMemoryRunStore()
  const sessions = createMemorySessionStore()
  const { run } = await runs.enqueue({ sessionId: 'sess-r', request: turnInput('stuck') })
  await runs.claim('w-stuck', 30)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const reaper = createReaper(runs, sessions, { intervalMs: 10_000 })
  const counts = await reaper.sweep()
  assert.equal(counts.requeued, 1)
  const again = await runs.claim('w-again', 5_000)
  assert.ok(again)
  assert.equal(again.id, run.id)
})

test('drain controller: noop registry keeps claims open, protection toggles with busy', async () => {
  const protectionCalls: boolean[] = []
  const protection = { set: async (enabled: boolean) => void protectionCalls.push(enabled) }
  const drain = createDrainController({
    registry: createNoopInstanceRegistry(),
    protection,
    busy: () => false,
    sweepMs: 10,
  })
  drain.start()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(drain.canClaim(), true)
  drain.noteBusy()
  await new Promise((resolve) => setTimeout(resolve, 10))
  drain.stop()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(protectionCalls, [true, false])
})

test('task-protection PUTs the state shape through the injected fetch', async () => {
  const bodies: unknown[] = []
  const protection = createEcsTaskProtection('http://agent.local/', {
    fetchFn: (async (_url: string | URL | globalThis.Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response('{}', { status: 200 })
    }) as typeof fetch,
  })
  await protection.set(true)
  await protection.set(false)
  assert.deepEqual(bodies, [
    { ProtectionEnabled: true, ExpiresInMinutes: 60 },
    { ProtectionEnabled: false },
  ])
})

test('postgres session-state wire payload sheds participants before dropping', () => {
  const big = 'x'.repeat(8_000)
  const shadable = { threadRef: 't', participants: [big], state: 'working' as const, at: 1 }
  const payload = encodeWirePayload(shadable)
  assert.ok(payload, 'the shed payload still fits the wire cap')
  assert.ok(!payload.includes('"participants"'), 'participants are shed under pressure')
  const oversized = { threadRef: big, participants: [big], state: 'working' as const, at: 1 }
  assert.equal(encodeWirePayload(oversized), null, 'even the shed payload exceeds the wire cap')
  assert.equal(
    encodeWirePayload({ threadRef: 't', state: 'idle', at: 1 }),
    JSON.stringify({ threadRef: 't', state: 'idle', at: 1 }),
  )
})

test('postgres run-signal store: roundtrip + prune', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  if (!(await postgresReachable())) return t.skip('postgres unreachable at QM_NEXT_PG_URL')
  const store = createPostgresRunSignalStore(pgUrl!)
  try {
    let notified = 0
    const off = store.onSignal('pg-run', () => {
      notified += 1
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await store.send('pg-run', { kind: 'steer', text: 'one' })
    await store.send('pg-run', { kind: 'steer', text: 'two' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(notified >= 1)
    const taken = await store.takePending('pg-run')
    assert.deepEqual(taken.map((s) => s.text), ['one', 'two'])
    await store.send('pg-run', { kind: 'abort' })
    assert.deepEqual(await store.pendingRunIds(), ['pg-run'])
    await store.prune(0)
    assert.deepEqual(await store.takePending('pg-run').then((s) => s.map((x) => x.kind)), ['abort'])
    off()
  } finally {
    await store.close?.()
  }
})

test('postgres run-activity store: append/list + close', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  if (!(await postgresReachable())) return t.skip('postgres unreachable at QM_NEXT_PG_URL')
  const store = createPostgresRunActivityStore(pgUrl!)
  try {
    await store.append('pg-act', { seq: 0, parentSeq: null, type: 'delta', payload: { text: 'a' }, createdAt: 1 })
    await store.append('pg-act', { seq: 1, parentSeq: 0, type: 'delta', payload: { text: 'b' }, createdAt: 2 })
    const rows = await store.list('pg-act')
    assert.deepEqual(
      rows.map((r) => [r.seq, r.parentSeq, (r.payload as { text: string }).text]),
      [
        [0, null, 'a'],
        [1, 0, 'b'],
      ],
    )
  } finally {
    await store.close?.()
  }
})

test('postgres session-state bus: emit reaches subscribers cross-connection', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  if (!(await postgresReachable())) return t.skip('postgres unreachable at QM_NEXT_PG_URL')
  const bus = createPostgresSessionStateBus(pgUrl!)
  try {
    const seen: string[] = []
    bus.subscribe((e) => seen.push(e.state))
    await new Promise((resolve) => setTimeout(resolve, 100))
    bus.emit({ threadRef: 'pg-thread', state: 'working', at: Date.now() })
    for (let i = 0; i < 40 && seen.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(seen, ['working'])
  } finally {
    await bus.close?.()
  }
})

test('postgres instance registry: beats and supersession', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  if (!(await postgresReachable())) return t.skip('postgres unreachable at QM_NEXT_PG_URL')
  const { createPgPool } = await import('@qm/store')
  const pg = createPgPool(pgUrl!, [])
  const startedAt = Date.now()
  const old = createPostgresInstanceRegistry(pg, { instanceId: 'inst-old', buildSha: 'sha-old', startedAt: startedAt - 1_000 })
  const newer = createPostgresInstanceRegistry(pg, { instanceId: 'inst-new', buildSha: 'sha-new', startedAt: startedAt + 1_000 })
  try {
    assert.equal(await newer.beat(), false, 'newer build sees no supersessor')
    assert.equal(await old.beat(), true, 'older build sees the newer live build')
  } finally {
    await pg.close()
  }
})
