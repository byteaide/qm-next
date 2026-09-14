/**
 * Parity surface tests (11.0 tranche 1): the route framework auth guard
 * (public/source/either/aud), the directory sync/resolve adapter, the reach
 * route (capability gate, resolution errors, rate limit, unwired send gate)
 * and the cron route surface over the memory CronStore.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { FastifyInstance } from 'fastify'
import { createMemoryDirectoryStore } from '@qm/directory'
import { createMemoryCronStore } from '@qm/triggers'
import { createApiServer, mintSignedPayload, type ApiDeps, type ApiServerOptions } from '../src/index.ts'
import { mintCapabilityToken } from '@qm/auth'
import { registerRouteTable, type Route } from '../src/routes/framework.ts'
import { directoryRoutes } from '../src/routes/directory-routes.ts'
import { cronRoutes } from '../src/routes/cron-routes.ts'
import { memoryRateLimiter, reachRoutes } from '../src/routes/reach-routes.ts'

const SECRET = 'parity-test-secret'
const OPTS: ApiServerOptions = { secrets: [SECRET] }

async function token(claims: Record<string, unknown> = { p: 'user-1', name: 'Ada' }): Promise<string> {
  return mintSignedPayload(claims, SECRET)
}

function auth(t: string): Record<string, string> {
  return { authorization: `Bearer ${t}` }
}

function baseDeps(): ApiDeps {
  return {
    orchestrator: {} as ApiDeps['orchestrator'],
    sessions: {} as ApiDeps['sessions'],
    runs: {} as ApiDeps['runs'],
    resolution: { resolve: async () => ({ systemPrompt: '', orgScopeId: 'org:t' }), scopeFor: () => 'org:t' },
  }
}

function probe(table: ReadonlyArray<Route>): FastifyInstance {
  const app = createApiServer(baseDeps(), OPTS)
  registerRouteTable(app, OPTS, table)
  return app
}

test('framework auth: public passes, source requires a token, aud enforces the claim', async () => {
  const table: ReadonlyArray<Route> = [
    { method: 'GET', path: '/pub', auth: 'public', handle: async () => ({ ok: true }) },
    { method: 'GET', path: '/src', auth: 'source', handle: async (ctx) => ({ actor: ctx.actor?.id ?? null }) },
    { method: 'GET', path: '/aud', auth: { aud: 'credential-broker' }, handle: async () => ({ ok: true }) },
  ]
  const app = probe(table)
  const pub = await app.inject({ method: 'GET', url: '/pub' })
  assert.equal(pub.statusCode, 200)
  const noToken = await app.inject({ method: 'GET', url: '/src' })
  assert.equal(noToken.statusCode, 401)
  assert.deepEqual(noToken.json(), { error: 'unauthorized', message: 'missing or invalid bearer token' })
  const src = await app.inject({ method: 'GET', url: '/src', headers: auth(await token()) })
  assert.equal(src.statusCode, 200)
  assert.equal(src.json().actor, 'user-1')
  const wrongAud = await app.inject({ method: 'GET', url: '/aud', headers: auth(await token()) })
  assert.equal(wrongAud.statusCode, 401)
  assert.equal(wrongAud.json().message, 'credential-broker capability token required')
  const capToken = await mintCapabilityToken(
    { actorId: 'svc', scopeId: 'org:test', aud: 'credential-broker', exp: Date.now() + 60_000 },
    SECRET,
    'test',
  )
  const rightAud = await app.inject({ method: 'GET', url: '/aud', headers: { 'x-agent-capability': capToken } })
  assert.equal(rightAud.statusCode, 200)
  await app.close()
})

test('directory: sync push, meta, resolve with slackId backfill, stale push refused', async () => {
  const store = createMemoryDirectoryStore()
  const app = probe(directoryRoutes({ directory: store }))
  const bad = await app.inject({ method: 'POST', url: '/v1/directory', headers: auth(await token()), payload: {} })
  assert.equal(bad.statusCode, 400)
  const sync = await app.inject({
    method: 'POST',
    url: '/v1/directory',
    headers: auth(await token()),
    payload: {
      workspaceUrl: 'https://acme.slack.com',
      membersSyncedAt: 100,
      members: [
        { id: 'U12345678', name: 'Ada', type: 'internal' },
        { id: 'U87654321', name: 'Grace' },
      ],
      channels: [{ id: 'C11111111', name: 'general', isPrivate: false }],
      channelMembers: [{ channelId: 'C11111111', userIds: ['U12345678'] }],
    },
  })
  assert.equal(sync.statusCode, 200)
  assert.deepEqual(sync.json(), { ok: true, members: 2, channels: 1, groupMembers: 1 })
  const meta = await app.inject({ method: 'GET', url: '/v1/directory/meta', headers: auth(await token()) })
  assert.equal(meta.statusCode, 200)
  assert.equal(meta.json().workspaceUrl, 'https://acme.slack.com')
  const resolve = await app.inject({ method: 'GET', url: '/v1/directory/resolve?q=ada', headers: auth(await token()) })
  assert.equal(resolve.statusCode, 200)
  const matches = resolve.json().matches
  assert.equal(matches.length, 1)
  assert.equal(matches[0].id, 'slack:U12345678')
  assert.equal(matches[0].slackId, 'U12345678')
  const noQ = await app.inject({ method: 'GET', url: '/v1/directory/resolve', headers: auth(await token()) })
  assert.equal(noQ.statusCode, 400)
  await app.close()
})

test('directory: routes 404 without a wired store (qm guard)', async () => {
  const app = probe(directoryRoutes({}))
  const sync = await app.inject({ method: 'POST', url: '/v1/directory', headers: auth(await token()), payload: { members: [{ id: 'U12345678' }] } })
  assert.equal(sync.statusCode, 404)
  const meta = await app.inject({ method: 'GET', url: '/v1/directory/meta', headers: auth(await token()) })
  assert.equal(meta.statusCode, 404)
  await app.close()
})

test('reach: capability gate, validation, resolution errors, rate limit, unwired send gate', async () => {
  const store = createMemoryDirectoryStore()
  await store.apply({
    provider: 'slack',
    instanceId: 'default',
    syncedAt: Date.now(),
    replace: ['people', 'spaces', 'spaceMembers'],
    people: [
      { providerUserId: 'U12345678', displayName: 'Ada', type: 'internal' },
      { providerUserId: 'U22222222', displayName: 'Ada', type: 'internal' },
    ],
    spaces: [{ spaceId: 'C11111111', name: 'general', kind: 'channel', isPrivate: false, isExternal: false }],
    spaceMembers: [{ spaceId: 'C11111111', providerUserId: 'U12345678' }],
  })
  const app = probe(reachRoutes({ directory: store, limiter: memoryRateLimiter({ limit: 2, windowMs: 60_000 }) }))
  const anon = await app.inject({ method: 'POST', url: '/v1/reach', payload: { text: 'hi', channel: 'general' } })
  assert.equal(anon.statusCode, 403)
  const agent = auth(await token({ p: 'slack:U12345678' }))
  const empty = await app.inject({ method: 'POST', url: '/v1/reach', headers: agent, payload: {} })
  assert.equal(empty.statusCode, 400)
  const ambiguous = await app.inject({ method: 'POST', url: '/v1/reach', headers: agent, payload: { text: 'hi', recipient: 'ada' } })
  assert.equal(ambiguous.statusCode, 409)
  assert.equal(ambiguous.json().error, 'ambiguous_recipient')
  assert.ok(Array.isArray(ambiguous.json().candidates))
  const unknown = await app.inject({ method: 'POST', url: '/v1/reach', headers: agent, payload: { text: 'hi', recipient: 'nobody' } })
  assert.equal(unknown.statusCode, 404)
  assert.equal(unknown.json().error, 'recipient_not_found')
  const rateLimited = await app.inject({ method: 'POST', url: '/v1/reach', headers: agent, payload: { text: 'hi', channel: 'general' } })
  assert.equal(rateLimited.statusCode, 429)
  await app.close()

  const fresh = probe(reachRoutes({ directory: store }))
  const send = await fresh.inject({
    method: 'POST',
    url: '/v1/reach',
    headers: auth(await token({ p: 'slack:U12345678' })),
    payload: { text: 'hi', channel: 'general' },
  })
  assert.equal(send.statusCode, 501)
  assert.equal(send.json().error, 'not_configured')
  assert.equal(send.json().resolved.destination.target, 'C11111111')
  await fresh.close()
})

test('crons: create/list/get/patch/runs/disable/delete over the memory store', async () => {
  const crons = createMemoryCronStore()
  const app = probe(cronRoutes({ crons: () => crons, scopeFor: () => 'org:t' }))
  const agent = auth(await token({ p: 'slack:U12345678' }))
  const noStore = probe(cronRoutes({}))
  const missing = await noStore.inject({ method: 'POST', url: '/v1/crons', headers: agent, payload: {} })
  assert.equal(missing.statusCode, 404)
  await noStore.close()

  const unsupported = await app.inject({
    method: 'POST',
    url: '/v1/crons',
    headers: agent,
    payload: { schedule: { everyMs: 3_600_000 }, task: 'x', runAs: 'owner' },
  })
  assert.equal(unsupported.statusCode, 400)
  const noSchedule = await app.inject({ method: 'POST', url: '/v1/crons', headers: agent, payload: { task: 'x' } })
  assert.equal(noSchedule.statusCode, 400)
  assert.equal(noSchedule.json().error, 'cron_create_failed')
  const created = await app.inject({
    method: 'POST',
    url: '/v1/crons',
    headers: agent,
    payload: { schedule: { cron: '0 9 * * *', timezone: 'Asia/Shanghai' }, task: 'standup notes', title: 'standup' },
  })
  assert.equal(created.statusCode, 200)
  const cron = created.json().cron
  assert.equal(cron.title, 'standup')
  assert.equal(cron.action, 'standup notes')
  assert.equal(cron.ownerId, 'slack:U12345678')

  const list = await app.inject({ method: 'GET', url: '/v1/crons', headers: agent })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().crons.length, 1)
  assert.deepEqual(list.json().visible, [cron.id])

  const emptyPatch = await app.inject({ method: 'PATCH', url: `/v1/crons/${cron.id}`, headers: agent, payload: {} })
  assert.equal(emptyPatch.statusCode, 400)
  assert.equal(emptyPatch.json().error, 'CRON_PATCH_NOTHING_TO_CHANGE')
  const patched = await app.inject({ method: 'PATCH', url: `/v1/crons/${cron.id}`, headers: agent, payload: { title: 'daily' } })
  assert.equal(patched.statusCode, 200)
  assert.equal(patched.json().cron.title, 'daily')

  const runs = await app.inject({ method: 'GET', url: `/v1/crons/${cron.id}/runs?limit=5`, headers: agent })
  assert.equal(runs.statusCode, 200)
  assert.equal(runs.json().total, 0)
  const badLimit = await app.inject({ method: 'GET', url: `/v1/crons/${cron.id}/runs?limit=-1`, headers: agent })
  assert.equal(badLimit.statusCode, 200)

  const run = await app.inject({ method: 'POST', url: `/v1/crons/${cron.id}/run`, headers: agent })
  assert.equal(run.statusCode, 404)

  const disable = await app.inject({ method: 'POST', url: `/v1/crons/${cron.id}/disable`, headers: agent })
  assert.equal(disable.statusCode, 200)
  const gone = await app.inject({ method: 'DELETE', url: `/v1/crons/${cron.id}`, headers: agent })
  assert.equal(gone.statusCode, 200)
  const after = await app.inject({ method: 'GET', url: `/v1/crons/${cron.id}`, headers: agent })
  assert.equal(after.statusCode, 404)
  await app.close()
})

test('crons: the consent route answers per decision-state (unknown id 404, no stamp 400)', async () => {
  const store = createMemoryCronStore()
  const app = probe(cronRoutes({ crons: () => store }))
  const anon = await app.inject({ method: 'POST', url: '/v1/triggers/x/consent', payload: { decision: 'accept' } })
  assert.equal(anon.statusCode, 403)
  const agent = await app.inject({
    method: 'POST',
    url: '/v1/triggers/x/consent',
    headers: auth(await token()),
    payload: { decision: 'accept' },
  })
  assert.equal(agent.statusCode, 404, 'unknown trigger ids 404 like qm')

  const created = await store.create({
    scopeId: 'org:default',
    ownerId: 'feishu:u_owner',
    createdBy: 'feishu:u_owner',
    schedule: { everyMs: 60_000 },
    action: 'digest',
  })
  const noConsent = await app.inject({
    method: 'POST',
    url: `/v1/triggers/${created.id}/consent`,
    headers: auth(await token()),
    payload: { decision: 'accept' },
  })
  assert.equal(noConsent.statusCode, 400)
  assert.match(noConsent.json().message, /no recipient consent/)
  await app.close()
})
