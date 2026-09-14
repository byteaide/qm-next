/**
 * Admin control-plane suite (12.0): grant store + service guards (qm
 * org-admin ladder, last-org-admin, resolveActor), the scoped sinks
 * (metrics/error/credential-usage/egress/audit), attribution analytics and
 * the invite render. Postgres cases skip when QM_NEXT_PG_URL is
 * unreachable; memory cases always run.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Pool } from 'pg'
import {
  AdminError,
  adminStatusFromGrants,
  cacheHitRatio,
  computeRetention,
  computeUsers,
  createAdminGrantStore,
  createAdminService,
  createAuditLog,
  createCredentialUsageSink,
  createEgressAuditSink,
  createErrorLog,
  createMemoryAdminGrantPersistence,
  createMetricsSink,
  createPostgresAdminGrantStore,
  createPostgresAuditLog,
  createPostgresCredentialUsageSink,
  createPostgresEgressAuditSink,
  createPostgresErrorLog,
  createPostgresMetricsSink,
  forEachAttributedTurn,
  isStablePrefixMiss,
  parseAdminGrants,
  renderInviteEmail,
  samePerson,
  personKey,
  type AdminGrantStore,
  type MetricsSink,
} from '../src/index.ts'

const ORG = 'default'
const ORG_SCOPE = 'org:default'
const pgUrl = process.env.QM_NEXT_PG_URL

async function probePg(): Promise<boolean> {
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

function seededStore(seed?: string[]): AdminGrantStore {
  return createAdminGrantStore(createMemoryAdminGrantPersistence(), {
    ...(seed ? { seed: seed.map((p) => ({ principalId: p, scopeId: ORG_SCOPE, role: 'org_admin' as const })) } : {}),
  })
}

test('grant store seeds once and persists grants', async () => {
  const persist = createMemoryAdminGrantPersistence()
  const store = createAdminGrantStore(persist, {
    seed: [{ principalId: 'alice', scopeId: ORG_SCOPE, role: 'org_admin' }],
  })
  await store.add({ principalId: 'bob', scopeId: ORG_SCOPE, role: 'org_admin', grantedBy: 'alice', createdAt: 1 })
  const list = await store.list()
  assert.equal(list.length, 2)
  const seeded = list.find((g) => g.principalId === 'alice')
  assert.equal(seeded?.grantedBy, 'system')
  await store.revoke('bob', ORG_SCOPE, 'org_admin')
  assert.equal((await store.list()).length, 1)
})

test('admin service enforces the org-admin ladder', async () => {
  const svc = createAdminService(seededStore(['alice']), { orgId: ORG })
  assert.deepEqual(await svc.adminStatusOf('alice'), { isAdmin: true, role: 'org_admin', scopeId: ORG_SCOPE })
  assert.deepEqual(await svc.adminStatusOf('nobody'), { isAdmin: false })
  await assert.rejects(svc.createGrant('mallory', { principalId: 'x', role: 'org_admin', scopeId: ORG_SCOPE }), (
    e,
  ) => e instanceof AdminError && e.status === 403)
  await svc.createGrant('alice', { principalId: 'bob', role: 'org_admin', scopeId: ORG_SCOPE })
  await svc.revokeGrant('alice', 'bob', ORG_SCOPE, 'org_admin')
  assert.equal((await svc.adminStatusOf('bob')).isAdmin, false)
})

test('admin service refuses to revoke the last org admin', async () => {
  const svc = createAdminService(seededStore(['solo']), { orgId: ORG })
  await assert.rejects(svc.revokeGrant('solo', 'solo', ORG_SCOPE, 'org_admin'), (e) => e instanceof AdminError && e.status === 400)
})

test('admin service validates grant input', async () => {
  const svc = createAdminService(seededStore(['alice']), { orgId: ORG })
  await assert.rejects(svc.createGrant('alice', { principalId: '  ', role: 'org_admin', scopeId: ORG_SCOPE }), (e) => e instanceof AdminError && e.status === 400)
  await assert.rejects(
    svc.createGrant('alice', { principalId: 'x', role: 'org_admin', scopeId: 'org:other' }),
    (e) => e instanceof AdminError && e.status === 400,
  )
})

test('resolveActor accepts only same-org id@org headers', () => {
  const svc = createAdminService(seededStore(), { orgId: ORG })
  assert.deepEqual(svc.resolveActor(`alice@${ORG}`), { id: 'alice', type: 'internal' })
  assert.equal(svc.resolveActor('alice@other'), null)
  assert.equal(svc.resolveActor('@org'), null)
  assert.equal(svc.resolveActor('noheader'), null)
  assert.equal(svc.resolveActor(undefined), null)
})

test('person keys fold email case only', () => {
  assert.equal(samePerson('Alice@ORG', 'alice@org'), true)
  assert.equal(samePerson('alice', 'ALICE'), false)
  assert.equal(personKey(' Bob@Org '), 'bob@org')
})

test('adminStatusFromGrants matches case-insensitive email ids', () => {
  const grants = [{ principalId: 'amy@org', scopeId: ORG_SCOPE, role: 'org_admin' as const }]
  assert.equal(adminStatusFromGrants(grants, 'AMY@ORG').isAdmin, true)
  assert.equal(adminStatusFromGrants(grants, 'amy@other').isAdmin, false)
})

test('parseAdminGrants reads the ADMIN_GRANTS env grammar', () => {
  const grants = parseAdminGrants(`u1@${ORG}:org_admin, bad, u2:org_admin`, ORG)
  assert.deepEqual(grants, [
    { principalId: 'u1@' + ORG, scopeId: ORG_SCOPE, role: 'org_admin' },
    { principalId: 'u2', scopeId: ORG_SCOPE, role: 'org_admin' },
  ])
  assert.equal(parseAdminGrants(undefined, ORG), undefined)
})

test('metrics sink records, patches by run and lists', async () => {
  const sink = createMetricsSink()
  sink.record({ totalMs: 10, status: 'done', scopeLabel: ORG_SCOPE, runId: 'r1' })
  sink.record({ totalMs: 20, status: 'done', scopeLabel: ORG_SCOPE, sessionId: 's1' })
  await sink.updateByRunId('r1', { deliverMs: 5 })
  const all = await sink.list()
  assert.equal(all.length, 2)
  const patched = all.find((s) => s.runId === 'r1')
  assert.equal(patched?.deliverMs, 5)
  assert.equal((await sink.list({ sessionId: 's1' })).length, 1)
})

test('cache analytics helpers', () => {
  assert.equal(cacheHitRatio({}), null)
  assert.equal(cacheHitRatio({ cacheRead: 75, cacheWrite: 15, uncachedInput: 10 }), 0.75)
  assert.equal(isStablePrefixMiss({ cacheRead: 1, cacheWrite: 2048, uncachedInput: 0 }), true)
  assert.equal(isStablePrefixMiss({ cacheRead: 900, cacheWrite: 100, uncachedInput: 0 }), false)
})

test('error log records and counts', async () => {
  const log = createErrorLog()
  log.record({ category: 'c', code: 'E1', message: 'boom', scopeLabel: ORG_SCOPE })
  log.record({ category: 'c', code: 'E2', message: 'x', scopeLabel: ORG_SCOPE, sessionId: 's9' })
  assert.equal((await log.list()).length, 2)
  assert.equal((await log.list({ sessionId: 's9' })).length, 1)
  assert.equal(await log.count({ scopeId: ORG_SCOPE }), 2)
  await log.flush()
})

test('credential usage and egress sinks scope by field', async () => {
  const usage = createCredentialUsageSink()
  usage.record({ slug: 'github', host: 'github.com', status: 'ok', scopeLabel: ORG_SCOPE, principalId: 'u1' })
  usage.record({ slug: 'aws', host: 'aws.com', status: 'denied', scopeLabel: 'org:other', principalId: 'u2' })
  assert.equal((await usage.list({ slug: 'github' })).length, 1)

  const egress = createEgressAuditSink()
  egress.record({ source: 'proxy', host: 'x.com', allowed: true, scopeLabel: ORG_SCOPE, verdict: 'ok' })
  const rows = await egress.list({ scopeId: ORG_SCOPE })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.verdict, 'ok')
})

test('audit log records, dedupes recordOnce and filters tail', async () => {
  const log = createAuditLog()
  log.record({ at: 1, principalId: 'u1', action: 'a.read', resource: 'r', scopeLabel: ORG_SCOPE })
  await log.recordOnce?.('k1', { at: 2, principalId: 'u1', action: 'b.read', resource: 'r', scopeLabel: ORG_SCOPE })
  await log.recordOnce?.('k1', { at: 3, principalId: 'u1', action: 'c.read', resource: 'r', scopeLabel: ORG_SCOPE })
  const events = await log.events()
  assert.equal(events.length, 2)
  const tail = await log.tail({ limit: 10, action: 'b.read' })
  assert.equal(tail.length, 1)
  assert.equal((await log.tail({ limit: 10, since: 5 })).length, 0)
})

test('attribution joins windows with turns', () => {
  const seen: string[] = []
  forEachAttributedTurn(
    {
      participants: [
        { sessionId: 's1', principalId: 'u1', validFrom: 0 },
        { sessionId: 's2', principalId: 'u2', validFrom: 5 },
      ],
      turns: [
        { sessionId: 's1', principalId: 'u1', day: 0, turns: 3, lastAt: 9 },
        { sessionId: 's2', principalId: 'u1', day: 1, turns: 1, lastAt: 9 },
      ],
      sessionIds: ['s1'],
    },
    {
      onWindow: (sessionId, w) => seen.push(`w:${sessionId}:${w.principalId}`),
      onTurn: (w, t) => seen.push(`t:${w.principalId}:${t.turns}`),
    },
  )
  assert.deepEqual(seen, ['w:s1:u1', 't:u1:3'])
})

test('retention computes activity windows and cohorts', () => {
  const now = Date.UTC(2026, 8, 14)
  const day = (offset: number) => Math.floor((now - offset * 86_400_000) / 86_400_000)
  const report = computeRetention({
    sessions: [{ id: 's1', type: 'dm', scopeId: ORG_SCOPE, createdAt: 0 }],
    participants: [{ sessionId: 's1', principalId: 'u1', validFrom: 0 }],
    turns: [{ sessionId: 's1', principalId: 'u1', day: day(0), turns: 2, lastAt: now }],
    nowMs: now,
  })
  assert.equal(report.active.dau, 1)
  assert.equal(report.totals.users, 1)
  assert.equal(report.newVsReturning.newUsers, 1)
})

test('users merges attribution with grants', () => {
  const rows = computeUsers({
    participants: [{ sessionId: 's1', principalId: 'u1', validFrom: 3 }],
    turns: [],
    grants: [{ principalId: 'admin', scopeId: ORG_SCOPE, role: 'org_admin' }],
  })
  const admin = rows.find((r) => r.principalId === 'admin')
  const u1 = rows.find((r) => r.principalId === 'u1')
  assert.equal(admin?.admin.isAdmin, true)
  assert.equal(u1?.sessionCount, 1)
  assert.equal(u1?.lastSeenAt, 3)
  assert.ok(rows[0]!.admin.isAdmin)
})

test('invite email renders text and html bodies', () => {
  const mail = renderInviteEmail({
    to: 'new@example.com',
    brandName: 'Acme <Robots>',
    invitedBy: 'alice',
    signInUrl: 'https://acme.test/signin',
    expiresAt: 0,
  })
  assert.match(mail.subject, /invited to Acme/)
  assert.ok(mail.text.includes('https://acme.test/signin'))
  assert.ok(mail.html.includes('&lt;Robots&gt;'))
})

test('postgres sinks round-trip rows', async (t) => {
  if (!(await probePg())) return t.skip('QM_NEXT_PG_URL unreachable')
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  await t.test('metrics', async () => {
    const sink: MetricsSink = createPostgresMetricsSink(pgUrl!)
    sink.record({ totalMs: 7, status: 'done', scopeLabel: ORG_SCOPE, runId: `pg-run-${suffix}` })
    await sink.updateByRunId(`pg-run-${suffix}`, { deliverMs: 3 })
    const rows = await sink.list({ scopeId: ORG_SCOPE })
    const row = rows.find((r) => r.runId === `pg-run-${suffix}`)
    assert.ok(row)
    assert.equal(row.totalMs, 7)
    assert.equal(row.deliverMs, 3)
  })
  await t.test('errors', async () => {
    const sink = createPostgresErrorLog(pgUrl!)
    sink.record({ category: 'c', code: 'E1', message: 'pg boom', scopeLabel: ORG_SCOPE })
    assert.ok((await sink.list({ scopeId: ORG_SCOPE })).some((r) => r.message === 'pg boom'))
    assert.equal(await sink.count({ scopeId: ORG_SCOPE }) >= 1, true)
  })
  await t.test('credential usage + egress', async () => {
    const usage = createPostgresCredentialUsageSink(pgUrl!)
    usage.record({ slug: 'pg-slug', host: 'h', status: 'ok', scopeLabel: ORG_SCOPE, principalId: 'u' })
    assert.ok((await usage.list({ slug: 'pg-slug' })).length >= 1)
    const egress = createPostgresEgressAuditSink(pgUrl!)
    egress.record({ source: 's', host: 'h', allowed: false, scopeLabel: ORG_SCOPE, verdict: 'denied' })
    assert.ok((await egress.list({ scopeId: ORG_SCOPE })).some((r) => r.allowed === false))
  })
  await t.test('audit log + grants', async () => {
    const audit = createPostgresAuditLog(pgUrl!)
    audit.record({ at: Date.now(), principalId: 'u9', action: 'pg.test', resource: 'r', scopeLabel: ORG_SCOPE })
    await audit.recordOnce?.(`pg-once-${suffix}`, {
      at: Date.now(),
      principalId: 'u9',
      action: 'pg.once',
      resource: 'r',
      scopeLabel: ORG_SCOPE,
    })
    const tail = await audit.tail({ limit: 10, action: 'pg.once' })
    assert.equal(tail.length, 1)
    const grants = createAdminGrantStore(createPostgresAdminGrantStore(pgUrl!))
    await grants.add({ principalId: `pg-admin-${suffix}`, scopeId: ORG_SCOPE, role: 'org_admin', grantedBy: 'system', createdAt: 1 })
    assert.ok((await grants.list()).some((g) => g.principalId === `pg-admin-${suffix}`))
    await grants.revoke(`pg-admin-${suffix}`, ORG_SCOPE, 'org_admin')
    assert.equal((await grants.list()).some((g) => g.principalId === `pg-admin-${suffix}`), false)
  })
})
