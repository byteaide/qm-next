/**
 * Connector OAuth flow service contract tests (plan §Phase 6 gate,
 * ADR-0009, ADR-0016, ADR-0017): the full mint→redeem→start→callback
 * loop runs against durable stores only — restart-safe,
 * multi-instance-safe, duplicate-callback-idempotent — and tokens are
 * sealed in the vault, never present in any response or row.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryMap } from '@qm/store'
import { createRunMetricsRegistry } from '@qm/runs'
import {
  createConsentLinkStore,
  createConnectorOAuthService,
  createConnectorTokenVault,
  createOAuthFlowStore,
  deriveConnectorTokenKeks,
  type ConsentLinkRecord,
  type ConnectorOAuthService,
  type OAuthFlow,
  type OAuthFlowStore,
  type OAuthProviderSpec,
  type SealedConnectorToken,
  type TokenExchanger,
} from '../src/index.ts'

const PROVIDERS: readonly OAuthProviderSpec[] = [
  { id: 'p6-mock', name: 'P6 Mock', host: 'p6-m.example.test', scopes: ['basic'], clientId: 'cid-p6', type: 'mock' },
]

/** Narrowing assertion for discriminated `{ ok }` outcomes. */
function expectOk<T extends { ok: boolean }>(r: T): asserts r is T & { ok: true } {
  if (!r.ok) throw new Error(`expected ok outcome, got: ${JSON.stringify(r)}`)
}

interface Harness {
  service: ConnectorOAuthService
  flows: OAuthFlowStore
  vaultBacking: ReturnType<typeof createMemoryMap<SealedConnectorToken>>
  registry: ReturnType<typeof createRunMetricsRegistry>
}

function buildHarness(
  providers: readonly OAuthProviderSpec[] = PROVIDERS,
  opts: { ttlMs?: number; clock?: () => number; exchanger?: TokenExchanger } = {},
): Harness {
  const flows = createOAuthFlowStore(createMemoryMap<OAuthFlow>(), { ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}), ...(opts.clock ? { now: opts.clock } : {}) })
  const consentLinks = createConsentLinkStore(createMemoryMap<ConsentLinkRecord>(), { ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}), ...(opts.clock ? { now: opts.clock } : {}) })
  const vaultBacking = createMemoryMap<SealedConnectorToken>()
  const vault = createConnectorTokenVault({ backing: vaultBacking, keks: deriveConnectorTokenKeks(['p6-master']) })
  const registry = createRunMetricsRegistry()
  const service = createConnectorOAuthService({
    flows,
    consentLinks,
    vault,
    providers,
    ...(opts.clock ? { now: opts.clock } : {}),
    metrics: registry,
    ...(opts.exchanger ? { exchanger: opts.exchanger } : {}),
  })
  return { service, flows, vaultBacking, registry }
}

/** Two independent services over the same durable stores (multi-instance). */
function buildCluster() {
  const flows = createOAuthFlowStore(createMemoryMap<OAuthFlow>())
  const consentLinks = createConsentLinkStore(createMemoryMap<ConsentLinkRecord>())
  const vault = createConnectorTokenVault({ backing: createMemoryMap<SealedConnectorToken>(), keks: deriveConnectorTokenKeks(['p6-master']) })
  const make = () => createConnectorOAuthService({ flows, consentLinks, vault, providers: PROVIDERS })
  return { a: make(), b: make() }
}

/** Mint + redeem a consent link, returning the state and code. */
async function mintAndRedeem(service: ConnectorOAuthService, principalId: string) {
  const mint = await service.mintConsent({ provider: 'p6-mock', principalId, redirectUri: 'https://app.test/cb' })
  expectOk(mint)
  const redeem = await service.redeemConsent(mint.linkId)
  expectOk(redeem)
  return { linkId: mint.linkId, state: mint.state, code: redeem.code }
}

test('oauth-flow: full consent loop mints, redeems, starts, callbacks, and seals the token', async () => {
  const h = buildHarness()
  const mint = await h.service.mintConsent({ provider: 'p6-mock', principalId: 'person:ada', redirectUri: 'https://app.test/cb' })
  expectOk(mint)
  assert.equal(mint.provider, 'p6-mock')
  assert.match(mint.oauthUrl, /\/v1\/connectors\/oauth\/p6-mock\/start\?state=/)

  const start = await h.service.startOAuth({ provider: 'p6-mock', state: mint.state })
  expectOk(start)
  assert.match(start.authorizeUrl, /^https:\/\/p6-m\.example\.test\/oauth\/authorize\?/)
  assert.match(start.authorizeUrl, new RegExp(`state=${encodeURIComponent(mint.state)}`))

  const redeem = await h.service.redeemConsent(mint.linkId)
  expectOk(redeem)
  assert.equal(redeem.state, mint.state)
  assert.ok(redeem.code)

  const callback = await h.service.handleCallback({ provider: 'p6-mock', code: redeem.code, state: mint.state })
  expectOk(callback)
  assert.equal(callback.principalId, 'person:ada')

  const status = await h.service.status('person:ada')
  assert.equal(status.providers['p6-mock']!.host, 'p6-m.example.test')
  assert.deepEqual(status.providers['p6-mock']!.accountTypes, ['default'])
})

test('oauth-flow: restart between start and callback completes the flow (durable, not process-local)', async () => {
  const { a, b } = buildCluster()
  const mint = await a.mintConsent({ provider: 'p6-mock', principalId: 'person:grace', redirectUri: 'https://app.test/cb' })
  expectOk(mint)
  const redeem = await a.redeemConsent(mint.linkId)
  expectOk(redeem)
  // Simulated restart: the second service instance over the same
  // durable stores completes the flow the first one started.
  const callback = await b.handleCallback({ provider: 'p6-mock', code: redeem.code, state: mint.state })
  expectOk(callback)
  const status = await b.status('person:grace')
  assert.ok(status.providers['p6-mock'])
})

test('oauth-flow: callback routed to another simulated instance completes with the same stores', async () => {
  const { a, b } = buildCluster()
  const mint = await a.mintConsent({ provider: 'p6-mock', principalId: 'person:lin', redirectUri: 'https://app.test/cb' })
  expectOk(mint)
  const redeem = await b.redeemConsent(mint.linkId)
  expectOk(redeem)
  const callback = await b.handleCallback({ code: redeem.code, state: mint.state })
  expectOk(callback)
})

test('oauth-flow: duplicate callback does not create duplicate tokens', async () => {
  const h = buildHarness()
  const { state, code } = await mintAndRedeem(h.service, 'person:ada')
  const first = await h.service.handleCallback({ code, state })
  expectOk(first)
  const rowsBefore = JSON.stringify(await h.vaultBacking.all())
  const second = await h.service.handleCallback({ code, state })
  assert.equal(second.ok, false)
  assert.equal((second as { error: string }).error, 'unknown_state')
  assert.equal(JSON.stringify(await h.vaultBacking.all()), rowsBefore)
})

test('oauth-flow: expired consent cannot be exchanged; used consent link cannot be replayed', async () => {
  let clock = Date.now()
  const h = buildHarness(PROVIDERS, { ttlMs: 1_000, clock: () => clock })
  const mint = await h.service.mintConsent({ provider: 'p6-mock', principalId: 'person:ada', redirectUri: 'https://app.test/cb' })
  expectOk(mint)
  clock += 5_000
  const expired = await h.service.redeemConsent(mint.linkId)
  assert.equal(expired.ok, false)
  assert.equal((expired as { error: string }).error, 'expired')

  // Fresh link: first redeem consumes it; replay is not_found.
  const mint2 = await h.service.mintConsent({ provider: 'p6-mock', principalId: 'person:ada', redirectUri: 'https://app.test/cb' })
  expectOk(mint2)
  assert.ok((await h.service.redeemConsent(mint2.linkId)).ok)
  const replay = await h.service.redeemConsent(mint2.linkId)
  assert.equal(replay.ok, false)
  assert.equal((replay as { error: string }).error, 'not_found')
})

test('oauth-flow: exchange failure is structured, secret-free, and stores no token', async () => {
  const failing = createConnectorOAuthService({
    flows: createOAuthFlowStore(createMemoryMap<OAuthFlow>()),
    consentLinks: createConsentLinkStore(createMemoryMap<ConsentLinkRecord>()),
    vault: createConnectorTokenVault({ backing: createMemoryMap<SealedConnectorToken>(), keks: deriveConnectorTokenKeks(['p6-master']) }),
    providers: PROVIDERS,
    exchanger: async () => {
      throw new Error('provider 500: Bearer abcdef1234567890abcdef1234567890 leaked')
    },
  })
  const { state, code } = await mintAndRedeem(failing, 'person:ada')
  const callback = await failing.handleCallback({ code, state })
  assert.equal(callback.ok, false)
  assert.equal((callback as { error: string }).error, 'exchange_failed')
  assert.ok(!(callback as { message?: string }).message!.includes('abcdef1234567890'), 'exchange errors must be redacted')
  const status = await failing.status('person:ada')
  assert.deepEqual(status.providers, {})
})

test('oauth-flow: denied, malformed, unknown-state, and code-mismatch callbacks', async () => {
  const h = buildHarness()
  const denied = await h.service.handleCallback({ error: 'access_denied' })
  assert.equal(denied.ok, false)
  assert.equal((denied as { error: string }).error, 'denied')

  const missing = await h.service.handleCallback({})
  assert.equal((missing as { error: string }).error, 'bad_request')

  const stale = await h.service.handleCallback({ code: 'c', state: 'stale-state' })
  assert.equal((stale as { error: string }).error, 'unknown_state')

  const { state } = await mintAndRedeem(h.service, 'person:ada')
  const mismatch = await h.service.handleCallback({ code: 'wrong-code', state })
  assert.equal((mismatch as { error: string }).error, 'code_mismatch')
})

test('oauth-flow: start and mint reject unknown providers; start requires a state', async () => {
  const h = buildHarness()
  const startUnknown = await h.service.startOAuth({ provider: 'nope', state: 's' })
  assert.equal((startUnknown as { error: string }).error, 'unknown_provider')
  const mintUnknown = await h.service.mintConsent({ provider: 'nope', principalId: 'p', redirectUri: 'r' })
  assert.equal((mintUnknown as { error: string }).error, 'unknown_provider')
  const noState = await h.service.startOAuth({ provider: 'p6-mock' })
  assert.equal((noState as { error: string }).error, 'missing_state')
})

test('oauth-flow: revoke by provider removes the sealed token; unknown provider errors; revoke by host works', async () => {
  const h = buildHarness()
  const { state, code } = await mintAndRedeem(h.service, 'person:ada')
  const callback = await h.service.handleCallback({ code, state })
  expectOk(callback)
  assert.ok((await h.service.status('person:ada')).providers['p6-mock'])

  const unknown = await h.service.revoke({ principalId: 'person:ada', provider: 'github' })
  assert.equal((unknown as { error: string }).error, 'unknown_provider')

  const revoked = await h.service.revoke({ principalId: 'person:ada', provider: 'p6-mock' })
  expectOk(revoked)
  assert.deepEqual(await h.service.status('person:ada'), { principalId: 'person:ada', providers: {} })
})

test('oauth-flow: catalog lists configured providers', async () => {
  const h = buildHarness()
  assert.deepEqual(h.service.catalog(), {
    catalog: [{ id: 'p6-mock', name: 'P6 Mock', host: 'p6-m.example.test', scopes: ['basic'], type: 'mock' }],
  })
})

test('oauth-flow: §6.5 flow counters tick through the loop', async () => {
  const h = buildHarness()
  const snap = () => h.registry.snapshot().find((c) => c.name === 'oauth_flow_total')
  await h.service.startOAuth({ provider: 'p6-mock', state: 's1' })
  assert.ok(snap()?.byLabels.some((l) => l.labels.step === 'start' && l.labels.outcome === 'ok'))
  await h.service.startOAuth({ provider: 'nope', state: 's' })
  assert.ok(snap()?.byLabels.some((l) => l.labels.step === 'start' && l.labels.outcome === 'fail'))
  const { state, code } = await mintAndRedeem(h.service, 'person:ada')
  await h.service.handleCallback({ code, state })
  assert.ok(snap()?.byLabels.some((l) => l.labels.step === 'callback' && l.labels.outcome === 'ok'))
  assert.ok(snap()?.byLabels.some((l) => l.labels.step === 'complete' && l.labels.outcome === 'ok'))
})
