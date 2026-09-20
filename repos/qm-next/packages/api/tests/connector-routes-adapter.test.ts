/**
 * Phase 6 connector route adapter tests (plan §Phase 6 slices 2–3,
 * ADR-0009): the routes are thin HTTP adapters over the Connector-owned
 * OAuth service — the full durable loop works through HTTP, duplicate
 * callbacks fail without duplicate tokens, and no token material ever
 * appears in a response body.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@qm/cordis'
import type { OAuthProviderSpec } from '@qm/connectors'
import { createHarnessRouter, createMockHarness, OrchestratorService } from '@qm/orchestrator'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { ResolutionService, ScopeId } from '@qm/types'
import { createApiServer, createMemoryConnectorSurface, mintSignedPayload, type ApiDeps, type ApiServerOptions } from '../src/index.ts'

const SECRET = 'p6-adapter-test-signing-secret'
const SCOPE: ScopeId = 'org:test'
const OPTS: ApiServerOptions = { secrets: [SECRET] }

const PROVIDERS: readonly OAuthProviderSpec[] = [
  { id: 'p6-http', name: 'P6 HTTP Mock', host: 'p6-h.example.test', scopes: ['basic'], clientId: 'cid-http', type: 'mock' },
]

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

test('connectors adapter: full durable loop over HTTP — start, redeem, callback, status, revoke', async () => {
  const surface = createMemoryConnectorSurface(PROVIDERS)
  const app = createApiServer({ ...baseDeps(), connectors: surface }, OPTS)
  const ada = auth(await token('person:ada'))

  // Consent mint requires the oauth-consent audience over HTTP; the
  // service-level mint is the durable path under test (the adapter is
  // a pass-through validated by the 401 + unknown-provider cases).
  const mintForbidden = await app.inject({ method: 'POST', url: '/v1/connectors/oauth/consent/mint', headers: ada, payload: { provider: 'p6-http', principalId: 'person:ada', redirectUri: 'https://app.test/cb' } })
  assert.equal(mintForbidden.statusCode, 401)
  const minted = await surface.oauth.mintConsent({ provider: 'p6-http', principalId: 'person:ada', redirectUri: 'https://app.test/cb' })
  assert.ok(minted.ok)

  const start = await app.inject({ method: 'GET', url: `/v1/connectors/oauth/p6-http/start?state=${encodeURIComponent(minted.state)}`, headers: ada })
  assert.equal(start.statusCode, 200)
  assert.match(start.json().authorizeUrl, /^https:\/\/p6-h\.example\.test\/oauth\/authorize\?/)

  const redeem = await app.inject({ method: 'GET', url: `/v1/connectors/oauth/consent/redeem/${minted.linkId}`, headers: ada })
  assert.equal(redeem.statusCode, 200)
  const { code, state } = redeem.json()
  assert.equal(state, minted.state)
  assert.ok(code)

  const callback = await app.inject({ method: 'GET', url: `/v1/connectors/oauth/p6-http/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}` })
  assert.equal(callback.statusCode, 200)
  const callbackBody = callback.body
  // The mock exchanger derives the token deterministically from the
  // code (`mock-p6-http-<code>`); that sealed value must never appear
  // in any response. The one-time code itself echoes (qm parity).
  assert.ok(!callbackBody.includes('mock-p6-http-'), 'the sealed token value never appears in the callback response')
  assert.equal(callback.json().connected, true)

  const status = await app.inject({ method: 'GET', url: '/v1/connectors/oauth/status?principalId=person:ada', headers: ada })
  assert.equal(status.statusCode, 200)
  assert.equal(status.json().providers['p6-http'].host, 'p6-h.example.test')
  assert.deepEqual(status.json().providers['p6-http'].accountTypes, ['default'])

  const revoke = await app.inject({ method: 'POST', url: '/v1/connectors/oauth/revoke', headers: ada, payload: { principalId: 'person:ada', provider: 'p6-http' } })
  assert.deepEqual(revoke.json(), { ok: true, principalId: 'person:ada', host: 'p6-h.example.test' })
  const statusAfter = await app.inject({ method: 'GET', url: '/v1/connectors/oauth/status?principalId=person:ada', headers: ada })
  assert.deepEqual(statusAfter.json(), { principalId: 'person:ada', providers: {} })
  await app.close()
})

test('connectors adapter: duplicate callback fails without creating a duplicate token', async () => {
  const surface = createMemoryConnectorSurface(PROVIDERS)
  const app = createApiServer({ ...baseDeps(), connectors: surface }, OPTS)
  const minted = await surface.oauth.mintConsent({ provider: 'p6-http', principalId: 'person:ada', redirectUri: 'https://app.test/cb' })
  assert.ok(minted.ok)
  const redeemed = await surface.oauth.redeemConsent(minted.linkId)
  assert.ok(redeemed.ok)
  const url = `/v1/connectors/oauth/p6-http/callback?code=${encodeURIComponent(redeemed.code)}&state=${encodeURIComponent(minted.state)}`

  const first = await app.inject({ method: 'GET', url })
  assert.equal(first.statusCode, 200)
  const second = await app.inject({ method: 'GET', url })
  assert.equal(second.statusCode, 400)
  assert.equal(second.json().error, 'oauth_callback_failed')

  const status = await app.inject({ method: 'GET', url: '/v1/connectors/oauth/status?principalId=person:ada', headers: auth(await token('person:ada')) })
  assert.equal(Object.keys(status.json().providers).length, 1)
  await app.close()
})

test('connectors adapter: host-keyed token registration persists through the vault', async () => {
  const surface = createMemoryConnectorSurface()
  const app = createApiServer({ ...baseDeps(), connectors: surface }, OPTS)
  const ada = auth(await token('person:ada'))

  const set = await app.inject({ method: 'POST', url: '/v1/connectors/token', headers: ada, payload: { host: 'github.com', principalId: 'person:ada', accessToken: 'at-adapter-hostkey-0001' } })
  assert.deepEqual(set.json(), { ok: true })

  // Status over the configured-registry path shows nothing (no
  // providers configured), but the token probe goes through the vault.
  const status = await app.inject({ method: 'GET', url: '/v1/connectors/oauth/status?principalId=person:ada', headers: ada })
  assert.deepEqual(status.json(), { principalId: 'person:ada', providers: {} })
  const st = await surface.tokens.connectorTokenStatus('github.com', 'person:ada', 'default')
  assert.equal(st.connected, true)
  await app.close()
})

test('connectors adapter: no response body ever carries the token plaintext', async () => {
  const surface = createMemoryConnectorSurface(PROVIDERS)
  const app = createApiServer({ ...baseDeps(), connectors: surface }, OPTS)
  const ada = auth(await token('person:ada'))
  await app.inject({ method: 'POST', url: '/v1/connectors/token', headers: ada, payload: { host: 'github.com', principalId: 'person:ada', accessToken: 'at-adapter-redaction-0002' } })

  const bodies: string[] = []
  const status = await app.inject({ method: 'GET', url: '/v1/connectors/oauth/status?principalId=person:ada', headers: ada })
  bodies.push(status.body)
  const catalog = await app.inject({ method: 'GET', url: '/v1/connectors/catalog', headers: ada })
  bodies.push(catalog.body)
  for (const body of bodies) assert.ok(!body.includes('at-adapter-redaction-0002'))
  await app.close()
})
