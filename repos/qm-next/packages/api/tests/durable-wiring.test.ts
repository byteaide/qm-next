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
import { createMemoryCommandPolicyStore } from '../src/services/command-policy-store.ts'
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
    assert.equal(svc.drain, undefined, 'memory boots carry no instance registry')
    assert.ok(svc.instanceId?.startsWith('api-'), 'instance id defaults to the api- prefix')
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

// ADR-0002 / plan §2.2 — CommandGate production startup assembly (X3b
// final slice): the composition root assembles the static registry lane
// via configureProductionCommandPolicy before listen; the fail-fast
// contract is that a production boot without a selected policy never
// serves, while dev boots fall back to PRODUCTION_DEFAULT_POLICY_ID.
test('command gate: dev boot assembles the registry with the default policy', async () => {
  const svc = new ApiService(new Context(), {
    port: 0,
    secrets: ['test-secret-for-command-gate-dev'],
  })
  const dispose = await svc[Service.init]()
  try {
    assert.ok(svc.commandGate, 'every boot assembles the static gate lane')
    assert.ok(svc.commandPolicyRegistry, 'registry exposed alongside the gate')
    assert.equal(
      svc.commandPolicyRegistry!.activeId(),
      'baseline-deny',
      'dev boot falls back to PRODUCTION_DEFAULT_POLICY_ID when QM_COMMAND_POLICY is unset',
    )
  } finally {
    await dispose?.()
  }
})

test('command gate: production boot without a policy selection refuses to start', async () => {
  const svc = new ApiService(new Context(), {
    port: 0,
    secrets: ['test-secret-for-command-gate-prod'],
    production: true,
  })
  await assert.rejects(
    () => svc[Service.init](),
    /QM_COMMAND_POLICY is not set/,
    'fail-fast: production must never serve without an explicit command policy (ADR-0002)',
  )
  assert.equal(svc.address.host, '', 'listen never happened on the rejected boot (address stays unbound)')
})

test('command gate: production boot with commandPolicyId serves and the gate converges on per-scope rules', async () => {
  const store = createMemoryCommandPolicyStore()
  // Stored scope policy: allowlist mode with a single `ls*` allow — the
  // same shape the sandbox provision composes over the org floor.
  await store.set('org:default', { mode: 'allowlist', rules: [{ pattern: 'ls.*', decision: 'allow' }] })
  const svc = new ApiService(new Context(), {
    port: 0,
    secrets: ['test-secret-for-command-gate-select'],
    production: true,
    commandPolicyId: 'rule-engine',
    commandPolicyStore: store,
  })
  const dispose = await svc[Service.init]()
  try {
    assert.equal(svc.commandPolicyRegistry!.activeId(), 'rule-engine')
    // ADR-0019 convergence: the rule-engine policy inside the gate
    // resolves the stored per-scope rules and evaluates them through the
    // same evaluateCommandPolicy the sandbox provision runs.
    const allowed = await svc.commandGate!.evaluate(
      {
        id: 'req-cmd-gate-1',
        runId: 'run-1',
        attemptId: 'attempt-1',
        class: 'shell',
        args: { argv: ['ls', '.'] },
        context: { scopeId: 'org:default', principalId: 'user-1', surface: 'web' },
        rawText: 'ls .',
        ts: Date.now(),
      },
      'rule-engine',
    )
    assert.equal(allowed.decision, 'allow', 'command matching the stored allow rule passes the gate')
    const denied = await svc.commandGate!.evaluate(
      {
        id: 'req-cmd-gate-2',
        runId: 'run-1',
        attemptId: 'attempt-2',
        class: 'shell',
        args: { argv: ['rm', '-rf', '.'] },
        context: { scopeId: 'org:default', principalId: 'user-1', surface: 'web' },
        rawText: 'rm -rf .',
        ts: Date.now(),
      },
      'rule-engine',
    )
    assert.equal(denied.decision, 'deny', 'allowlist mode refuses commands outside the stored rules')
    assert.equal(denied.requestId, 'req-cmd-gate-2')
  } finally {
    await dispose?.()
  }
})

test('command gate: production boot with an unknown commandPolicyId refuses to start', async () => {
  const svc = new ApiService(new Context(), {
    port: 0,
    secrets: ['test-secret-for-command-gate-unknown'],
    production: true,
    commandPolicyId: 'does-not-exist',
  })
  await assert.rejects(
    () => svc[Service.init](),
    (err: unknown) => err instanceof Error && /unknown CommandPolicy/.test(err.message),
  )
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

test('deploy-drain wiring (21.0): a live newer build generation drains older instances over the shared database', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  if (!(await postgresReachable())) return t.skip('postgres unreachable at QM_NEXT_PG_URL')
  const databaseUrl = pgUrl!
  const mk = async (instanceId: string, buildSha: string) => {
    const svc = new ApiService(new Context(), {
      port: 0,
      secrets: ['test-secret-for-drain'],
      databaseUrl,
      instanceId,
      buildSha,
      drainSweepMs: 200,
      drainLivenessMs: 5_000,
    })
    const dispose = (await svc[Service.init]()) ?? (async () => undefined)
    t.after(dispose)
    return svc
  }
  const older = await mk('wiring-test-older', 'v1')
  const newer = await mk('wiring-test-newer', 'v2')
  assert.ok(older.drain, 'durable boots wire the drain controller')
  // The first sweep beats immediately after listen; the older instance
  // sees the newer generation within a sweep or two.
  await (async () => {
    for (let i = 0; i < 40; i++) {
      if (older.drain?.canClaim() === false) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  })()
  assert.equal(older.drain?.canClaim(), false, 'the older generation stops claiming new runs')
  assert.equal(newer.drain?.canClaim(), true, 'the newer build keeps claiming')
})
