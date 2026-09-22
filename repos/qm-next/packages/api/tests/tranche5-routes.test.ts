/**
 * Tranche 5 route tests (11.0): search passthrough, the surface-context pull
 * protocol (fulfillment, timeout 504, failure 502, no_conversation 400,
 * pending/result lifecycle), context-policy validation ladder with the
 * optimistic-lock 409, surface-cache ingest + policy, the environment
 * registry with owner mediation, the project store's qm status vocabulary,
 * and the session-state SSE stream.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryDirectoryStore } from '@qm/directory'
import { Context } from '@qm/cordis'
import { createHarnessRouter, createMockHarness, OrchestratorService } from '@qm/orchestrator'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import { createMemorySessionStateBus } from '@qm/runs'
import type { ResolutionService, ScopeId } from '@qm/types'
import {
  createApiServer,
  createMemoryChannelPolicyStore,
  createMemoryEnvironmentRegistry,
  createMemoryProjectStore,
  createMemorySurfaceCacheStore,
  createSurfaceContextQueue,
  mintSignedPayload,
  type ApiDeps,
  type ApiServerOptions,
} from '../src/index.ts'

const SECRET = '[redacted-credential]'
const SCOPE: ScopeId = 'org:test'
const OPTS: ApiServerOptions = { secrets: [SECRET] }

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('search: capability gate, query validation, backend passthrough, unwired 404', async () => {
  const deps = {
    ...baseDeps(),
    search: {
      search: async (query: string, principals: string[]) => ({
        hits: [{ backend: 'grep', query, principals, snippet: 'found it' }],
        failedBackends: ['mail'],
      }),
    },
  }
  const app = createApiServer(deps, OPTS)
  const ada = auth(await token('person:ada'))

  const noToken = await app.inject({ method: 'POST', url: '/v1/search', payload: { query: 'x' } })
  assert.equal(noToken.statusCode, 401)
  assert.equal(noToken.json().error, 'capability_required')

  const empty = await app.inject({ method: 'POST', url: '/v1/search', headers: ada, payload: { query: '   ' } })
  assert.equal(empty.statusCode, 400)

  const hit = await app.inject({ method: 'POST', url: '/v1/search', headers: ada, payload: { query: 'deploy runbook' } })
  assert.equal(hit.statusCode, 200)
  assert.deepEqual(hit.json().hits[0], { backend: 'grep', query: 'deploy runbook', principals: ['person:ada'], snippet: 'found it' })
  assert.deepEqual(hit.json().failedBackends, ['mail'])
  await app.close()

  const unwired = createApiServer({ ...baseDeps(), search: {} }, OPTS)
  const missing = await unwired.inject({ method: 'POST', url: '/v1/search', headers: ada, payload: { query: 'x' } })
  assert.equal(missing.statusCode, 404)
  assert.deepEqual(missing.json(), { error: 'not_found' })
  await unwired.close()
})

test('surface-context: fulfillment, timeout 504, failure 502, no_conversation 400, pending/result lifecycle', async () => {
  const queue = createSurfaceContextQueue({ ttlMs: 60_000 })
  const deps = { ...baseDeps(), context: { queue, fulfillWaitMs: 2_000, pollMs: 10 } }
  const app = createApiServer(deps, OPTS)
  const ada = auth(await token('person:ada'))

  const noToken = await app.inject({ method: 'POST', url: '/v1/surface-context', payload: { channel: '#deploys' } })
  assert.equal(noToken.statusCode, 401)
  assert.equal(noToken.json().error, 'capability_required')

  const noChannel = await app.inject({ method: 'POST', url: '/v1/surface-context', headers: ada, payload: {} })
  assert.equal(noChannel.statusCode, 400)
  assert.equal(noChannel.json().error, 'no_conversation')

  const pending = await app.inject({ method: 'GET', url: '/v1/surface-context/pending', headers: ada })
  assert.equal(pending.statusCode, 200)
  assert.deepEqual(pending.json().requests, [])

  const inflight = app.inject({ method: 'POST', url: '/v1/surface-context', headers: ada, payload: { channel: '#deploys', count: 5, match: 'release' } })
  let request
  for (let i = 0; i < 100 && !request; i += 1) {
    await sleep(10)
    const rows = queue.pending('slack')
    if (rows.length) request = rows[0]
  }
  assert.ok(request, 'the connector sees the pending request')
  assert.equal(request.query.channelName, 'deploys')
  assert.equal(request.query.count, 5)
  assert.equal(request.query.match, 'release')
  const ok = await app.inject({ method: 'POST', url: `/v1/surface-context/${request.id}/result`, headers: ada, payload: { messages: [{ text: 'hello' }], hasMore: true, nextBefore: '42' } })
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(ok.json(), { ok: true })
  const answered = await app.inject({ method: 'POST', url: `/v1/surface-context/${request.id}/result`, headers: ada, payload: { messages: [] } })
  assert.equal(answered.statusCode, 404)
  assert.equal(answered.json().message, 'request expired or already answered')

  const fulfilled = await inflight
  assert.equal(fulfilled.statusCode, 200)
  assert.equal(fulfilled.json().channel, '#deploys')
  assert.deepEqual(fulfilled.json().messages, [{ text: 'hello' }])
  assert.equal(fulfilled.json().hasMore, true)
  assert.equal(fulfilled.json().nextBefore, '42')

  const slow = app.inject({ method: 'POST', url: '/v1/surface-context', headers: ada, payload: { channel: 'C012345' } })
  await sleep(120)
  const timeout = await slow
  assert.equal(timeout.statusCode, 504)
  assert.equal(timeout.json().error, 'surface_timeout')

  const failing = app.inject({ method: 'POST', url: '/v1/surface-context', headers: ada, payload: { channel: '#broken' } })
  await sleep(30)
  const brokenRequest = queue.pending('slack').find((r) => r.query.channelName === 'broken')
  assert.ok(brokenRequest)
  queue.fulfill(brokenRequest.id, { error: 'slack down' })
  const failed = await failing
  assert.equal(failed.statusCode, 502)
  assert.equal(failed.json().error, 'surface_error')
  assert.equal(failed.json().message, 'slack down')

  const channelId = app.inject({ method: 'POST', url: '/v1/surface-context', headers: ada, payload: { channel: 'C0AB12CD' } })
  await sleep(30)
  const byId = queue.pending('slack').find((r) => r.query.channelId === 'C0AB12CD')
  assert.ok(byId)
  queue.fulfill(byId.id, { result: { messages: [] } })
  const byIdReply = await channelId
  assert.equal(byIdReply.statusCode, 200)
  assert.equal(byIdReply.json().channel, undefined)
  await app.close()
})

test('surface-file: missing ts 400, fulfilled download-null subset shape, file-less 502', async () => {
  const queue = createSurfaceContextQueue()
  const deps = { ...baseDeps(), context: { queue, fileFulfillWaitMs: 2_000, pollMs: 10 } }
  const app = createApiServer(deps, OPTS)
  const ada = auth(await token('person:ada'))

  const noTs = await app.inject({ method: 'POST', url: '/v1/surface-file', headers: ada, payload: {} })
  assert.equal(noTs.statusCode, 400)
  assert.match(noTs.json().message, /pass the message's `ts`/)

  const asking = app.inject({ method: 'POST', url: '/v1/surface-file', headers: ada, payload: { ts: '17.9', name: 'log.txt', channel: '#deploys' } })
  await sleep(30)
  const request = queue.pending('slack').find((r) => r.query.file?.ts === '17.9')
  assert.ok(request?.query.file)
  assert.equal(request.query.file.name, 'log.txt')
  assert.equal(request.query.count, 1)
  queue.fulfill(request.id, { result: { file: { blobId: 'blob-1', name: 'log.txt', sizeBytes: 42, mimetype: 'text/plain' } } })
  const got = await asking
  assert.equal(got.statusCode, 200)
  assert.deepEqual(got.json().file, { name: 'log.txt', sizeBytes: 42, mimetype: 'text/plain' })
  assert.equal(got.json().download, null)

  const failing = app.inject({ method: 'POST', url: '/v1/surface-file', headers: ada, payload: { ts: '17.10', channel: '#deploys' } })
  await sleep(30)
  const second = queue.pending('slack').find((r) => r.query.file?.ts === '17.10')
  assert.ok(second)
  queue.fulfill(second.id, { result: { messages: [] } })
  const noFile = await failing
  assert.equal(noFile.statusCode, 502)
  assert.equal(noFile.json().error, 'surface_error')
  await app.close()
})

test('context-policy: defaults, scope validation, bots ledger, optimistic-lock 409', async () => {
  const policyStore = createMemoryChannelPolicyStore()
  const deps = { ...baseDeps(), contextPolicy: { channelPolicy: policyStore } }
  const app = createApiServer(deps, OPTS)
  const ada = auth(await token('person:ada'))

  const badScope = await app.inject({ method: 'GET', url: '/v1/contexts/policy?principalId=person:ada&scope=personal:person:ada', headers: ada })
  assert.equal(badScope.statusCode, 400)
  assert.equal(badScope.json().message, 'ambient policy applies to channel and group scopes only')

  const unset = await app.inject({ method: 'GET', url: '/v1/contexts/policy?principalId=person:ada&scope=channel:C012345', headers: ada })
  assert.equal(unset.statusCode, 200)
  assert.deepEqual(unset.json().policy, { orders: '', bots: {}, ambientEnabled: null, updatedAt: 0 })

  const missingOrders = await app.inject({ method: 'PUT', url: '/v1/contexts/policy', headers: ada, payload: { principalId: 'person:ada', scope: 'channel:C012345' } })
  assert.equal(missingOrders.statusCode, 400)
  assert.equal(missingOrders.json().message, 'orders (string) required')

  const badBot = await app.inject({ method: 'PUT', url: '/v1/contexts/policy', headers: ada, payload: { principalId: 'person:ada', scope: 'channel:C012345', orders: 'ok', bots: { deploybot: { mode: 'nope' } } } })
  assert.equal(badBot.statusCode, 400)
  assert.match(badBot.json().message, /mode must be one of/)

  const badAmbient = await app.inject({ method: 'PUT', url: '/v1/contexts/policy', headers: ada, payload: { principalId: 'person:ada', scope: 'channel:C012345', orders: 'ok', ambientEnabled: 'yes' } })
  assert.equal(badAmbient.statusCode, 400)

  const set = await app.inject({
    method: 'PUT',
    url: '/v1/contexts/policy',
    headers: ada,
    payload: { principalId: 'person:ada', scope: 'channel:C012345', orders: 'never summarize on Fridays', bots: { deploybot: { mode: 'rollup', rollupHours: 4 } }, ambientEnabled: true },
  })
  assert.equal(set.statusCode, 200)
  const view = set.json().policy
  assert.equal(view.orders, 'never summarize on Fridays')
  assert.deepEqual(view.bots, { deploybot: { mode: 'rollup', rollupHours: 4 } })
  assert.equal(view.ambientEnabled, true)
  assert.ok(view.updatedAt > 0)

  const stale = await app.inject({
    method: 'PUT',
    url: '/v1/contexts/policy',
    headers: ada,
    payload: { principalId: 'person:ada', scope: 'channel:C012345', orders: 'v2', baseUpdatedAt: view.updatedAt - 1 },
  })
  assert.equal(stale.statusCode, 409)
  assert.equal(stale.json().error, 'conflict')

  const fresh = await app.inject({
    method: 'PUT',
    url: '/v1/contexts/policy',
    headers: ada,
    payload: { principalId: 'person:ada', scope: 'channel:C012345', orders: 'v2', baseUpdatedAt: view.updatedAt },
  })
  assert.equal(fresh.statusCode, 200)
  assert.equal(fresh.json().policy.orders, 'v2')

  const group = await app.inject({ method: 'PUT', url: '/v1/contexts/policy', headers: ada, payload: { principalId: 'person:ada', scope: 'group:web-project-x', orders: 'group orders' } })
  assert.equal(group.statusCode, 200)
  await app.close()

  const unwired = createApiServer(baseDeps(), OPTS)
  const missing = await unwired.inject({ method: 'GET', url: '/v1/contexts/policy?principalId=person:ada&scope=channel:C012345', headers: ada })
  assert.equal(missing.statusCode, 404)
  await unwired.close()
})

test('context-policy: directory member gate returns 403 for principals outside the scope', async () => {
  const policyStore = createMemoryChannelPolicyStore()
  const directory = createMemoryDirectoryStore()
  await directory.apply({
    provider: 'feishu',
    instanceId: 'main',
    people: [
      { providerUserId: 'ada', type: 'internal' },
      { providerUserId: 'mallory', type: 'internal' },
    ],
    spaces: [
      { spaceId: 'C012345', kind: 'channel', isPrivate: true },
      { spaceId: 'G1', kind: 'group' },
    ],
    spaceMembers: [
      { spaceId: 'C012345', providerUserId: 'ada' },
      { spaceId: 'G1', providerUserId: 'mallory' },
    ],
    syncedAt: Date.now(),
  })
  const deps = { ...baseDeps(), directory: { directory }, contextPolicy: { channelPolicy: policyStore } }
  const app = createApiServer(deps, OPTS)
  const ada = auth(await token('person:ada'))

  const memberGet = await app.inject({ method: 'GET', url: '/v1/contexts/policy?principalId=feishu:ada&scope=channel:C012345', headers: ada })
  assert.equal(memberGet.statusCode, 200)

  const outsiderGet = await app.inject({ method: 'GET', url: '/v1/contexts/policy?principalId=feishu:mallory&scope=channel:C012345', headers: ada })
  assert.equal(outsiderGet.statusCode, 403)
  assert.equal(outsiderGet.json().error, 'forbidden')

  const memberPut = await app.inject({ method: 'PUT', url: '/v1/contexts/policy', headers: ada, payload: { principalId: 'feishu:ada', scope: 'channel:C012345', orders: 'ok' } })
  assert.equal(memberPut.statusCode, 200)

  const outsiderPut = await app.inject({ method: 'PUT', url: '/v1/contexts/policy', headers: ada, payload: { principalId: 'feishu:mallory', scope: 'channel:C012345', orders: 'ok' } })
  assert.equal(outsiderPut.statusCode, 403)

  const groupMember = await app.inject({ method: 'PUT', url: '/v1/contexts/policy', headers: ada, payload: { principalId: 'feishu:mallory', scope: 'group:G1', orders: 'group orders' } })
  assert.equal(groupMember.statusCode, 200)

  const unknownPrincipal = await app.inject({ method: 'PUT', url: '/v1/contexts/policy', headers: ada, payload: { principalId: 'ghost', scope: 'channel:C012345', orders: 'ok' } })
  assert.equal(unknownPrincipal.statusCode, 403)
  await app.close()
})

test('surface-cache: ingest normalization, policy get/set', async () => {
  const policyStore = createMemoryChannelPolicyStore()
  const cache = createMemorySurfaceCacheStore()
  const deps = {
    ...baseDeps(),
    surfaceCache: {
      cache,
      policy: (container: string) => policyStore.get(container),
      setPolicy: (container: string, orders: string, setBy?: string) => policyStore.set(container, orders, { ...(setBy ? { setBy } : {}) }),
    },
  }
  const app = createApiServer(deps, OPTS)
  const ada = auth(await token('person:ada'))

  const empty = await app.inject({ method: 'POST', url: '/v1/surface-cache/ingest', headers: ada, payload: { events: [] } })
  assert.equal(empty.statusCode, 400)
  assert.equal(empty.json().message, 'events[] required')

  const ingest = await app.inject({
    method: 'POST',
    url: '/v1/surface-cache/ingest',
    headers: ada,
    payload: {
      surface: 'slack',
      self: { name: 'qm', mentionId: 'U1' },
      events: [
        { container: 'C012345', ts: '17.1', text: 'ship it', authorId: 'U2', kind: 'channel' },
        { container: 'C012345', ts: '17.2', text: 'updated', editedAt: 5, files: [{ fileId: 'f1', name: 'a.txt' }] },
        { ts: '17.3', text: 'dropped — no container' },
        'not an event',
      ],
    },
  })
  assert.equal(ingest.statusCode, 200)
  assert.deepEqual(ingest.json(), { ok: true, upserted: 2 })
  assert.equal(cache.size(), 2)

  const noPolicy = await app.inject({ method: 'GET', url: '/v1/surface-cache/policy?container=C012345', headers: ada })
  assert.equal(noPolicy.statusCode, 200)
  assert.equal(noPolicy.json().policy, null)

  const missingContainer = await app.inject({ method: 'POST', url: '/v1/surface-cache/policy', headers: ada, payload: { orders: 'x' } })
  assert.equal(missingContainer.statusCode, 400)

  const set = await app.inject({ method: 'POST', url: '/v1/surface-cache/policy', headers: ada, payload: { container: 'C012345', orders: 'cache orders', setBy: 'person:ada' } })
  assert.equal(set.statusCode, 200)
  assert.equal(set.json().policy.orders, 'cache orders')
  assert.equal(set.json().policy.container, 'C012345')

  const got = await app.inject({ method: 'GET', url: '/v1/surface-cache/policy?container=C012345', headers: ada })
  assert.equal(got.json().policy.orders, 'cache orders')
  await app.close()
})

test('environments: create, list with attachments, owner mediation, unknown name', async () => {
  const deps = { ...baseDeps(), environments: { environments: createMemoryEnvironmentRegistry() } }
  const app = createApiServer(deps, OPTS)
  const ada = auth(await token('person:ada'))
  const grace = auth(await token('person:grace'))

  const noName = await app.inject({ method: 'POST', url: '/v1/environments', headers: ada, payload: { name: '  ' } })
  assert.equal(noName.statusCode, 400)
  assert.equal(noName.json().message, 'name (string) required')

  const created = await app.inject({ method: 'POST', url: '/v1/environments', headers: ada, payload: { name: 'staging' } })
  assert.equal(created.statusCode, 200)
  const env = created.json().environment
  assert.equal(env.name, 'staging')
  assert.equal(env.ownerActorId, 'person:ada')
  assert.ok(env.id)

  const list = await app.inject({ method: 'GET', url: '/v1/environments', headers: ada })
  assert.equal(list.statusCode, 200)
  assert.deepEqual(list.json().environments, [{ id: env.id, name: 'staging', ownerActorId: 'person:ada', attachedScopes: [] }])

  const graceList = await app.inject({ method: 'GET', url: '/v1/environments', headers: grace })
  assert.deepEqual(graceList.json().environments, [])

  const attached = await app.inject({ method: 'POST', url: '/v1/environments/attach', headers: ada, payload: { name: 'staging' } })
  assert.equal(attached.statusCode, 200)
  assert.deepEqual(attached.json(), { ok: true, environment: { id: env.id, name: 'staging' } })

  const relisted = await app.inject({ method: 'GET', url: '/v1/environments', headers: ada })
  assert.deepEqual(relisted.json().environments[0].attachedScopes, ['personal:person:ada'])

  const stranger = await app.inject({ method: 'POST', url: '/v1/environments/attach', headers: grace, payload: { name: 'staging' } })
  assert.equal(stranger.statusCode, 403)
  assert.equal(stranger.json().error, 'owner_mediation_required')
  assert.equal(stranger.json().ownerActorId, 'person:ada')

  const unknown = await app.inject({ method: 'POST', url: '/v1/environments/attach', headers: grace, payload: { name: 'production' } })
  assert.equal(unknown.statusCode, 404)
  assert.equal(unknown.json().error, 'environment_not_found')
  assert.equal(unknown.json().message, 'no environment named "production"')
  await app.close()
})

test('projects: create, membership, rename permissions, slack-channel in-use, clear', async () => {
  const deps = { ...baseDeps(), projects: { projects: createMemoryProjectStore({ orgId: 'test' }) } }
  const app = createApiServer(deps, OPTS)
  const ada = auth(await token('person:ada'))
  const grace = auth(await token('person:grace'))

  const missing = await app.inject({ method: 'POST', url: '/v1/projects', headers: ada, payload: { name: 'no principal' } })
  assert.equal(missing.statusCode, 400)

  const created = await app.inject({ method: 'POST', url: '/v1/projects', headers: ada, payload: { principalId: 'person:ada', name: 'web relaunch' } })
  assert.equal(created.statusCode, 201)
  const project = created.json().project
  assert.equal(project.name, 'web relaunch')
  assert.equal(project.ownerId, 'person:ada')
  assert.equal(project.scopeId, `group:web-project-${project.id}`)
  assert.deepEqual(project.members, [{ principalId: 'person:ada', displayName: 'person:ada' }])

  const listed = await app.inject({ method: 'GET', url: '/v1/projects?principalId=person:ada', headers: ada })
  assert.equal(listed.json().projects.length, 1)
  const graceList = await app.inject({ method: 'GET', url: '/v1/projects?principalId=person:grace', headers: grace })
  assert.deepEqual(graceList.json().projects, [])

  const renamed = await app.inject({ method: 'PATCH', url: `/v1/projects/${project.id}`, headers: ada, payload: { principalId: 'person:ada', name: 'web relaunch v2' } })
  assert.equal(renamed.statusCode, 200)
  assert.equal(renamed.json().project.name, 'web relaunch v2')

  const strangerRename = await app.inject({ method: 'PATCH', url: `/v1/projects/${project.id}`, headers: grace, payload: { principalId: 'person:grace', name: 'hijack' } })
  assert.equal(strangerRename.statusCode, 403)
  assert.deepEqual(strangerRename.json(), { error: 'forbidden' })

  const unknown = await app.inject({ method: 'PATCH', url: '/v1/projects/project-missing', headers: ada, payload: { principalId: 'person:ada', name: 'x' } })
  assert.equal(unknown.statusCode, 404)

  const selfMember = await app.inject({ method: 'POST', url: `/v1/projects/${project.id}/members`, headers: ada, payload: { principalId: 'person:ada', memberId: 'person:ada' } })
  assert.equal(selfMember.statusCode, 400)
  assert.equal(selfMember.json().error, 'invalid_member')

  const added = await app.inject({ method: 'POST', url: `/v1/projects/${project.id}/members`, headers: ada, payload: { principalId: 'person:ada', memberId: 'person:grace' } })
  assert.equal(added.statusCode, 200)
  assert.ok(added.json().project.members.some((m: { principalId: string }) => m.principalId === 'person:grace'))
  const graceSees = await app.inject({ method: 'GET', url: '/v1/projects?principalId=person:grace', headers: grace })
  assert.equal(graceSees.json().projects.length, 1)

  const channel = await app.inject({ method: 'PUT', url: `/v1/projects/${project.id}/slack-channel`, headers: ada, payload: { principalId: 'person:ada', channel: '#relaunch' } })
  assert.equal(channel.statusCode, 200)
  assert.deepEqual(channel.json().project.slackChannel, { channelId: 'relaunch', channelName: 'relaunch' })

  const second = await app.inject({ method: 'POST', url: '/v1/projects', headers: grace, payload: { principalId: 'person:grace', name: 'side quest' } })
  const clash = await app.inject({ method: 'PUT', url: `/v1/projects/${second.json().project.id}/slack-channel`, headers: grace, payload: { principalId: 'person:grace', channel: '#relaunch' } })
  assert.equal(clash.statusCode, 409)
  assert.equal(clash.json().error, 'channel_in_use')

  const cleared = await app.inject({ method: 'DELETE', url: `/v1/projects/${project.id}/slack-channel`, headers: ada, payload: { principalId: 'person:ada' } })
  assert.equal(cleared.statusCode, 200)
  assert.equal(cleared.json().project.slackChannel, undefined)

  const removed = await app.inject({ method: 'DELETE', url: `/v1/projects/${project.id}/members/person:grace`, headers: ada, payload: { principalId: 'person:ada' } })
  assert.equal(removed.statusCode, 200)
  assert.ok(!removed.json().project.members.some((m: { principalId: string }) => m.principalId === 'person:grace'))
  await app.close()
})

test('session-state: SSE stream carries the greeting, event frames, and heartbeats', async () => {
  const bus = createMemorySessionStateBus()
  const deps = { ...baseDeps(), sessionState: { bus, heartbeatMs: 40 } }
  const app = createApiServer(deps, OPTS)
  const ada = auth(await token('person:ada'))

  const noToken = await app.inject({ method: 'GET', url: '/v1/session-state/events' })
  assert.equal(noToken.statusCode, 401)

  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  assert.ok(addr && typeof addr === 'object')
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${addr.port}/v1/session-state/events`, {
    headers: ada,
    signal: controller.signal,
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && !(text.includes('"threadRef":"thread:1"') && text.includes('"threadRef":"thread:2"') && text.includes(': ping'))) {
    const chunk = await Promise.race([reader.read(), sleep(300).then(() => ({ done: true, value: undefined }))])
    if (chunk.done || !chunk.value) continue
    text += decoder.decode(chunk.value)
    bus.emit({ threadRef: 'thread:1', sessionId: 's1', state: 'working', at: 1 })
    bus.emit({ threadRef: 'thread:2', state: 'idle', at: 2 })
  }
  assert.ok(text.includes(': open'), 'stream opens with the SSE greeting')
  assert.ok(text.includes('event: session_state'))
  assert.ok(text.includes('"threadRef":"thread:1"'))
  assert.ok(text.includes('"state":"working"'))
  assert.ok(text.includes('"threadRef":"thread:2"'))
  assert.ok(text.includes(': ping'), 'heartbeats arrive on the compressed interval')
  controller.abort()
  await app.close()
})
