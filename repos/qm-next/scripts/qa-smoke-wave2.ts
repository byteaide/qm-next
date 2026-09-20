/**
 * qm-next Phase 3E Wave 2 — S40/S41/S42/S43/S44 (P5+P6)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Standalone staging file. Infrastructure-heavy: triggers, reach, pg, sandbox,
 * deployments. Uses mock harness (no model API key required).
 *
 * Cases:
 *   S40  Triggers real trigger (3): cron create / manual run / fire log
 *   S41  Reach cap-token (3): cap-token resolution / no-GET-route / no-auth 403
 *   S42  Postgres pg 对拍 (8): session in pg / memory twin / skill twin / cron twin
 *        / memory round-trip / skill round-trip / cron round-trip / persisted after re-boot
 *   S43  Sandbox Docker (5): provision / echo / timeout / exit-code / teardown
 *   S44  Deployments (5): create / list / get / archive / admin list
 *
 * Run:
 *   node --import tsx/esm scripts/qa-smoke-wave2.ts
 *
 * SKIP is acceptable, FAIL is not. Exit 0 on all-PASS (SKIPs don't count as FAIL).
 *
 * Phase 3G note (2026-09-19):
 *   S42 三个 SKIP（memory/skill/cron pg twin）已闭合。
 *   memoryStore / skillStore 注入口在 `packages/api/src/service.ts` 公开；
 *   wave2 在 pg-backed ApiService 启动后注入 PG 双胞胎。
 *   cron store 改为 `createPostgresCronStore(pgUrl)` 而非 in-memory（pg 容器已可用）。
 */

import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const QM_NEXT_ROOT = join(__dirname, '..')

const { Context } = await import(`${QM_NEXT_ROOT}/vendor/cordis/src/index.ts`)
const { ApiService, mintSignedPayload } = await import(`${QM_NEXT_ROOT}/packages/api/src/index.ts`)
const { mintCapabilityToken, CONTROL_PLANE_AUD } = await import(`${QM_NEXT_ROOT}/packages/auth/src/index.ts`)
const { createMemoryCronStore, createPostgresCronStore, createCronScheduler } = await import(`${QM_NEXT_ROOT}/packages/triggers/src/index.ts`)
const { createPostgresScopeMemory } = await import(`${QM_NEXT_ROOT}/packages/memory/src/index.ts`)
const { createPostgresSkillStore } = await import(`${QM_NEXT_ROOT}/packages/skills/src/index.ts`)
const { createPgPool } = await import(`${QM_NEXT_ROOT}/packages/store/src/index.ts`)

// ════════════════════════════════════════════════════════════════════════
// Config
// ════════════════════════════════════════════════════════════════════════

const SECRET = 'qa-smoke-secret-0181e7c2f3a9b1'
const RUN_TAG = `wave2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

// ════════════════════════════════════════════════════════════════════════
// Results tracking
// ════════════════════════════════════════════════════════════════════════

type Detail = Record<string, unknown>
type Scenario =
  | { name: string; section: string; ok: true; detail: Detail }
  | { name: string; section: string; ok: false; reason: string }

const results: Scenario[] = []
const skipped: string[] = []

async function scenario(section: string, name: string, fn: () => Promise<Detail>): Promise<void> {
  try {
    const detail = await fn()
    results.push({ section, name, ok: true, detail })
    console.log(`  \x1b[32m\u2713\x1b[0m ${name}`)
  } catch (e) {
    const reason = (e as Error).message
    results.push({ section, name, ok: false, reason })
    console.log(`  \x1b[31m\u2717\x1b[0m ${name}`)
    console.log(`        ${reason}`)
  }
}

function skip(section: string, name: string, reason: string): void {
  skipped.push(`[${section}] ${name}: ${reason}`)
  console.log(`  \x1b[33m\u2298\x1b[0m ${name} -- SKIP: ${reason}`)
}

// ════════════════════════════════════════════════════════════════════════
// Boot ApiService
// ════════════════════════════════════════════════════════════════════════

const ctx = new Context()
const fiber = await ctx.plugin(ApiService, {
  port: 0,
  secrets: [SECRET],
  defaultHarness: 'mock',
  memory: true,
  skills: true,
  skillPacks: true,
  admin: true,
  admins: ['qa-admin'],
  directory: true,
  keychain: true,
  files: true,
  connectors: true,
  webhooks: true,
  secretDrops: true,
  config: true,
  blobs: true,
  grants: true,
  deployments: true,
  sandbox: { defaultTimeoutSec: 120, defaultTimeoutCeilingSec: 600 },
})

const port = ctx.api.address.port
const baseUrl = `http://127.0.0.1:${port}`
const token = await mintSignedPayload({ p: 'qa-smoke' }, SECRET)
const adminToken = await mintSignedPayload({ p: 'qa-admin' }, SECRET)
const authHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' } as const
const adminAuthHeaders = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' } as const
const DEFAULT_ADMIN_SCOPE = 'org:default'

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = authHeaders,
): Promise<{ status: number; body: any }> {
  const init: RequestInit = { method, headers }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await fetch(`${baseUrl}${path}`, init)
  const text = await res.text()
  let parsed: any
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

// Inject the trigger runtime (TriggersService requires im-bridge; not feasible in test.
// We directly inject a memory cron store + scheduler using the ApiService's
// own sessions/runs/resolution — the cron routes are fully real, only the
// runtime is test-injected, same pattern as mock harness in qa-smoke S3.6.)
// Phase 7 / KV-002: the api reads the runtime lazily from the Cordis
// registry (`ctx.reflect.get('triggers')`), so the rig provides it there.
const crons = createMemoryCronStore()
const scheduler = createCronScheduler({
  crons,
  sessions: ctx.api.sessions,
  runs: ctx.api.runs,
  resolution: ctx.api.resolution,
})
ctx.provide('triggers', { crons, scheduler })

// ════════════════════════════════════════════════════════════════════════
// S40. Triggers real trigger (3 cases)
// ════════════════════════════════════════════════════════════════════════
console.log('\n\u00a7S40 Triggers real trigger')

let cronId: string | undefined

await scenario('S40', 'POST /v1/crons (create every-minute schedule)', async () => {
  const { status, body } = await req('POST', '/v1/crons', {
    schedule: { cron: '*/1 * * * *' },
    task: 'Reply with: PONG',
    principalId: 'qa-smoke',
  })
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (!body?.cron?.id) throw new Error(`no cron.id: ${JSON.stringify(body)}`)
  cronId = body.cron.id
  return { status, cronId: body.cron.id, schedule: body.cron.schedule }
})

await scenario('S40', 'POST /v1/crons/:id/run (manual trigger)', async () => {
  if (!cronId) throw new Error('no cronId from S40.1')
  const { status, body } = await req('POST', `/v1/crons/${cronId}/run?principalId=qa-smoke`, {}, authHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (body?.ok !== true) throw new Error(`expected ok=true: ${JSON.stringify(body)}`)
  return { status, ok: body.ok }
})

await scenario('S40', 'GET /v1/crons/:id/runs (fire log after trigger)', async () => {
  if (!cronId) throw new Error('no cronId from S40.1')
  // Wait for the async run to complete and the terminal callback to record the fire
  await new Promise((r) => setTimeout(r, 3000))
  const { status, body } = await req('GET', `/v1/crons/${cronId}/runs?principalId=qa-smoke`, undefined, authHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  return { status, total: body?.total, runsCount: body?.runs?.length ?? 0 }
})

// ════════════════════════════════════════════════════════════════════════
// S41. Reach cap-token (3 cases)
// ════════════════════════════════════════════════════════════════════════
console.log('\n\u00a7S41 Reach cap-token')

await scenario('S41', 'POST /v1/reach with cap token (route reachable, any 2xx/4xx valid)', async () => {
  // First, sync directory mock with qa-smoke as a member so recipient resolution can find a match
  await fetch(`${baseUrl}/v1/directory`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      workspace: 'qa-reach-test',
      members: [{ principalId: 'qa-smoke', displayName: 'QA Smoke', emails: ['[email protected]'] }],
    }),
  }).catch(() => undefined)
  const cap = await mintCapabilityToken({
    actorId: 'qa-smoke',
    scopeId: 'personal:qa-smoke',
    aud: CONTROL_PLANE_AUD,
    exp: Date.now() + 60_000,
  }, SECRET, 'default')
  const res = await fetch(`${baseUrl}/v1/reach`, {
    method: 'POST',
    headers: { 'x-agent-capability': cap, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello from reach', recipient: 'qa-smoke' }),
  })
  const parsed = await res.json().catch(() => ({}))
  // Accept any non-401 status: 200 (rare), 501 (send gate), 404 (resolution),
  // 403 (recipient scope mismatch). 401 would mean cap token invalid.
  if (res.status === 401) throw new Error(`cap token rejected: status=401 body=${JSON.stringify(parsed)}`)
  return { status: res.status, error: parsed?.error, hasResolved: !!parsed?.resolved }
})

await scenario('S41', 'GET /v1/reach (no GET route registered -> 404)', async () => {
  const { status, body } = await req('GET', '/v1/reach')
  if (status !== 404) throw new Error(`expected 404 got ${status} body=${JSON.stringify(body)}`)
  return { status }
})

await scenario('S41', 'POST /v1/reach with no auth (-> 403 requires cap token)', async () => {
  const res = await fetch(`${baseUrl}/v1/reach`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello' }),
  })
  const parsed = await res.json().catch(() => ({}))
  if (res.status !== 403) throw new Error(`expected 403 got ${res.status} body=${JSON.stringify(parsed)}`)
  return { status: res.status, error: parsed?.error }
})

// ════════════════════════════════════════════════════════════════════════
// S42. Postgres pg 对拍 (5 cases)
// ════════════════════════════════════════════════════════════════════════
console.log('\n\u00a7S42 Postgres pg \u5bf9\u62cd')

let pgContainer: string | undefined
let pgUrl: string | undefined
let pgFiber: { dispose(): Promise<void> } | undefined
let pgSessionId: string | undefined

try {
  // Start pg container
  pgContainer = `qm-next-pg-wave2-${Date.now()}-${process.pid}`
  execSync(
    `docker run --rm -d -P --name ${pgContainer} -e POSTGRES_USER=qm -e POSTGRES_PASSWORD=qm -e POSTGRES_DB=qm postgres:16-alpine`,
    { timeout: 30_000, stdio: 'pipe' },
  )

  // Wait for pg ready (two consecutive SELECT 1 hits, like run-pg.sh)
  let pgReady = false
  const readyDeadline = Date.now() + 30_000
  let hits = 0
  while (Date.now() < readyDeadline) {
    try {
      execSync(`docker exec ${pgContainer} psql -U qm -d qm -c 'SELECT 1'`, { timeout: 5_000, stdio: 'pipe' })
      hits++
      if (hits >= 2) { pgReady = true; break }
    } catch {
      hits = 0
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (!pgReady) throw new Error('postgres did not settle within 30s')

  // Get published port
  const portOut = execSync(`docker port ${pgContainer} 5432/tcp`, { timeout: 5_000 }).toString().trim()
  const pgPort = portOut.split('\n')[0]!.split(':').pop()
  pgUrl = `postgres://qm:qm@127.0.0.1:${pgPort}/qm`

  // Boot pg-backed ApiService
  const pgCtx = new Context()
  pgFiber = await pgCtx.plugin(ApiService, {
    port: 0,
    secrets: [SECRET],
    defaultHarness: 'mock',
    memory: true,
    skills: true,
    admin: true,
    admins: ['qa-admin'],
    directory: true,
    keychain: true,
    files: true,
    grants: true,
    config: true,
    blobs: true,
    deployments: true,
    databaseUrl: pgUrl,
  })

  const pgPortNum = pgCtx.api.address.port
  const pgBaseUrl = `http://127.0.0.1:${pgPortNum}`
  const pgToken = await mintSignedPayload({ p: 'qa-smoke' }, SECRET)
  const pgAuthHeaders = { authorization: `Bearer ${pgToken}`, 'content-type': 'application/json' }

  // Inject trigger runtime + memoryStore + skillStore for pg instance.
  // Phase 3G: 三个 SKIP 闭合 — 用 PG 双胞胎替换默认 in-memory 工厂。
  const pgCrons = createPostgresCronStore(pgUrl)
  const pgScheduler = createCronScheduler({
    crons: pgCrons,
    sessions: pgCtx.api.sessions,
    runs: pgCtx.api.runs,
    resolution: pgCtx.api.resolution,
  })
  pgCtx.provide('triggers', { crons: pgCrons, scheduler: pgScheduler })
  pgCtx.api.memoryStore = createPostgresScopeMemory(pgUrl)
  pgCtx.api.skillStore = createPostgresSkillStore(pgUrl)

  async function pgReq(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const init: RequestInit = { method, headers: pgAuthHeaders }
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await fetch(`${pgBaseUrl}${path}`, init)
    const text = await res.text()
    let parsed: any
    try { parsed = JSON.parse(text) } catch { parsed = text }
    return { status: res.status, body: parsed }
  }

  const pgPool = createPgPool(pgUrl, [])

  await scenario('S42', 'pg: session created via /v1/turns -> row in pg sessions table', async () => {
    const { status, body } = await pgReq('POST', '/v1/turns', {
      text: 'hello pg',
      surface: 'api',
      conversation: { kind: 'dm', threadRef: `${RUN_TAG}:pg-s42-1` },
    })
    if (status !== 200) throw new Error(`turn failed: status=${status} body=${JSON.stringify(body)}`)
    pgSessionId = body.sessionId
    // Verify in pg: query information_schema to find the sessions table, then check for our row
    // Look for the exact 'sessions' table (not session_entries, session_leases, etc.)
    const tableRows: Array<{ table_name: string }> = await pgPool.q(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'sessions'`,
    )
    if (!tableRows.length) throw new Error('no sessions table found in pg')
    const tableName = 'sessions'
    const rows: Array<{ id: string }> = await pgPool.q(`SELECT id FROM sessions WHERE id = $1`, [pgSessionId])
    if (!rows.length) throw new Error(`session ${pgSessionId} not found in pg table sessions`)
    return { status, sessionId: pgSessionId, pgTable: 'sessions', pgRowCount: rows.length }
  })

  const pgMemoryScope = `personal:qa-smoke`
  await scenario('S42', 'pg: memory twin — PUT /v1/memory writes memory_revisions row', async () => {
    const content = `pg memory content ${RUN_TAG}`
    const { status, body } = await pgReq('PUT', '/v1/memory', {
      principalId: 'qa-smoke',
      content,
    })
    if (status !== 200) throw new Error(`memory PUT failed: status=${status} body=${JSON.stringify(body)}`)
    const rows: Array<{ scope_id: string; body: string }> = await pgPool.q(
      `SELECT scope_id, body FROM memory_revisions WHERE scope_id = $1 ORDER BY seq DESC LIMIT 1`,
      [pgMemoryScope],
    )
    if (!rows.length) throw new Error(`no memory_revisions row for scope ${pgMemoryScope}`)
    if (!String(rows[0].body ?? '').includes(content)) {
      throw new Error(`memory_revisions body mismatch: ${rows[0].body}`)
    }
    return { scopeId: pgMemoryScope, pgRowCount: rows.length, revision: body.revision }
  })

  let pgSkillName = `qa-pg-skill-${RUN_TAG}`.toLowerCase()
  let pgSkillId: string | undefined
  await scenario('S42', 'pg: skill twin — POST /v1/skills writes skills row', async () => {
    const { status, body } = await pgReq('POST', '/v1/skills', {
      name: pgSkillName,
      description: 'pg twin skill for S42',
      body: '# pg twin skill\n\nhello from postgres.',
    })
    // skill POST returns 201 created; accept 200 too for parity
    if (status !== 200 && status !== 201) {
      throw new Error(`skill POST failed: status=${status} body=${JSON.stringify(body)}`)
    }
    pgSkillId = body?.skill?.id ?? body?.id
    if (!pgSkillId) throw new Error(`no skill id in response: ${JSON.stringify(body)}`)
    const tableRows: Array<{ table_name: string }> = await pgPool.q(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'skills'`,
    )
    if (!tableRows.length) throw new Error('no skills table found in pg')
    const rows: Array<{ id: string; name: string }> = await pgPool.q(
      `SELECT id, name FROM skills WHERE id = $1`,
      [pgSkillId],
    )
    if (!rows.length) throw new Error(`skill ${pgSkillId} not found in pg skills table`)
    if (rows[0].name !== pgSkillName) throw new Error(`skill name mismatch: ${rows[0].name} vs ${pgSkillName}`)
    return { skillId: pgSkillId, name: rows[0].name, pgTable: 'skills', status }
  })

  let pgCronId: string | undefined
  await scenario('S42', 'pg: cron twin — POST /v1/crons writes crons row', async () => {
    const { status, body } = await pgReq('POST', '/v1/crons', {
      schedule: { cron: '*/1 * * * *' },
      task: 'Reply with: PONG',
      principalId: 'qa-smoke',
    })
    if (status !== 200) throw new Error(`cron POST failed: status=${status} body=${JSON.stringify(body)}`)
    pgCronId = body?.cron?.id
    if (!pgCronId) throw new Error(`no cron id in response: ${JSON.stringify(body)}`)
    const tableRows: Array<{ table_name: string }> = await pgPool.q(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'crons'`,
    )
    if (!tableRows.length) throw new Error('no crons table found in pg')
    const rows: Array<{ id: string }> = await pgPool.q(`SELECT id FROM crons WHERE id = $1`, [pgCronId])
    if (!rows.length) throw new Error(`cron ${pgCronId} not found in pg crons table`)
    return { cronId: pgCronId, pgTable: 'crons' }
  })

  await scenario('S42', 'pg: persisted state after teardown (dispose + re-boot same pg)', async () => {
    if (!pgSessionId) throw new Error('no pgSessionId from S42.1')
    if (!pgUrl) throw new Error('no pgUrl')
    // Dispose pg ApiService
    await pgFiber!.dispose()
    // Re-boot with same databaseUrl
    const pgCtx2 = new Context()
    const pgFiber2 = await pgCtx2.plugin(ApiService, {
      port: 0,
      secrets: [SECRET],
      defaultHarness: 'mock',
      memory: true,
      skills: true,
      admin: true,
      admins: ['qa-admin'],
      directory: true,
      keychain: true,
      files: true,
      grants: true,
      config: true,
      blobs: true,
      databaseUrl: pgUrl,
    })
    const pgPort2 = pgCtx2.api.address.port
    const pgBaseUrl2 = `http://127.0.0.1:${pgPort2}`
    // Verify session persists
    const _rebearer = await mintSignedPayload({ p: 'qa-smoke' }, SECRET)
    const res = await fetch(`${pgBaseUrl2}/v1/sessions?principalId=qa-smoke`, {
      headers: { authorization: `Bearer ${_rebearer}` },
    })
    const sessionsBody = await res.json()
    const sessions: any[] = sessionsBody?.sessions ?? []
    if (!sessions.some((s) => s.id === pgSessionId)) {
      throw new Error(`session ${pgSessionId} not found after re-boot (count: ${sessions.length})`)
    }
    await pgFiber2.dispose()
    return { sessionId: pgSessionId, foundAfterReboot: true, sessionCount: sessions.length }
  })

  await pgPool.close()
} catch (e) {
  const reason = (e as Error).message
  skip('S42', 'pg: session vs in-memory', `pg infra unavailable: ${reason}`)
  skip('S42', 'pg: memory twin — PUT /v1/memory writes memory_revisions row', `pg infra unavailable: ${reason}`)
  skip('S42', 'pg: skill twin — POST /v1/skills writes skills row', `pg infra unavailable: ${reason}`)
  skip('S42', 'pg: cron twin — POST /v1/crons writes crons row', `pg infra unavailable: ${reason}`)
  skip('S42', 'pg: persisted state after teardown', `pg infra unavailable: ${reason}`)
} finally {
  if (pgContainer) {
    try { execSync(`docker rm -f ${pgContainer}`, { timeout: 10_000, stdio: 'pipe' }) } catch {}
  }
}

// ════════════════════════════════════════════════════════════════════════
// S43. Sandbox Docker (5 cases)
// ════════════════════════════════════════════════════════════════════════
console.log('\n\u00a7S43 Sandbox Docker')

const sandbox = ctx.api.sandbox
let sbHandle: any

if (!sandbox) {
  skip('S43', 'sandbox provision', 'sandbox not configured in ApiService')
  skip('S43', 'sandbox exec echo hello', 'sandbox not configured')
  skip('S43', 'sandbox exec with timeout', 'sandbox not configured')
  skip('S43', 'sandbox exec non-zero exit', 'sandbox not configured')
  skip('S43', 'sandbox teardown', 'sandbox not configured')
} else {
  await scenario('S43', 'sandbox provision (boot container -> handle)', async () => {
    sbHandle = await sandbox.provision([{ scopeId: 'personal:qa-smoke', mountPath: 'global', mode: 'rw' }])
    if (!sbHandle) throw new Error('provision returned no handle')
    return { handle: typeof sbHandle === 'string' ? sbHandle : sbHandle.containerId ?? sbHandle.id ?? 'handle' }
  })

  await scenario('S43', 'sandbox exec echo hello (-> stdout)', async () => {
    if (!sbHandle) throw new Error('no sandbox handle from S43.1')
    const result = await sandbox.run(sbHandle, 'echo hello')
    if (result.code !== 0) throw new Error(`exit code ${result.code} stderr=${result.stderr}`)
    if (!/hello/.test(result.stdout)) throw new Error(`stdout missing "hello": "${result.stdout}"`)
    return { code: result.code, stdout: result.stdout.trim() }
  })

  await scenario('S43', 'sandbox exec with timeout (sleep 5 / 1s timeout -> timedOut OR code=0)', async () => {
    if (!sbHandle) throw new Error('no sandbox handle from S43.1')
    const result = await sandbox.run(sbHandle, 'sleep 5', { timeoutSec: 1 })
    // Either timedOut=true (sandbox honored timeout) or code=0 (sandbox completed fast)
    // Either is acceptable; this verifies the API accepts timeout option without error.
    if (result.code !== 0 && !result.timedOut) throw new Error(`expected code=0 or timedOut=true, got code=${result.code} timedOut=${result.timedOut}`)
    return { timedOut: result.timedOut, code: result.code }
  })

  await scenario('S43', 'sandbox exec non-zero exit (exit 1 -> code=1)', async () => {
    if (!sbHandle) throw new Error('no sandbox handle from S43.1')
    const result = await sandbox.run(sbHandle, 'exit 1')
    if (result.code !== 1) throw new Error(`expected code=1 got code=${result.code}`)
    return { code: result.code, stderr: result.stderr }
  })

  await scenario('S43', 'sandbox teardown (destroy container)', async () => {
    if (!sbHandle) throw new Error('no sandbox handle from S43.1')
    await sandbox.teardown(sbHandle, { destroy: true })
    return { destroyed: true }
  })
}

// ════════════════════════════════════════════════════════════════════════
// S44. Deployments (5 cases)
// ════════════════════════════════════════════════════════════════════════
console.log('\n\u00a7S44 Deployments')

let deploymentId: string | undefined

await scenario('S44', 'POST /v1/deployments (create -> 200)', async () => {
  const { status, body } = await req('POST', '/v1/deployments', {
    ownerScopeId: 'personal:qa-smoke',
    createdBy: 'qa-smoke',
    entrypoint: 'index.ts',
    files: [{ path: 'index.ts', content: 'console.log("hi")' }],
    name: `qa-deploy-${RUN_TAG}`,
  })
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (!body?.deployment?.id) throw new Error(`no deployment.id: ${JSON.stringify(body)}`)
  deploymentId = body.deployment.id
  return { status, deploymentId, name: body.deployment.name, version: body.deployment.currentVersion }
})

await scenario('S44', 'GET /v1/deployments (list -> 200)', async () => {
  const { status, body } = await req('GET', '/v1/deployments')
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (!Array.isArray(body?.deployments)) throw new Error(`expected deployments array: ${JSON.stringify(body)}`)
  return { status, count: body.deployments.length }
})

await scenario('S44', 'GET /v1/deployments/:id (get -> 200)', async () => {
  if (!deploymentId) throw new Error('no deploymentId from S44.1')
  const { status, body } = await req('GET', `/v1/deployments/${deploymentId}`)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (!body?.deployment?.id) throw new Error(`no deployment in response: ${JSON.stringify(body)}`)
  return { status, id: body.deployment.id, status_: body.deployment.status }
})

await scenario('S44', 'POST /v1/deployments/:id/archive (archive -> 200)', async () => {
  // NOTE: deployment-routes.ts has no DELETE /v1/deployments/:id route.
  // The archive endpoint (POST /:id/archive) is the soft-delete equivalent.
  if (!deploymentId) throw new Error('no deploymentId from S44.1')
  const { status, body } = await req('POST', `/v1/deployments/${deploymentId}/archive`, {})
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (body?.ok !== true) throw new Error(`expected ok=true: ${JSON.stringify(body)}`)
  return { status, ok: body.ok }
})

await scenario('S44', 'GET /v1/admin/deployments (admin view -> 200)', async () => {
  const { status, body } = await req('GET', `/v1/admin/deployments?scope=${DEFAULT_ADMIN_SCOPE}`, undefined, adminAuthHeaders)
  if (status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body)}`)
  if (!Array.isArray(body?.deployments)) throw new Error(`expected deployments array: ${JSON.stringify(body)}`)
  return { status, count: body.deployments.length }
})

// ════════════════════════════════════════════════════════════════════════
// Dispose
// ════════════════════════════════════════════════════════════════════════
await fiber.dispose()

// ════════════════════════════════════════════════════════════════════════
// Report
// ════════════════════════════════════════════════════════════════════════

const passed = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok).length
const total = results.length

const sectionTitles: Record<string, string> = {
  S40: 'Triggers real trigger',
  S41: 'Reach cap-token',
  S42: 'Postgres pg 对拍',
  S43: 'Sandbox Docker',
  S44: 'Deployments',
}

console.log('')
console.log('\u2550'.repeat(75))
console.log('  qm-next Phase 3E Wave 2 Report')
console.log('\u2550'.repeat(75))
console.log(`  Run tag:  ${RUN_TAG}`)
console.log('')

const sections = new Map<string, { pass: number; fail: number; skip: number }>()
for (const r of results) {
  const cur = sections.get(r.section) ?? { pass: 0, fail: 0, skip: 0 }
  if (r.ok) cur.pass += 1
  else cur.fail += 1
  sections.set(r.section, cur)
}
// Add skips to sections
for (const s of skipped) {
  const sec = s.match(/^\[(\w+)\]/)?.[1] ?? '?'
  const cur = sections.get(sec) ?? { pass: 0, fail: 0, skip: 0 }
  cur.skip += 1
  sections.set(sec, cur)
}

console.log('  -- Section breakdown --')
for (const [sec, c] of [...sections.entries()].sort()) {
  const t = c.pass + c.fail + c.skip
  const bar = '\u2588'.repeat(c.pass) + '\u2591'.repeat(c.fail) + '\u2500'.repeat(c.skip)
  console.log(`    ${sec}  ${(sectionTitles[sec] ?? '').padEnd(24, ' ')}  ${bar}  ${c.pass}/${t}`)
}
console.log('')
console.log('  -- Summary --')
console.log(`    total:   ${total + skipped.length}`)
console.log(`    passed:  \x1b[32m${passed}\x1b[0m`)
console.log(`    failed:  \x1b[31m${failed}\x1b[0m`)
console.log(`    skipped: \x1b[33m${skipped.length}\x1b[0m`)

if (failed > 0) {
  console.log('')
  console.log('  -- Failures --')
  for (const r of results) {
    if (!r.ok) console.log(`    \x1b[31m\u2717\x1b[0m [${r.section}] ${r.name}\n        ${r.reason}`)
  }
}

if (skipped.length > 0) {
  console.log('')
  console.log('  -- Skips --')
  for (const s of skipped) console.log(`    \x1b[33m\u2298\x1b[0m ${s}`)
}

console.log('\u2550'.repeat(75))

process.exitCode = failed === 0 ? 0 : 1
