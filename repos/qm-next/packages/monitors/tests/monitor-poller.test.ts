/**
 * Monitor poller contract tests: arm → tick → fire → cursor advance →
 * sweep, against a fake process registry + gate and a recording fire
 * engine. Mirrors qm's poller semantics (fireKey vocabulary, quiet
 * heartbeat, min-fire interval, fan-out cap, exit sweep).
 *
 * The fake clock sits slightly above the real `Date.now()` so it always
 * outruns the store-stamped `createdAt` without skewing the heartbeat
 * arithmetic.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMemoryMonitorStore,
  createMonitorPoller,
  type Monitor,
  type MonitorFireEngine,
  type MonitorPollerDeps,
  type MonitorProcessGate,
  type MonitorProcessLookup,
} from '../src/index.ts'

const BASE = Date.now() + 2_000

const first = <T>(items: T[]): T => items[0] as T

interface FakeRecord {
  processId: string
  scopeId: string
}

interface ScriptedRead {
  chunks: string
  cursor: number
  status: { state: 'running' } | { state: 'exited'; code: number }
}

interface Submitted {
  fireKey: string
  text: string
  ownerId: string
  scopeId?: string
}

function harness(overrides?: {
  records?: FakeRecord[]
  reads?: Map<string, ScriptedRead[]>
  heartbeatMs?: number
  minFireIntervalMs?: number
  maxFiresPerTick?: number
}) {
  const store = createMemoryMonitorStore()
  const records = new Map<string, FakeRecord>(
    (overrides?.records ?? [{ processId: 'proc-1', scopeId: 'org:test' }]).map((r) => [r.processId, r]),
  )
  const reads = overrides?.reads ?? new Map<string, ScriptedRead[]>()
  const submitted: Submitted[] = []
  const markStatused: string[] = []
  const readQueue = new Map(reads)
  let clock = 0
  const fire: MonitorFireEngine = {
    submit: async (spec) => {
      submitted.push({
        fireKey: spec.fireKey,
        text: spec.text,
        ownerId: spec.ownerId,
        ...(spec.scopeId ? { scopeId: spec.scopeId } : {}),
      })
    },
  }
  const processes: MonitorProcessLookup = {
    get: async (processId) => records.get(processId) ?? null,
    markStatus: async (processId) => {
      markStatused.push(processId)
    },
  }
  const gate: MonitorProcessGate = {
    provision: async (scopeId) => ({ scopeId }),
    release: async () => {},
    read: async (_handle, processId, opts) => {
      const queue = readQueue.get(processId)
      if (!queue) throw new Error('no scripted read')
      const next = queue.shift() ?? { chunks: '', cursor: opts.sinceCursor ?? 0, status: { state: 'running' as const } }
      return next
    },
  }
  const errors: string[] = []
  const deps: MonitorPollerDeps = {
    monitors: {
      ...store,
      recordError: async (id: string, error: string) => {
        errors.push(`${id}: ${error}`)
        await store.recordError(id, error)
      },
    },
    processes,
    gate,
    fire,
    now: () => BASE + clock,
    ...(overrides?.heartbeatMs !== undefined ? { heartbeatMs: overrides.heartbeatMs } : {}),
    ...(overrides?.minFireIntervalMs !== undefined ? { minFireIntervalMs: overrides.minFireIntervalMs } : {}),
    ...(overrides?.maxFiresPerTick !== undefined ? { maxFiresPerTick: overrides.maxFiresPerTick } : {}),
  }
  const poller = createMonitorPoller(deps)
  async function arm(fields?: Partial<Monitor>): Promise<Monitor> {
    clock += 1
    return store.create({
      owner: 'person:ada',
      createdBy: 'person:ada',
      ownerScopeId: 'org:test',
      processId: 'proc-1',
      command: 'tail -f build.log',
      threadRef: 'thread:watch-1',
      expiresAt: BASE + 100_000,
      ...fields,
    })
  }
  return {
    poller,
    store,
    submitted,
    markStatused,
    errors,
    arm,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

test('new output fires with the cursor fireKey and advances the cursor', async () => {
  const h = harness({ reads: new Map([['proc-1', [{ chunks: 'build done\n', cursor: 42, status: { state: 'running' } }]]]) })
  const created = await h.arm({ cursor: 0 })
  await h.poller.tick()
  assert.equal(h.submitted.length, 1)
  assert.equal(first(h.submitted).fireKey, `monitor:${created.id}:0`)
  assert.match(first(h.submitted).text, /It produced new output\./)
  assert.match(first(h.submitted).text, /<output>\nbuild done/)
  assert.equal(first(h.submitted).ownerId, 'person:ada')
  assert.equal(first(h.submitted).scopeId, 'org:test')
  const after = await h.store.get(created.id)
  assert.equal(after?.cursor, 42)
  assert.equal(after?.lastFiredAt, BASE + 1)
  h.advance(1)
  await h.poller.tick()
  assert.equal(h.submitted.length, 1, 'no refire for already-consumed output')
})

test('pattern filters event lines but keeps matching ones', async () => {
  const h = harness({
    reads: new Map([['proc-1', [{ chunks: 'blah\nERROR disk full\nblah\n', cursor: 7, status: { state: 'running' } }]]]),
  })
  await h.arm({ pattern: '^ERROR' })
  await h.poller.tick()
  assert.equal(h.submitted.length, 1)
  assert.match(first(h.submitted).text, /ERROR disk full/)
  assert.doesNotMatch(first(h.submitted).text, /\nblah\n/)
})

test('quiet heartbeat fires after the heartbeat window with no new output', async () => {
  const h = harness({ heartbeatMs: 60_000, reads: new Map([['proc-1', [{ chunks: '', cursor: 0, status: { state: 'running' } }]]]) })
  await h.arm()
  await h.poller.tick()
  assert.equal(h.submitted.length, 0, 'inside the heartbeat window')
  h.advance(61_000)
  await h.poller.tick()
  assert.equal(h.submitted.length, 1)
  assert.match(first(h.submitted).fireKey, /:quiet:\d+$/)
  assert.match(first(h.submitted).text, /still running — just nothing wake-worthy/)
})

test('min-fire interval suppresses rapid refires', async () => {
  const h = harness({
    minFireIntervalMs: 60_000,
    reads: new Map([
      [
        'proc-1',
        [
          { chunks: 'one\n', cursor: 5, status: { state: 'running' } },
          { chunks: 'two\n', cursor: 9, status: { state: 'running' } },
          { chunks: 'two\n', cursor: 9, status: { state: 'running' } },
        ],
      ],
    ]),
  })
  const created = await h.arm({ cursor: 0 })
  // lastFiredAt is not a CreateMonitorInput field; the memory store holds
  // this object by reference, so mutate it directly.
  created.lastFiredAt = BASE
  await h.poller.tick()
  assert.equal(h.submitted.length, 0, 'fired too recently')
  h.advance(1)
  await h.poller.tick()
  assert.equal(h.submitted.length, 0, 'still inside the interval')
  h.advance(61_000)
  await h.poller.tick()
  assert.equal(h.submitted.length, 1)
  assert.ok(first(h.submitted).fireKey.endsWith(':0'), 'fires on the stored cursor')
})

test('exit fires the :exit key, disables the watch, and marks the process', async () => {
  const h = harness({ reads: new Map([['proc-1', [{ chunks: 'bye\n', cursor: 3, status: { state: 'exited', code: 2 } }]]]) })
  const created = await h.arm({ cursor: 0 })
  await h.poller.tick()
  assert.equal(h.submitted.length, 1)
  assert.equal(first(h.submitted).fireKey, `monitor:${created.id}:exit`)
  assert.match(first(h.submitted).text, /exited with code 2/)
  assert.deepEqual(h.markStatused, ['proc-1'])
  const after = await h.store.get(created.id)
  assert.equal(after?.enabled, false)
  h.advance(1)
  await h.poller.tick()
  assert.equal(h.submitted.length, 1, 'disabled watches do not fire')
})

test('expiry fires :expired and disables without marking the process', async () => {
  const h = harness({ reads: new Map([['proc-1', [{ chunks: '', cursor: 0, status: { state: 'running' } }]]]) })
  await h.arm({ expiresAt: BASE })
  await h.poller.tick()
  assert.equal(h.submitted.length, 1)
  assert.match(first(h.submitted).fireKey, /:expired$/)
  assert.deepEqual(h.markStatused, [])
  assert.equal(first(await h.store.list()).enabled, false)
})

test('a missing process record reports lost and disables the watch', async () => {
  const h = harness({ records: [] })
  const created = await h.arm()
  await h.poller.tick()
  assert.equal(h.submitted.length, 1)
  assert.equal(first(h.submitted).fireKey, `monitor:${created.id}:lost`)
  assert.equal((await h.store.get(created.id))?.enabled, false)
})

test('fan-out is capped at maxFiresPerTick', async () => {
  const reads = new Map<string, ScriptedRead[]>()
  const records: FakeRecord[] = []
  for (let i = 0; i < 5; i++) {
    records.push({ processId: `p${i}`, scopeId: 'org:test' })
    reads.set(`p${i}`, [{ chunks: `out ${i}\n`, cursor: 1, status: { state: 'running' } }])
  }
  const h = harness({ records, reads, maxFiresPerTick: 2 })
  for (const r of records) {
    await h.store.create({
      owner: 'person:ada',
      createdBy: 'person:ada',
      ownerScopeId: 'org:test',
      processId: r.processId,
      command: 'job',
      threadRef: `thread:${r.processId}`,
      expiresAt: BASE + 100_000,
    })
  }
  await h.poller.tick()
  assert.equal(h.submitted.length, 2)
})

test('fire-engine rejection records the error instead of advancing', async () => {
  const store = createMemoryMonitorStore()
  const monitor = await store.create({
    owner: 'person:ada',
    createdBy: 'person:ada',
    ownerScopeId: 'org:test',
    processId: 'proc-1',
    command: 'job',
    threadRef: 'thread:watch-1',
    expiresAt: BASE + 100_000,
  })
  const errors: string[] = []
  const poller = createMonitorPoller({
    monitors: {
      ...store,
      recordError: async (id: string, error: string) => {
        errors.push(error)
        await store.recordError(id, error)
      },
    },
    processes: { get: async () => ({ scopeId: 'org:test' }) },
    gate: {
      provision: async () => ({}),
      release: async () => {},
      read: async () => ({ chunks: 'x\n', cursor: 4, status: { state: 'running' } }),
    },
    fire: {
      submit: async () => {
        throw new Error('delivery unavailable')
      },
    },
    now: () => BASE,
  })
  await poller.tick()
  const after = await store.get(monitor.id)
  assert.equal(after?.cursor, 0, 'cursor stays put on fire failure')
  assert.match(errors.join('\n'), /delivery unavailable/)
})
