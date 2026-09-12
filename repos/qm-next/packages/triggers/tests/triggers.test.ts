/**
 * Triggers suite (13.0): schedule math, CronStore parity (memory +
 * Postgres when QM_NEXT_PG_URL is reachable), fire idempotency, the
 * tick-lease scheduler over a fake clock, and the trigger→turn sink.
 * Postgres cases skip when no server is configured; memory cases always
 * run.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryDirectoryStore } from '@qm/directory'
import type { DirectorySyncPush, ImDelivery, SendOperation } from '@qm/im-core'
import { createMemoryDeliveryQueue } from '@qm/im-core/runtime'
import type { Run, TurnInput, TurnResult } from '@qm/types'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { CronStore, CreateCronInput, LeaderLease } from '../src/index.ts'
import {
  advanceNextFireAt,
  createCronScheduler,
  createMemoryCronStore,
  createMemoryLeaderLease,
  createPostgresCronStore,
  createTriggerSink,
  cronFireKey,
  normalizeSchedule,
  recoverNextFireAt,
  renderCronFireInput,
  validateUserSchedule,
} from '../src/index.ts'
import { CRONS_SCHEMA_STATEMENTS } from '../src/postgres-cron-store.ts'
import { Pool } from 'pg'

const T0 = 1_757_000_000_000
const OWNER = 'feishu:u_owner'
const SCOPE = 'org:default'
const RESOLUTION = { resolve: async () => ({ systemPrompt: 'sys', orgScopeId: SCOPE }), scopeFor: () => SCOPE }

let seq = 0

function createInput(overrides: Partial<CreateCronInput> = {}): CreateCronInput {
  seq += 1
  return {
    scopeId: SCOPE,
    ownerId: OWNER,
    createdBy: OWNER,
    schedule: { everyMs: 60_000 },
    action: `do task ${seq}`,
    ...overrides,
  }
}

function messageInput(overrides: Partial<CreateCronInput> = {}): CreateCronInput {
  const input = createInput(overrides)
  return {
    scopeId: input.scopeId,
    ownerId: input.ownerId,
    createdBy: input.createdBy,
    schedule: input.schedule,
    message: 'standup in five',
    ...(input.destination ? { destination: input.destination } : {}),
  }
}

interface Harness {
  store: CronStore
  close(): Promise<void>
}

const pgUrl = process.env.QM_NEXT_PG_URL

function memoryHarness(): () => Promise<Harness> {
  return async () => ({ store: createMemoryCronStore(), close: async () => undefined })
}

async function resetCronsTables(): Promise<boolean> {
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
  const pool = createPgPool(pgUrl, CRONS_SCHEMA_STATEMENTS)
  await pool.query('SELECT 1')
  await pool.q('DELETE FROM cron_fire_log')
  await pool.q('DELETE FROM crons')
  await pool.close()
  return true
}

function pgHarness(): () => Promise<Harness> {
  return async () => {
    await resetCronsTables()
    const store = createPostgresCronStore(pgUrl!)
    return { store, close: async () => store.close?.() }
  }
}

async function cronStoreCases(t: import('node:test').TestContext, make: () => Promise<Harness>): Promise<void> {
  await t.test('create normalizes the schedule and computes nextFireAt; get round-trips', async () => {
    const h = await make()
    try {
      const created = await h.store.create(createInput({ schedule: { everyMs: 5_000, firstFireAt: T0 + 5_000 } }))
      assert.deepEqual(created.schedule, { everyMs: 5_000, firstFireAt: T0 + 5_000 })
      assert.equal(created.nextFireAt, T0 + 5_000)
      assert.equal(created.enabled, true)
      assert.equal(created.archived, false)
      assert.equal(created.ownerType, 'internal')
      assert.deepEqual(await h.store.get(created.id), created)
    } finally {
      await h.close()
    }
  })

  await t.test('create dedupes identical content and normalizes titles', async () => {
    const h = await make()
    try {
      const input = createInput({ title: '  spaced   out  ' })
      const first = await h.store.create(input)
      const second = await h.store.create({ ...input })
      assert.equal(second.id, first.id)
      assert.equal(first.title, 'spaced out')
      const other = await h.store.create({ ...input, action: 'different' })
      assert.notEqual(other.id, first.id)
    } finally {
      await h.close()
    }
  })

  await t.test('update: schedule change recomputes nextFireAt; archived disables; destination clears', async () => {
    const h = await make()
    try {
      const created = await h.store.create(createInput({ destination: { type: 'feishu', target: 'oc_a' } }))
      const updated = await h.store.update(created.id, {
        schedule: { everyMs: 90_000, firstFireAt: T0 + 90_000 },
        title: 'renamed',
      })
      assert.equal(updated?.nextFireAt, T0 + 90_000)
      assert.equal(updated?.title, 'renamed')
      const cleared = await h.store.update(created.id, { destination: null })
      assert.equal(cleared?.destination, undefined)
      const archived = await h.store.update(created.id, { archived: true })
      assert.equal(archived?.archived, true)
      assert.equal(archived?.enabled, false)
      assert.equal(await h.store.get('missing'), null)
      assert.equal(await h.store.update('missing', { title: 'x' }), null)
    } finally {
      await h.close()
    }
  })

  await t.test('due(): enabled, non-archived, slot at or before now', async () => {
    const h = await make()
    try {
      const dueNow = await h.store.create(createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 } }))
      await h.store.create(createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 + 60_000 } }))
      const disabled = await h.store.create(createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 } }))
      await h.store.setEnabled(disabled.id, false)
      const archived = await h.store.create(createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 } }))
      await h.store.update(archived.id, { archived: true })
      const due = await h.store.due(T0 + 1_000)
      assert.deepEqual(due.map((c) => c.id), [dueNow.id])
      assert.equal(due[0]?.scheduledAt, T0)
      assert.equal((await h.store.due(T0 + 120_000)).length, 2)
    } finally {
      await h.close()
    }
  })

  await t.test('claimSlot: exactly once per slot; advances the schedule; refuses stale slots', async () => {
    const h = await make()
    try {
      const created = await h.store.create(createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 } }))
      assert.equal(await h.store.claimSlot(created.id, T0 + 999, T0), false)
      assert.equal(await h.store.claimSlot(created.id, T0, T0), true)
      assert.equal(await h.store.claimSlot(created.id, T0, T0), false)
      const claimed = await h.store.get(created.id)
      assert.equal(claimed?.lastFiredAt, T0)
      assert.equal(claimed?.nextFireAt, T0 + 1_000)
      const disabled = await h.store.create(createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 } }))
      await h.store.setEnabled(disabled.id, false)
      assert.equal(await h.store.claimSlot(disabled.id, T0, T0), false)
    } finally {
      await h.close()
    }
  })

  await t.test('claimSlot on calendar schedules advances to the next clock slot', async () => {
    const h = await make()
    try {
      const created = await h.store.create(createInput({ schedule: { cron: '*/5 * * * *', timezone: 'UTC' } }))
      const slot = created.nextFireAt!
      assert.equal(slot % 300_000, 0)
      assert.equal(await h.store.claimSlot(created.id, slot, slot + 12_345), true)
      const claimed = await h.store.get(created.id)
      assert.equal(claimed?.lastFiredAt, slot + 12_345)
      assert.equal(claimed?.nextFireAt, advanceNextFireAt(created.schedule, slot))
      assert.equal(claimed?.nextFireAt, slot + 300_000)
    } finally {
      await h.close()
    }
  })

  await t.test('unclaimSlot restores the prior slot state', async () => {
    const h = await make()
    try {
      const created = await h.store.create(createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 } }))
      await h.store.claimSlot(created.id, T0, T0)
      await h.store.unclaimSlot(created.id, T0, T0, undefined)
      const restored = await h.store.get(created.id)
      assert.equal(restored?.lastFiredAt, undefined)
      assert.equal(restored?.nextFireAt, T0)
      assert.equal(await h.store.claimSlot(created.id, T0, T0 + 5), true)
    } finally {
      await h.close()
    }
  })

  await t.test('fire log: keep-first merge per fireKey, ordered pages, cascade delete', async () => {
    const h = await make()
    try {
      const created = await h.store.create(createInput())
      await h.store.recordFire(created.id, { fireKey: 'k1', firedAt: 30, status: 'ok' })
      await h.store.recordFire(created.id, { fireKey: 'k2', firedAt: 10 })
      await h.store.recordFire(created.id, { fireKey: 'k1', firedAt: 30, reply: 'done' })
      const page = await h.store.getFires(created.id)
      assert.equal(page.total, 2)
      assert.deepEqual(page.runs.map((e) => e.fireKey), ['k2', 'k1'])
      const k1 = page.runs[1]!
      assert.equal(k1.status, 'ok')
      assert.equal(k1.reply, 'done')
      const limited = await h.store.getFires(created.id, 1)
      assert.equal(limited.total, 2)
      assert.deepEqual(limited.runs.map((e) => e.fireKey), ['k1'])
      await h.store.delete(created.id)
      assert.equal((await h.store.getFires(created.id)).total, 0)
      assert.equal(await h.store.get(created.id), null)
    } finally {
      await h.close()
    }
  })
}

test('memory cron store parity cases', async (t) => {
  await cronStoreCases(t, memoryHarness())
})

test('postgres cron store parity cases', async (t) => {
  if (!(await resetCronsTables())) return t.skip('QM_NEXT_PG_URL not reachable')
  await cronStoreCases(t, pgHarness())
})

test('schedule math', async (t) => {
  await t.test('normalizeSchedule: interval schedules', () => {
    const now = T0
    assert.deepEqual(normalizeSchedule({ everyMs: 5_000 }, now), {
      schedule: { everyMs: 5_000, firstFireAt: now + 5_000 },
      nextFireAt: now + 5_000,
    })
    assert.deepEqual(normalizeSchedule({ firstFireAt: now + 1 }, now), {
      schedule: { firstFireAt: now + 1 },
      nextFireAt: now + 1,
    })
    assert.throws(() => normalizeSchedule({ everyMs: 86_400_000 }, now), /clock-time schedule in disguise/)
    assert.throws(() => normalizeSchedule({ everyMs: 0 }, now), /positive integer/)
    assert.throws(() => normalizeSchedule({ everyMs: 1.5 }, now), /positive integer/)
    assert.throws(() => normalizeSchedule({ firstFireAt: 1.5 }, now), /finite integer/)
    validateUserSchedule({ everyMs: 60_000 })
    assert.throws(() => validateUserSchedule({ everyMs: 100 }), /at least 60000ms/)
  })

  await t.test('normalizeSchedule: calendar schedules', () => {
    const now = T0
    const normalized = normalizeSchedule({ cron: '30 7 * * 1-5', timezone: 'Asia/Shanghai' }, now)
    assert.equal(normalized.schedule.cron, '30 7 * * 1-5')
    assert.equal(normalized.schedule.timezone, 'Asia/Shanghai')
    assert.ok(normalized.nextFireAt! > now)
    assert.equal(normalizeSchedule({ cron: '*/5 * * * *' }, now).schedule.timezone, 'UTC')
    assert.throws(() => normalizeSchedule({ cron: '30 7 * *', timezone: 'UTC' }, now), /5-field/)
    assert.throws(() => normalizeSchedule({ cron: '* * * * *', timezone: 'Mars/Olympus' }, now), /invalid IANA timezone/)
    assert.throws(() => normalizeSchedule({ cron: '* * * * *' }, now, 'Not/AZone'), /invalid IANA timezone/)
    assert.throws(() => normalizeSchedule({ cron: '', timezone: 'UTC' }, now), /non-empty/)
    assert.throws(() => normalizeSchedule({ cron: '* * * * *', everyMs: 1_000 }, now), /cannot be combined/)
    assert.throws(() => normalizeSchedule({ everyMs: 1_000, timezone: 'UTC' }, now), /requires schedule\.cron/)
  })

  await t.test('recoverNextFireAt: restart-safe recomputation', () => {
    const schedule = { everyMs: 1_000, firstFireAt: T0 }
    assert.equal(recoverNextFireAt(schedule, T0, undefined, T0 + 42), T0 + 42)
    assert.equal(recoverNextFireAt(schedule, T0, undefined, undefined), T0)
    assert.equal(recoverNextFireAt(schedule, T0, T0, undefined), T0 + 1_000)
    assert.equal(recoverNextFireAt({ firstFireAt: T0 }, T0, T0, undefined), undefined)
    const calendar = { cron: '*/5 * * * *', timezone: 'UTC' }
    assert.equal(recoverNextFireAt(calendar, T0, undefined, undefined), advanceNextFireAt(calendar, T0))
    assert.equal(recoverNextFireAt(calendar, T0, T0, undefined), advanceNextFireAt(calendar, T0))
  })

  await t.test('advanceNextFireAt keeps clock-time anchors for calendar schedules', () => {
    const calendar = { cron: '30 7 * * *', timezone: 'Asia/Shanghai' }
    const next = advanceNextFireAt(calendar, T0)!
    const day = new Date(next)
    assert.equal(day.getMinutes(), 30)
    assert.equal(day.getHours(), 7)
    assert.equal(advanceNextFireAt({ firstFireAt: T0 }, T0), undefined)
  })
})

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

interface SchedulerWorld {
  crons: CronStore
  lease: LeaderLease
  queue: ReturnType<typeof createMemoryDeliveryQueue>
  runList(): Promise<Run[]>
  requests(): Promise<Array<TurnInput & { runId: string }>>
  tick(at: number): Promise<void>
  claimNext(): Promise<Run>
  complete(run: Run, result: TurnResult): Promise<void>
  fail(run: Run, error: string): Promise<boolean>
  deliverables(): Promise<ImDelivery[]>
}

function schedulerWorld(
  opts: {
    lease?: LeaderLease
    identity?: { isInternal(p: { id: string; type: string }): boolean }
    maxFiresPerTick?: number
    directory?: Awaited<ReturnType<typeof createMemoryDirectoryStore>>
  } = {},
): SchedulerWorld {
  let clock = T0
  const crons = createMemoryCronStore()
  const lease = opts.lease ?? createMemoryLeaderLease()
  const queue = createMemoryDeliveryQueue()
  const runs = createMemoryRunStore()
  const sessions = createMemorySessionStore()
  const scheduler = createCronScheduler({
    crons,
    runs,
    sessions,
    resolution: RESOLUTION,
    deliveries: queue,
    lease,
    ...(opts.identity ? { identity: opts.identity } : {}),
    ...(opts.maxFiresPerTick !== undefined ? { maxFiresPerTick: opts.maxFiresPerTick } : {}),
    ...(opts.directory ? { directory: opts.directory } : {}),
    now: () => clock,
  })
  return {
    crons,
    lease,
    queue,
    async runList() {
      return runs.list({ limit: 100 })
    },
    async requests() {
      return (await runs.list({ limit: 100 })).map((r) => ({ ...r.request, runId: r.id }))
    },
    tick(at: number) {
      clock = at
      return scheduler.tick(at)
    },
    claimNext() {
      return runs.claim('worker-test', 30_000) as Promise<Run>
    },
    async complete(run, result) {
      assert.equal(await runs.complete(run.id, run.leaseToken!, result), true)
      await flush()
    },
    async fail(run, error) {
      const r = await runs.fail(run.id, run.leaseToken!, error, { retry: false })
      await flush()
      return r.requeued === false
    },
    async deliverables() {
      return queue.claim('feishu', { ttlMs: 1_000 })
    },
  }
}

test('fires on schedule exactly once and routes the reply to the delivery queue', async () => {
  const world = schedulerWorld()
  const created = await world.crons.create(
    createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 + 1_000 }, destination: { type: 'feishu', target: 'oc_replies' } }),
  )

  await world.tick(T0)
  assert.equal((await world.requests()).length, 0)

  await world.tick(T0 + 1_000)
  await world.tick(T0 + 1_000)
  const requests = await world.requests()
  assert.equal(requests.length, 1)
  const request = requests[0]!
  assert.equal(request.surface, 'cron')
  assert.deepEqual(request.origin, { kind: 'automation', destination: { type: 'feishu', target: 'oc_replies' } })
  assert.equal(request.background, true)
  assert.deepEqual(request.actor, { id: OWNER, type: 'internal' })
  assert.match(String(request.text), /Stored cron task:\n?do task/)

  const runs = await world.runList()
  assert.equal(runs.length, 1)
  assert.equal(runs[0]!.dedupKey, cronFireKey(created.id, T0 + 1_000))

  const claimed = await world.crons.get(created.id)
  assert.equal(claimed?.nextFireAt, T0 + 2_000)

  await world.complete(runs[0]!, { status: 'ok', reply: 'all done', sessionId: 'sess-1' })

  const deliveries = await world.deliverables()
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0]!.idempotencyKey, `cron-fire:${cronFireKey(created.id, T0 + 1_000)}`)
  assert.equal(deliveries[0]!.provider, 'feishu')
  assert.equal(deliveries[0]!.op.op, 'send')
  assert.deepEqual((deliveries[0]!.op as SendOperation).body, { markdown: 'all done' })

  const fires = await world.crons.getFires(created.id)
  assert.equal(fires.total, 1)
  const entry = fires.runs[0]!
  assert.equal(entry.fireKey, cronFireKey(created.id, T0 + 1_000))
  assert.equal(entry.status, 'ok')
  assert.equal(entry.reply, 'all done')
  assert.equal(entry.sessionId, 'sess-1')
  assert.equal(entry.runId, runs[0]!.id)
  assert.equal(entry.scheduledAt, T0 + 1_000)
})

test('scheduler fires each slot once in sequence', async () => {
  const world = schedulerWorld()
  const created = await world.crons.create(createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 + 1_000 } }))

  await world.tick(T0 + 1_000)
  assert.equal((await world.runList()).length, 1)
  for (const run of await world.runList()) await world.complete(run, { status: 'ok' })
  assert.equal((await world.crons.getFires(created.id)).total, 1)

  await world.tick(T0 + 2_000)
  assert.equal((await world.runList()).length, 2)
  for (const run of await world.runList()) await world.complete(run, { status: 'ok' })
  const fires = await world.crons.getFires(created.id)
  assert.equal(fires.total, 2)
  assert.deepEqual(fires.runs.map((e) => e.scheduledAt), [T0 + 1_000, T0 + 2_000])
})

test('leader lease blocks double-fire across schedulers', async () => {
  const world = schedulerWorld()
  await world.crons.create(createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 + 1_000 } }))

  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  void world.lease.hold('cron:scheduler:tick', async () => {
    await held
  })
  await world.tick(T0 + 1_000)
  assert.equal((await world.requests()).length, 0)
  release()
  await flush()
  await world.tick(T0 + 1_000)
  assert.equal((await world.requests()).length, 1)

  const sameInstant = createCronScheduler({
    crons: world.crons,
    runs: createMemoryRunStore(),
    sessions: createMemorySessionStore(),
    resolution: RESOLUTION,
    lease: world.lease,
    now: () => T0 + 1_000,
  })
  await sameInstant.tick(T0 + 1_000)
  assert.equal((await world.requests()).length, 1)
  const claimed = await world.crons.list()
  assert.equal(claimed[0]?.lastFiredAt, T0 + 1_000)
})

test('message fires deliver directly without a turn', async () => {
  const world = schedulerWorld()
  const created = await world.crons.create(
    messageInput({ schedule: { everyMs: 1_000, firstFireAt: T0 + 1_000 }, destination: { type: 'feishu', target: 'oc_team' } }),
  )
  await world.tick(T0 + 1_000)
  assert.equal((await world.requests()).length, 0)
  const deliveries = await world.deliverables()
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0]!.idempotencyKey, `cron-fire:${cronFireKey(created.id, T0 + 1_000)}`)
  assert.deepEqual((deliveries[0]!.op as SendOperation).body, { markdown: 'standup in five' })
  const fires = await world.crons.getFires(created.id)
  assert.equal(fires.runs[0]!.status, 'ok')
})

test('directory gate blocks delivery the owner can no longer see', async () => {
  const directory = createMemoryDirectoryStore()
  const push: DirectorySyncPush = {
    provider: 'feishu',
    instanceId: 'inst-1',
    people: [{ providerUserId: 'u_owner', displayName: 'Owner', type: 'internal' }],
    spaces: [
      { spaceId: 'oc_pub', name: 'public', kind: 'channel', isPrivate: false, isExternal: false },
      { spaceId: 'oc_priv', name: 'private', kind: 'channel', isPrivate: true, isExternal: false },
    ],
    spaceMembers: [{ spaceId: 'oc_priv', providerUserId: 'u_other' }],
    replace: ['people', 'spaces', 'spaceMembers'],
    syncedAt: T0,
  }
  assert.equal(await directory.apply(push), true)

  const world = schedulerWorld({ directory })
  const hidden = await world.crons.create(
    createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 + 1_000 }, destination: { type: 'feishu', target: 'oc_priv' } }),
  )
  const visible = await world.crons.create(
    createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 + 1_000 }, destination: { type: 'feishu', target: 'oc_pub' } }),
  )
  await world.tick(T0 + 1_000)
  assert.equal((await world.runList()).length, 2)
  for (const run of await world.runList()) await world.complete(run, { status: 'ok', reply: 'hi', sessionId: 's' })

  const deliveries = await world.deliverables()
  assert.equal(deliveries.length, 1)
  assert.equal((deliveries[0]!.op as SendOperation).destination.target, 'oc_pub')

  const hiddenFires = await world.crons.getFires(hidden.id)
  assert.match(hiddenFires.runs[0]!.note!, /no longer visible/)
  assert.equal(hiddenFires.runs[0]!.reply, undefined)
  const visibleFires = await world.crons.getFires(visible.id)
  assert.equal(visibleFires.runs[0]!.reply, 'hi')
})

test('runNow fires immediately under a manual key without consuming the slot', async () => {
  let clock = T0
  const crons = createMemoryCronStore()
  const runs = createMemoryRunStore()
  const queue = createMemoryDeliveryQueue()
  const scheduler = createCronScheduler({
    crons,
    runs,
    sessions: createMemorySessionStore(),
    resolution: RESOLUTION,
    deliveries: queue,
    now: () => clock,
  })
  const created = await crons.create(createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 + 1_000 } }))

  const submission = await scheduler.runNow(created.id)
  assert.ok(submission)
  assert.equal(submission.deduped, false)
  const runsList = await runs.list({ limit: 10 })
  assert.equal(runsList.length, 1)
  assert.match(runsList[0]!.dedupKey!, /:manual:/)
  const cron = await crons.get(created.id)
  assert.equal(cron?.nextFireAt, T0 + 1_000)
  assert.equal(cron?.lastFiredAt, undefined)

  await runs.complete(runsList[0]!.id, runsList[0]!.leaseToken!, { status: 'ok', reply: 'manual done' })
  const fires = await crons.getFires(created.id)
  assert.equal(fires.total, 1)
  assert.equal(fires.runs[0]!.reply, 'manual done')
  assert.equal(fires.runs[0]!.scheduledAt, undefined)

  clock = T0 + 1_000
  await scheduler.tick(clock)
  assert.equal((await runs.list({ limit: 10 })).length, 2)
})

test('maxFiresPerTick caps the batch by attempt age', async () => {
  const world = schedulerWorld({ maxFiresPerTick: 2 })
  for (let i = 0; i < 3; i++) {
    await world.crons.create(createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 } }))
  }
  await world.tick(T0)
  assert.equal((await world.requests()).length, 2)
  await world.tick(T0)
  assert.equal((await world.requests()).length, 3)
})

test('one-shot schedules disable after firing; disabled crons never fire', async () => {
  const world = schedulerWorld()
  const oneShot = await world.crons.create(createInput({ schedule: { firstFireAt: T0 + 1_000 } }))
  const disabled = await world.crons.create(createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 + 1_000 } }))
  await world.crons.setEnabled(disabled.id, false)
  await world.tick(T0 + 1_000)
  assert.equal((await world.requests()).length, 1)
  assert.equal((await world.crons.get(oneShot.id))?.enabled, false)
  await world.tick(T0 + 2_000)
  assert.equal((await world.requests()).length, 1)
})

test('non-internal owners disable the cron without consuming the slot', async () => {
  const world = schedulerWorld({ identity: { isInternal: (p) => p.type === 'internal' } })
  const created = await world.crons.create(
    createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 + 1_000 }, ownerType: 'guest' }),
  )
  await world.tick(T0 + 1_000)
  assert.equal((await world.requests()).length, 0)
  const cron = await world.crons.get(created.id)
  assert.equal(cron?.enabled, false)
  const fires = await world.crons.getFires(created.id)
  assert.match(fires.runs[0]!.note!, /no longer an internal principal/)
})

test('start/stop drives ticks on an interval', async () => {
  let clock = T0
  const crons = createMemoryCronStore()
  const runs = createMemoryRunStore()
  const scheduler = createCronScheduler({
    crons,
    runs,
    sessions: createMemorySessionStore(),
    resolution: RESOLUTION,
    now: () => clock,
  })
  await crons.create(createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 + 1_000 } }))
  scheduler.start(5)
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  clock = T0 + 1_000
  await new Promise<void>((resolve) => setTimeout(resolve, 60))
  scheduler.stop()
  await new Promise<void>((resolve) => setTimeout(resolve, 30))
  assert.equal((await runs.list({ limit: 10 })).length, 1)
})

test('pending approvals and failures are logged without delivery', async () => {
  const world = schedulerWorld()
  const created = await world.crons.create(
    createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 + 1_000 }, destination: { type: 'feishu', target: 'oc_x' } }),
  )
  await world.tick(T0 + 1_000)
  const [run] = await world.runList()

  await world.complete(run!, {
    status: 'pending_approval',
    pendingApprovals: [{ requestId: 'r1', command: 'rm -rf', reason: 'destructive' }],
  })
  const fires = await world.crons.getFires(created.id)
  assert.equal(fires.runs[0]!.status, 'pending_approval')
  assert.match(fires.runs[0]!.note!, /require_approval/)
  assert.equal((await world.deliverables()).length, 0)
})

test('failed runs record the failure in the fire log', async () => {
  const world = schedulerWorld()
  const created = await world.crons.create(createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 + 1_000 } }))
  await world.tick(T0 + 1_000)
  const claimed = await world.claimNext()
  assert.ok(claimed)
  const failed = await world.fail(claimed, 'harness exploded')
  assert.equal(failed, true)
  const fires = await world.crons.getFires(created.id)
  assert.equal(fires.runs[0]!.status, 'failed')
  assert.match(fires.runs[0]!.note!, /harness exploded/)
})

test('trigger sink creates turns idempotently per key', async () => {
  const queue = createMemoryDeliveryQueue()
  const runs = createMemoryRunStore()
  const sink = createTriggerSink({
    runs,
    sessions: createMemorySessionStore(),
    resolution: RESOLUTION,
    deliveries: queue,
  })
  const input = {
    key: 'evt-1',
    text: 'deploy finished',
    ownerId: OWNER,
    destination: { type: 'feishu', target: 'oc_deploys' },
  }
  const first = await sink.fire(input)
  assert.equal(first.deduped, false)
  const second = await sink.fire(input)
  assert.equal(second.deduped, true)
  assert.equal(second.runId, first.runId)

  const runsList = await runs.list({ limit: 10 })
  assert.equal(runsList.length, 1)
  const request = runsList[0]!.request
  assert.equal(request.surface, 'trigger')
  assert.deepEqual(request.origin, { kind: 'automation', destination: input.destination })
  assert.equal(request.text, 'deploy finished')
  assert.equal(runsList[0]!.dedupKey, 'evt-1')
  assert.equal(request.background, true)

  await runs.complete(first.runId, runsList[0]!.leaseToken!, { status: 'ok', reply: 'deployed v3', sessionId: 's2' })
  const deliveries = await queue.claim('feishu', { ttlMs: 1_000 })
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0]!.origin?.trigger, 'evt-1')
  assert.equal(deliveries[0]!.origin?.runId, first.runId)
  assert.deepEqual((deliveries[0]!.op as SendOperation).body, { markdown: 'deployed v3' })
})

test('cron fire input rendering preserves bang tasks', () => {
  const rendered = renderCronFireInput('check the queue', 'cron-1', 'Queue check')
  assert.match(rendered, /\[Cron runtime context\]/)
  assert.match(rendered, /Cron id: cron-1 \(Queue check\)/)
  assert.match(rendered, /Stored cron task:\s*\n?check the queue/)
  assert.equal(renderCronFireInput('!run deploy', 'cron-1'), '!run deploy')
  assert.equal(renderCronFireInput('!scratch notes', 'cron-1'), '!scratch notes')
})

test('postgres claimSlot serializes concurrent claims', async (t) => {
  if (!(await resetCronsTables())) return t.skip('QM_NEXT_PG_URL not reachable')
  const store = createPostgresCronStore(pgUrl!)
  try {
    const created = await store.create(createInput({ schedule: { everyMs: 1_000, firstFireAt: T0 } }))
    const [a, b] = await Promise.all([store.claimSlot(created.id, T0, T0 + 1), store.claimSlot(created.id, T0, T0 + 1)])
    assert.equal(a !== b, true)
    const claimed = await store.get(created.id)
    assert.equal(claimed?.nextFireAt, advanceNextFireAt(created.schedule, T0 + 1))
  } finally {
    await store.close?.()
  }
})
