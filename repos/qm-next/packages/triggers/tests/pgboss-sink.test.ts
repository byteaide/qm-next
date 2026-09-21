/**
 * pg-boss sink contract tests (cluster 2 brief `qm-next-c2-pgboss-queue`).
 *
 * The pg-boss adapter requires a real Postgres connection; tests are
 * skipped when `QM_NEXT_PG_URL` is unset.  When the URL is reachable the
 * suite exercises:
 *   - `fire()` returns the same real `runId` twice for the same key (idempotent)
 *   - `fire()` enqueues a singleton-keyed job into pg-boss
 *   - The worker (`start()`) drains a queued job and the engine.submit
 *     path dedupes onto the existing run
 *   - `stop()` / `close()` are idempotent and tear down the worker
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test as nodeTest } from 'node:test'
import { createMemoryDirectoryStore } from '@qm/directory'
import { createMemoryDeliveryQueue } from '@qm/im-core/runtime'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { Destination, PrincipalType } from '@qm/types'
import { createFireEngine } from '../src/fire.ts'
import { createPgBossSink, PGBOSS_TRIGGER_QUEUE } from '../src/pgboss-sink.ts'

const pgUrl = process.env.QM_NEXT_PG_URL
const SCOPE = 'org:default'
const RESOLUTION = {
  resolve: async () => ({ systemPrompt: 'sys', orgScopeId: SCOPE }),
  scopeFor: () => SCOPE,
}

async function pgReachable(): Promise<boolean> {
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

interface FireInput {
  key: string
  text: string
  ownerId: string
  ownerType?: PrincipalType
  destination?: Destination
}

function makeFireHarness() {
  const queue = createMemoryDeliveryQueue()
  const runs = createMemoryRunStore()
  const sessions = createMemorySessionStore({ leaseTtlMs: 80 })
  const directory = createMemoryDirectoryStore()
  const engine = createFireEngine({
    runs,
    sessions,
    resolution: RESOLUTION,
    deliveries: queue,
    directory,
  })
  return { queue, runs, sessions, engine }
}

const reachableNow = await pgReachable()

nodeTest(
  'fire() returns real runId and dedupes on second call',
  { skip: !reachableNow },
  async () => {
    const { runs, engine } = makeFireHarness()
    const sink = createPgBossSink(engine, { connectionString: pgUrl! })

    const input: FireInput = {
      key: `evt-${randomUUID()}`,
      text: 'deploy finished',
      ownerId: 'user-1',
      destination: { type: 'feishu', target: 'oc_deploys' },
    }

    const first = await sink.fire(input)
    assert.equal(first.deduped, false)
    assert.ok(first.runId)

    const second = await sink.fire(input)
    assert.equal(second.deduped, true)
    assert.equal(second.runId, first.runId)

    const runsList = await runs.list({ limit: 10 })
    assert.equal(runsList.length, 1, 'second fire should dedupe onto the first run')

    await sink.close()
  },
)

nodeTest(
  'fire() mirrors a singleton-keyed job into pg-boss',
  { skip: !reachableNow },
  async () => {
    const { engine } = makeFireHarness()
    const sink = createPgBossSink(engine, { connectionString: pgUrl! })
    await sink.start()

    const key = `evt-mirror-${randomUUID()}`
    await sink.fire({
      key,
      text: 'mirror test',
      ownerId: 'user-1',
    })

    // Give pg-boss a beat to commit
    await new Promise<void>((r) => setTimeout(r, 300))

    const pool = new Pool({ connectionString: pgUrl! })
    try {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM pgboss.job WHERE name = $1 AND singleton_key = $2`,
        [PGBOSS_TRIGGER_QUEUE, key],
      )
      assert.ok(
        Number(rows[0]?.count) >= 1,
        `expected at least 1 job with singletonKey=${key}; got ${rows[0]?.count}`,
      )
    } finally {
      await pool.end().catch(() => undefined)
      await sink.close()
    }
  },
)

nodeTest(
  'start() worker drains a queued job idempotently',
  { skip: !reachableNow },
  async () => {
    const { runs, engine } = makeFireHarness()
    const sink = createPgBossSink(engine, { connectionString: pgUrl! })
    // Enqueue without starting the worker (start() is opt-in).
    const key = `evt-worker-${randomUUID()}`
    await sink.fire({ key, text: 'worker drain test', ownerId: 'user-1' })

    // Now start the worker. It should pick up the queued job and submit it;
    // because the original fire already created a run with the same fireKey,
    // engine.submit must dedupe.
    await sink.start()
    await new Promise<void>((r) => setTimeout(r, 1500))

    const runsList = await runs.list({ limit: 100 })
    const mine = runsList.filter((r) => r.dedupKey === key)
    assert.equal(mine.length, 1, `worker drain must dedupe to 1 run for fireKey=${key}`)

    await sink.close()
  },
)

nodeTest(
  'stop() and close() are idempotent',
  { skip: !reachableNow },
  async () => {
    const { engine } = makeFireHarness()
    const sink = createPgBossSink(engine, { connectionString: pgUrl! })
    await sink.start()
    await sink.stop()
    await sink.stop() // second call must not throw
    await sink.close()
    await sink.close() // second call must not throw
  },
)