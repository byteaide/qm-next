/**
 * Keychain route tests (11.0 tranche 2): save/list/overview/delete, the
 * grant lifecycle (create, use via grant, revoke), the ask lifecycle
 * (create, decline by owner) and the error-shape contract (KeychainError →
 * {error:"keychain"}; no capability → 401; no keychain → 404).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createKeychain, deriveConnectorKey } from '@qm/credentials'
import { createMemoryMap } from '@qm/store'
import { mintSignedPayload } from '../src/index.ts'
import { createApiServer } from '../src/server.ts'

const SECRET = 'keychain-test-secret'

function auth(t: string): Record<string, string> {
  return { authorization: `Bearer ${t}` }
}

async function token(p: string): Promise<string> {
  return mintSignedPayload({ p }, SECRET)
}

function appWithKeychain(): ReturnType<typeof createApiServer> {
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey(SECRET),
  })
  const app = createApiServer(
    {
      orchestrator: {} as never,
      sessions: {} as never,
      runs: {} as never,
      resolution: { resolve: async () => ({ systemPrompt: '', orgScopeId: 'org:t' }), scopeFor: () => 'org:t' },
      keychain: {
        keychain: () => keychain,
        scopeFor: (actorId) => `personal:${actorId}`,
      },
    },
    { secrets: [SECRET] },
  )
  return app
}

test('keychain: no capability → 401; no keychain wired → 404', async () => {
  const bare = createApiServer(
    {
      orchestrator: {} as never,
      sessions: {} as never,
      runs: {} as never,
      resolution: { resolve: async () => ({ systemPrompt: '', orgScopeId: 'org:t' }), scopeFor: () => 'org:t' },
    },
    { secrets: [SECRET] },
  )
  const anon = await bare.inject({ method: 'GET', url: '/v1/keychain/credentials' })
  assert.equal(anon.statusCode, 404)
  await bare.close()

  const app = appWithKeychain()
  const unauthorized = await app.inject({ method: 'GET', url: '/v1/keychain/credentials' })
  assert.equal(unauthorized.statusCode, 401)
  assert.deepEqual(unauthorized.json(), {
    error: 'unauthorized',
    message: 'keychain access requires an agent capability token',
  })
  await app.close()
})

test('keychain: save → list → grant → use via grant → revoke → delete', async () => {
  const app = appWithKeychain()
  const ada = auth(await token('person:ada'))

  const saved = await app.inject({
    method: 'POST',
    url: '/v1/keychain/credentials',
    headers: ada,
    payload: { service: 'Linear', secret: 'lin_api_key_123', envKey: 'LINEAR_API_KEY' },
  })
  assert.equal(saved.statusCode, 200)
  const cred = saved.json().credential
  assert.equal(cred.service, 'linear')

  const listed = await app.inject({ method: 'GET', url: '/v1/keychain/credentials', headers: ada })
  assert.equal(listed.statusCode, 200)
  assert.equal(listed.json().credentials.length, 1)

  const granted = await app.inject({
    method: 'POST',
    url: '/v1/keychain/grants',
    headers: ada,
    payload: { credential: cred.id, mode: 'standing', purpose: 'standup automation' },
  })
  assert.equal(granted.statusCode, 200)
  const grant = granted.json().grant
  assert.equal(grant.mode, 'standing')
  assert.equal(grant.audienceScopeId, 'personal:person:ada')
  assert.ok(granted.json().use)

  // The grant is audience-scoped to ada's personal scope; another actor in a
  // different scope is refused (keychain semantics), the owner can use it.
  const wrongScope = await app.inject({
    method: 'POST',
    url: '/v1/keychain/use',
    headers: auth(await token('person:grace')),
    payload: { grant: grant.id },
  })
  assert.equal(wrongScope.statusCode, 403)

  const useBody = await app.inject({
    method: 'POST',
    url: '/v1/keychain/use',
    headers: ada,
    payload: { grant: grant.id },
  })
  assert.equal(useBody.statusCode, 200)
  assert.match(useBody.headers['content-type'] ?? '', /text\/plain/)
  assert.ok(useBody.body.includes('LINEAR_API_KEY'))

  const revoked = await app.inject({ method: 'POST', url: `/v1/keychain/grants/${grant.id}/revoke`, headers: ada })
  assert.equal(revoked.statusCode, 200)

  const deleted = await app.inject({ method: 'DELETE', url: `/v1/keychain/credentials/${cred.id}`, headers: ada })
  assert.equal(deleted.statusCode, 200)
  const deletedAgain = await app.inject({ method: 'DELETE', url: `/v1/keychain/credentials/${cred.id}`, headers: ada })
  assert.equal(deletedAgain.statusCode, 404)
  await app.close()
})

test('keychain: own use works directly; ask lifecycle gates on the owner', async () => {
  const app = appWithKeychain()
  const ada = auth(await token('person:ada'))
  const grace = auth(await token('person:grace'))

  const saved = await app.inject({
    method: 'POST',
    url: '/v1/keychain/credentials',
    headers: ada,
    payload: { service: 'figma', secret: 'figma-token' },
  })
  const cred = saved.json().credential

  const ownUse = await app.inject({
    method: 'POST',
    url: '/v1/keychain/use',
    headers: ada,
    payload: { credential: cred.id },
  })
  assert.equal(ownUse.statusCode, 200)
  assert.match(ownUse.body, /figma/i)

  const asked = await app.inject({
    method: 'POST',
    url: '/v1/keychain/asks',
    headers: grace,
    payload: { credential: cred.id, purpose: 'export the Q3 frames', requestedMode: 'once' },
  })
  assert.equal(asked.statusCode, 200)
  const ask = asked.json().ask
  assert.equal(asked.json().existing, false)

  const duplicate = await app.inject({
    method: 'POST',
    url: '/v1/keychain/asks',
    headers: grace,
    payload: { credential: cred.id, purpose: 'export the Q3 frames again' },
  })
  assert.equal(duplicate.statusCode, 200)
  assert.equal(duplicate.json().existing, true)

  const visible = await app.inject({ method: 'GET', url: '/v1/keychain/asks', headers: ada })
  assert.equal(visible.statusCode, 200)
  assert.equal(visible.json().asks.length, 1)

  const declined = await app.inject({
    method: 'POST',
    url: `/v1/keychain/asks/${ask.id}/decline`,
    headers: ada,
    payload: { note: 'not now' },
  })
  assert.equal(declined.statusCode, 200)
  assert.equal(declined.json().ask.status, 'declined')

  const overview = await app.inject({ method: 'GET', url: '/v1/keychain/overview', headers: ada })
  assert.equal(overview.statusCode, 200)
  const body = overview.json()
  assert.equal(body.credentials.length, 1)
  assert.deepEqual(body.usage, [])
  assert.ok(Array.isArray(body.grants))
  await app.close()
})

test('keychain: KeychainError maps to {error:"keychain"} with its own status', async () => {
  const app = appWithKeychain()
  const grace = auth(await token('person:grace'))
  const unknownAsk = await app.inject({
    method: 'POST',
    url: '/v1/keychain/asks',
    headers: grace,
    payload: { credential: 'nope', purpose: 'x' },
  })
  assert.equal(unknownAsk.statusCode, 404)
  assert.equal(unknownAsk.json().error, 'keychain')

  const badSave = await app.inject({
    method: 'POST',
    url: '/v1/keychain/credentials',
    headers: grace,
    payload: { service: '', secret: 'x' },
  })
  assert.equal(badSave.statusCode, 400)
  assert.equal(badSave.json().error, 'keychain')
  await app.close()
})
