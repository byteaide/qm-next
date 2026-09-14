/**
 * Surface route tests (11.0 tranche 3): sessions admin face (list/search/
 * get window/entry/patch/title/fork), the agent conversations self-API
 * (capability_required gate, spawn with seed turn over the mock harness,
 * patch, fork), and the additive store contract (memory implementation).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@qm/cordis'
import { createHarnessRouter, createMockHarness, OrchestratorService } from '@qm/orchestrator'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { ResolutionService, ScopeId } from '@qm/types'
import { createApiServer, mintSignedPayload, type ApiDeps, type ApiServerOptions } from '../src/index.ts'

const SECRET = 'surface-test-secret'
const SCOPE: ScopeId = 'org:test'
const OPTS: ApiServerOptions = { secrets: [SECRET] }

function auth(t: string): Record<string, string> {
  return { authorization: `Bearer ${t}` }
}

async function token(p: string): Promise<string> {
  return mintSignedPayload({ p }, SECRET)
}

function buildDeps(): ApiDeps & { sessions: ReturnType<typeof createMemorySessionStore> } {
  const sessions = createMemorySessionStore()
  const runs = createMemoryRunStore()
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(createMockHarness())
  const resolution: ResolutionService = {
    resolve: async () => ({ systemPrompt: 'You are a test agent.', orgScopeId: SCOPE }),
    scopeFor: () => SCOPE,
  }
  const orchestrator = new OrchestratorService(new Context(), {
    sessions,
    runs,
    harness: registry,
    identity: { isInternal: (p) => p.type === 'internal', audienceIsAllInternal: (a) => a.every((p) => p.type === 'internal') },
    resolution,
    rateLimiter: { check: async () => ({ allowed: true }) },
  })
  return {
    orchestrator,
    sessions,
    runs,
    resolution,
    surface: { sessions, orchestrator, scopeFor: () => SCOPE },
  }
}

test('surface sessions: list, get with window, entry, patch, title, fork', async () => {
  const deps = buildDeps()
  const app = createApiServer(deps, OPTS)
  const ada = auth(await token('person:ada'))

  // Seed a session with two user turns through the store directly.
  const session = await deps.sessions.getOrCreateByThread('thread:s1', 'dm', SCOPE, 'web')
  await deps.sessions.addParticipant(session.id, 'person:ada')
  const lease = await deps.sessions.acquireLease(session.id)
  assert.ok(lease.lease)
  const e0 = await deps.sessions.append(lease.lease, { type: 'user', payload: { text: 'hello agent' }, scopeLabel: SCOPE })
  await deps.sessions.append(lease.lease, { type: 'assistant', payload: { text: 'hi human' }, scopeLabel: SCOPE })
  const e2 = await deps.sessions.append(lease.lease, { type: 'user', payload: { text: 'second question' }, scopeLabel: SCOPE })
  await deps.sessions.releaseLease(lease.lease)

  const noParam = await app.inject({ method: 'GET', url: '/v1/sessions', headers: ada })
  assert.equal(noParam.statusCode, 400)
  const list = await app.inject({ method: 'GET', url: '/v1/sessions?principalId=person:ada', headers: ada })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().sessions.length, 1)

  const badWindow = await app.inject({ method: 'GET', url: '/v1/sessions/' + session.id + '?viewer=person:ada&tailTurns=0', headers: ada })
  assert.equal(badWindow.statusCode, 400)
  const windowed = await app.inject({ method: 'GET', url: '/v1/sessions/' + session.id + '?viewer=person:ada&tailTurns=1', headers: ada })
  assert.equal(windowed.statusCode, 200)
  const w = windowed.json()
  assert.equal(w.entries[0].seq, e2.seq)
  assert.ok(w.earlierEntries >= 1)

  const entry = await app.inject({ method: 'GET', url: '/v1/sessions/' + session.id + '/entries/' + e0.seq + '?viewer=person:ada', headers: ada })
  assert.equal(entry.statusCode, 200)
  assert.equal(entry.json().entry.seq, e0.seq)
  const badSeq = await app.inject({ method: 'GET', url: '/v1/sessions/' + session.id + '/entries/-1?viewer=person:ada', headers: ada })
  assert.equal(badSeq.statusCode, 400)

  const patch = await app.inject({
    method: 'POST',
    url: '/v1/sessions/' + session.id,
    headers: ada,
    payload: { principalId: 'person:ada', title: '  my talk  ', pinned: true, color: '#FF00AA' },
  })
  assert.equal(patch.statusCode, 200)
  assert.equal(patch.json().session.title, 'my talk')
  assert.equal(patch.json().session.pinned, true)
  assert.equal(patch.json().session.color, '#ff00aa')
  const badColor = await app.inject({
    method: 'POST',
    url: '/v1/sessions/' + session.id,
    headers: ada,
    payload: { principalId: 'person:ada', color: 'red' },
  })
  assert.equal(badColor.statusCode, 400)

  const titled = await app.inject({ method: 'POST', url: '/v1/sessions/' + session.id + '/title', headers: ada, payload: { principalId: 'person:ada' } })
  assert.equal(titled.statusCode, 200)
  assert.match(titled.json().title, /hello agent/)

  const fork = await app.inject({
    method: 'POST',
    url: '/v1/sessions/' + session.id + '/fork',
    headers: ada,
    payload: { principalId: 'person:ada', upToSeq: e0.seq },
  })
  assert.equal(fork.statusCode, 200)
  assert.equal(fork.json().entriesCopied, 1)
  assert.notEqual(fork.json().session.id, session.id)
  await app.close()
})

test('surface sessions: search hits with snippet; stranger sessions stay invisible', async () => {
  const deps = buildDeps()
  const app = createApiServer(deps, OPTS)
  const session = await deps.sessions.getOrCreateByThread('thread:s2', 'dm', SCOPE, 'web')
  await deps.sessions.addParticipant(session.id, 'person:ada')
  const lease = await deps.sessions.acquireLease(session.id)
  assert.ok(lease.lease)
  await deps.sessions.append(lease.lease, { type: 'user', payload: { text: 'deploy the staging server' }, scopeLabel: SCOPE })
  await deps.sessions.releaseLease(lease.lease)

  const ada = auth(await token('person:ada'))
  const hits = await app.inject({ method: 'GET', url: '/v1/sessions/search?principalId=person:ada&q=staging', headers: ada })
  assert.equal(hits.statusCode, 200)
  assert.equal(hits.json().hits.length, 1)
  assert.equal(hits.json().hits[0].sessionId, session.id)
  assert.match(hits.json().hits[0].snippet, /staging/)

  const grace = auth(await token('person:grace'))
  const invisible = await app.inject({ method: 'GET', url: '/v1/sessions/search?principalId=person:grace&q=staging', headers: grace })
  assert.equal(invisible.statusCode, 200)
  assert.equal(invisible.json().hits.length, 0)
  const stranger = await app.inject({ method: 'GET', url: '/v1/sessions/' + session.id + '?viewer=person:grace', headers: grace })
  assert.equal(stranger.statusCode, 404)
  await app.close()
})

test('surface conversations: capability gate, spawn seeds a turn over the mock harness, patch shape, fork', async () => {
  const deps = buildDeps()
  const app = createApiServer(deps, OPTS)
  const anon = await app.inject({ method: 'GET', url: '/v1/conversations' })
  assert.equal(anon.statusCode, 401)
  assert.deepEqual(anon.json(), { error: 'capability_required', message: 'this endpoint is for the agent self-API' })

  const ada = auth(await token('person:ada'))
  const spawn = await app.inject({
    method: 'POST',
    url: '/v1/conversations',
    headers: ada,
    payload: { text: 'plan the launch', title: 'launch' },
  })
  assert.equal(spawn.statusCode, 202)
  const body = spawn.json()
  assert.equal(body.session.title, 'launch')
  assert.equal(body.turn.status, 'ok')

  const list = await app.inject({ method: 'GET', url: '/v1/conversations', headers: ada })
  assert.equal(list.statusCode, 200)
  const convs = list.json().conversations
  assert.equal(convs.length, 1)
  assert.equal(convs[0].title, 'launch')
  assert.equal(convs[0].archived, false)

  const id = convs[0].id
  const since = await app.inject({ method: 'GET', url: '/v1/conversations/' + id + '?sinceSeq=0', headers: ada })
  assert.equal(since.statusCode, 400)
  const got = await app.inject({ method: 'GET', url: '/v1/conversations/' + id + '?tailTurns=5', headers: ada })
  assert.equal(got.statusCode, 200)
  assert.ok(got.json().entries.length >= 1)

  const patched = await app.inject({ method: 'POST', url: '/v1/conversations/' + id, headers: ada, payload: { archived: true } })
  assert.equal(patched.statusCode, 200)
  assert.deepEqual(patched.json().conversation, { id, title: 'launch', archived: true, pinned: false, color: null })

  const fork = await app.inject({ method: 'POST', url: '/v1/conversations/' + id + '/fork', headers: ada, payload: {} })
  assert.equal(fork.statusCode, 200)
  assert.ok(fork.json().session.id)

  const refused = await app.inject({
    method: 'POST',
    url: '/v1/conversations',
    headers: auth(await mintSignedPayload({ p: 'guest:x', typ: 'guest' }, SECRET)),
    payload: { text: 'hi' },
  })
  assert.equal(refused.statusCode, 409)
  assert.equal(refused.json().error, 'seed_turn_refused')
  assert.equal((await deps.sessions.listByParticipant('guest:x')).length, 0)
  await app.close()
})

test('surface: session-cap gates on portal identity and reports 503 until the control plane', async () => {
  const deps = buildDeps()
  const app = createApiServer(deps, OPTS)
  const anon = await app.inject({ method: 'POST', url: '/v1/session-cap' })
  assert.equal(anon.statusCode, 401)
  const ok = await app.inject({ method: 'POST', url: '/v1/session-cap', headers: auth(await token('person:ada')) })
  assert.equal(ok.statusCode, 503)
  assert.equal(ok.json().error, 'not_configured')
  await app.close()
})
