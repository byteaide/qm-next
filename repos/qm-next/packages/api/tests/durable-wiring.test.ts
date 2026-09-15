/**
 * Durable-by-default wiring (20.0): booting the composed ApiService with
 * databaseUrl lands every twin table the migration preflight expects
 * (schema ownership lives with store constructors), /readyz probes the
 * database, and the monitoring summary route is registered. Memory boots
 * stay the default and report the database as disabled.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { Context, Service } from '@qm/cordis'
import { ApiService } from '../src/index.ts'

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

const TWIN_TABLES = [
  'sessions',
  'session_entries',
  'participants',
  'runs',
  'directory_people',
  'directory_spaces',
  'directory_space_members',
  'directory_sync_state',
  'keychain_credentials',
  'keychain_grants',
  'keychain_asks',
  'model_credentials',
  'custom_model_providers',
  'device_flow_cutover',
  'webhooks',
  'channel_policy',
  'channel_policy_history',
  'file_artifacts',
  'audit_log',
  'turn_metrics',
  'error_events',
  'tasks',
  'task_events',
  'acl_grants',
  'acl_grants_version',
  'run_activity',
  'run_signals',
  'source_auth_replay',
]

test('memory boot: /readyz reports the database disabled and /healthz stays ok', async () => {
  const svc = new ApiService(new Context(), {
    port: 0,
    secrets: ['test-secret-for-memory-boot'],
  })
  const dispose = await svc[Service.init]()
  try {
    const health = await svc.app.inject({ method: 'GET', url: '/healthz' })
    assert.equal(health.statusCode, 200)
    assert.deepEqual(health.json(), { ok: true })
    const ready = await svc.app.inject({ method: 'GET', url: '/readyz' })
    assert.equal(ready.statusCode, 200)
    assert.deepEqual(ready.json(), { ok: true, components: { database: 'disabled' } })
  } finally {
    await dispose?.()
  }
})

test('durable boot: every twin table lands at boot; readyz probes up; monitoring summary wired', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  if (!(await postgresReachable())) return t.skip('postgres unreachable at QM_NEXT_PG_URL')
  const databaseUrl = pgUrl!
  const filesDir = await mkdtemp(join(tmpdir(), 'qmn-files-'))
  const svc = new ApiService(new Context(), {
    port: 0,
    secrets: ['test-secret-for-durable-boot'],
    databaseUrl,
    filesDir,
    directory: true,
    keychain: true,
    files: true,
    webhooks: true,
    context: true,
    surfaceCache: true,
    connectors: true,
    admin: true,
    admins: ['admin-user'],
  })
  // Register cleanup before init: a rejected init must not strand the
  // pools it already opened (leaked sockets keep the test file alive).
  let dispose: (() => Promise<void>) | undefined
  t.after(() => dispose?.())
  dispose = await svc[Service.init]()

  const { createPgPool } = await import('@qm/store')
  const check = createPgPool(pgUrl!, [])
  try {
    const rows = await check.q(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [TWIN_TABLES],
    )
    const found = new Set(rows.map((r) => r.table_name as string))
    const missing = TWIN_TABLES.filter((name) => !found.has(name))
    assert.deepEqual(missing, [], 'every twin table must exist after a durable boot')
  } finally {
    await check.close()
  }

  const ready = await svc.app.inject({ method: 'GET', url: '/readyz' })
  assert.equal(ready.statusCode, 200)
  assert.deepEqual(ready.json(), { ok: true, components: { database: 'up' } })

  // The admin ladder is qm-verbatim: missing ?scope= is a 400 before auth,
  // and an actor without an admin grant is a 403 — there is no 401 rung.
  const unscoped = await svc.app.inject({ method: 'GET', url: '/v1/admin/monitoring/summary' })
  assert.equal(unscoped.statusCode, 400, 'monitoring summary rides the admin ladder: missing scope is a 400')
  const unauthed = await svc.app.inject({ method: 'GET', url: '/v1/admin/monitoring/summary?scope=org:default' })
  assert.equal(unauthed.statusCode, 403, 'monitoring summary rides the admin ladder: no admin grant is a 403')
})
