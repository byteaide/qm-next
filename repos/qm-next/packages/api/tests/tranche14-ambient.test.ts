/**
 * Tranche 14 route tests (P4 14.0 tranche 1): the admin ambient-judgments
 * view over the real store (list summaries + counts, ?id detail, filters,
 * the unwired empty shape) and the Postgres ambient stores (judgment
 * round-trip, DurableMap-backed cursor adapter) when QM_NEXT_PG_URL is
 * reachable.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Pool } from 'pg'
import { Context } from '@qm/cordis'
import { createMemoryAmbientJudgmentStore } from '@qm/approvals'
import { createHarnessRouter, createMockHarness, OrchestratorService } from '@qm/orchestrator'
import { createMemoryMap, createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { ResolutionService, ScopeId } from '@qm/types'
import {
  adminRoutes,
  createApiServer,
  createMemoryAdminService,
  mintSignedPayload,
  type ApiDeps,
  type ApiServerOptions,
} from '../src/index.ts'
import {
  ambientCursorStoreFrom,
  createAmbientCursorStore,
  createPostgresAmbientJudgmentStore,
} from '../src/services/ambient-stores.ts'

const SECRET = 'test-secret-for-signing-payloads-0123456789'
const SCOPE: ScopeId = 'org:test'
const ORG = 'org:test'
const OPTS: ApiServerOptions = { secrets: [SECRET] }
const pgUrl = process.env.QM_NEXT_PG_URL

function auth(t: string): Record<string, string> {
  return { authorization: `Bearer ${t}` }
}

async function token(p: string): Promise<string> {
  return mintSignedPayload({ p }, SECRET)
}

function resolution(): ResolutionService {
  return {
    resolve: async () => ({ systemPrompt: 'You are a test agent.', orgScopeId: SCOPE }),
    scopeFor: () => SCOPE,
  }
}

function baseDeps(): ApiDeps {
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(createMockHarness())
  const res = resolution()
  return {
    orchestrator: new OrchestratorService(new Context(), {
      sessions: createMemorySessionStore(),
      runs: createMemoryRunStore(),
      harness: registry,
      identity: { isInternal: (p) => p.type === 'internal', audienceIsAllInternal: (a) => a.every((p) => p.type === 'internal') },
      resolution: res,
      rateLimiter: { check: async () => ({ allowed: true }) },
    }),
    sessions: createMemorySessionStore(),
    runs: createMemoryRunStore(),
    resolution: res,
  }
}

function adminDeps(overrides: Partial<Parameters<typeof adminRoutes>[0]> = {}): Parameters<typeof adminRoutes>[0] {
  return {
    admin: createMemoryAdminService({ orgId: 'test', seedAdmins: ['person:ada'] }),
    orgScope: ORG,
    ...overrides,
  }
}

test('admin ambient-judgments: unwired empty shape, real list/counts, id detail and filters', async () => {
  const ada = auth(await token('person:ada'))
  const unwired = createApiServer({ ...baseDeps(), admin: adminDeps() }, OPTS)
  const empty = await unwired.inject({ method: 'GET', url: `/v1/admin/ambient-judgments?scope=${ORG}`, headers: ada })
  assert.equal(empty.statusCode, 200)
  assert.deepEqual(empty.json(), { scopeId: ORG, judgments: [], counts: { act: 0, ignore: 0, fastlane: 0 } })
  await unwired.close()

  const store = createMemoryAmbientJudgmentStore()
  await store.record({
    surface: 'feishu',
    container: 'feishu:oc_chat1',
    decision: 'act',
    reason: 'They need deploy info.',
    prompt: 'ASSISTANT IDENTITY: you are "qm"',
    model: 'test-mini',
    latencyMs: 42,
    tsFrom: '1000',
    tsTo: '1000',
    createdAt: 5_000,
  })
  await store.record({
    surface: 'feishu',
    container: 'feishu:oc_other',
    decision: 'ignore',
    createdAt: 6_000,
  })
  const app = createApiServer({ ...baseDeps(), admin: adminDeps({ ambientJudgments: store }) }, OPTS)

  const list = await app.inject({ method: 'GET', url: `/v1/admin/ambient-judgments?scope=${ORG}`, headers: ada })
  assert.equal(list.statusCode, 200)
  const listBody = list.json()
  assert.equal(listBody.scopeId, ORG)
  assert.equal(listBody.judgments.length, 2)
  assert.deepEqual(listBody.counts, { act: 1, ignore: 1, fastlane: 0 })
  assert.equal(listBody.judgments[0].decision, 'ignore', 'newest first')
  assert.ok(!('prompt' in listBody.judgments[0]), 'summaries strip the prompt body')
  assert.equal(listBody.hasMore, false)

  const filtered = await app.inject({
    method: 'GET',
    url: `/v1/admin/ambient-judgments?scope=${ORG}&container=feishu:oc_chat1`,
    headers: ada,
  })
  assert.equal(filtered.json().judgments.length, 1)
  assert.equal(filtered.json().judgments[0].reason, 'They need deploy info.')
  assert.deepEqual(filtered.json().counts, { act: 1, ignore: 0, fastlane: 0 }, 'counts follow the container filter')

  const byDecision = await app.inject({
    method: 'GET',
    url: `/v1/admin/ambient-judgments?scope=${ORG}&decision=act`,
    headers: ada,
  })
  assert.equal(byDecision.json().judgments.length, 1)
  assert.equal(byDecision.json().judgments[0].model, 'test-mini')

  const id = listBody.judgments[1].id
  const detail = await app.inject({ method: 'GET', url: `/v1/admin/ambient-judgments?scope=${ORG}&id=${id}`, headers: ada })
  assert.equal(detail.statusCode, 200)
  assert.ok(detail.json().judgment.prompt.includes('ASSISTANT IDENTITY'))

  const missing = await app.inject({ method: 'GET', url: `/v1/admin/ambient-judgments?scope=${ORG}&id=99999`, headers: ada })
  assert.equal(missing.statusCode, 404)

  const stranger = auth(await token('person:stranger'))
  const forbidden = await app.inject({ method: 'GET', url: `/v1/admin/ambient-judgments?scope=${ORG}`, headers: stranger })
  assert.equal(forbidden.statusCode, 403)
  await app.close()
})

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

test('postgres ambient judgment store: round-trip, filters and counts', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  if (!(await postgresReachable())) return t.skip('postgres unreachable at QM_NEXT_PG_URL')
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const container = `pg-chat-${suffix}`
  const store = createPostgresAmbientJudgmentStore(pgUrl!, 'test-org')
  await store.record({
    surface: 'feishu',
    container,
    decision: 'act',
    reason: 'pg act reason',
    prompt: 'pg prompt body',
    model: 'pg-mini',
    latencyMs: 7,
    tsFrom: '111',
    tsTo: '111',
    createdAt: 1_000,
  })
  await store.record({ surface: 'feishu', container, decision: 'ignore', createdAt: 2_000 })
  const listed = await store.list({ container })
  assert.equal(listed.length, 2)
  assert.equal(listed[0]!.decision, 'ignore', 'newest first')
  assert.ok(!('prompt' in listed[0]!))
  const full = await store.get(listed[1]!.id!)
  assert.equal(full?.prompt, 'pg prompt body')
  assert.equal(full?.model, 'pg-mini')
  const counts = await store.counts({ container })
  assert.deepEqual(counts, { act: 1, ignore: 1, fastlane: 0 })
  const decisions = await store.list({ container, decision: ['act'] })
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]!.reason, 'pg act reason')
  await store.close()
})

test('postgres ambient cursor store: put/get over the DurableMap adapter', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  if (!(await postgresReachable())) return t.skip('postgres unreachable at QM_NEXT_PG_URL')
  const orgId = `cursor-org-${Date.now()}`
  const store = createAmbientCursorStore(pgUrl!, orgId)
  await store.put('feishu:oc_x', { lastJudgedTs: '42', lastJudgedAt: 100 })
  assert.deepEqual(await store.get('feishu:oc_x'), { lastJudgedTs: '42', lastJudgedAt: 100 })
  assert.equal(await store.get('feishu:oc_missing'), null)
  const adapter = ambientCursorStoreFrom(createMemoryMap())
  await adapter.put('k', { lastJudgedTs: '1' })
  assert.deepEqual(await adapter.get('k'), { lastJudgedTs: '1' })
})
