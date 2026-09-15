/**
 * Memory connectors tests (parity 16.0): OAuth flow + consent link
 * ttl + redeem semantics, AES-256-GCM secret envelope round-trip,
 * browser session encrypt/decrypt round-trip with secret
 * leakage on failed decrypt.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryMap } from '@qm/store'
import {
  createBrowserSessionStore,
  createConsentLinkStore,
  createOAuthFlowStore,
  decryptSecret,
  deriveConnectorKey,
  encryptSecret,
  type OAuthFlow,
  type ConsentLinkRecord,
  type StoredBrowserSession,
} from '../src/index.ts'

test('oauth-flow: start then finish within TTL returns the state', async () => {
  const store = createOAuthFlowStore(createMemoryMap<OAuthFlow>())
  const flowId = await store.start({
    provider: 'slack',
    clientId: 'cid',
    principalId: 'U1',
    scopeId: 'personal:U1',
    redirectUri: 'https://example.com/cb',
    pkceVerifier: 'verifier',
  })
  const rec = await store.finish(flowId)
  assert.ok(rec)
  assert.equal(rec.provider, 'slack')
  assert.equal(rec.pkceVerifier, 'verifier')
  assert.equal(rec.nonce, flowId)
})

test('oauth-flow: finish a second time returns null (single-use)', async () => {
  const store = createOAuthFlowStore(createMemoryMap<OAuthFlow>())
  const flowId = await store.start({
    provider: 'github',
    clientId: 'cid',
    principalId: 'U1',
    scopeId: 'personal:U1',
    redirectUri: 'https://example.com/cb',
    pkceVerifier: 'verifier',
  })
  assert.ok(await store.finish(flowId))
  assert.equal(await store.finish(flowId), null)
})

test('oauth-flow: finish after TTL returns null', async () => {
  const backing = createMemoryMap<OAuthFlow>()
  const store = createOAuthFlowStore(backing, { ttlMs: 100 })
  const flowId = await store.start({
    provider: 'slack',
    clientId: 'cid',
    principalId: 'U1',
    scopeId: 'personal:U1',
    redirectUri: 'https://example.com/cb',
    pkceVerifier: 'verifier',
  })
  await store.finish(flowId, Date.now() + 5_000)
})

test('consent-link: mint, peek (no consume), redeem (consume) semantics', async () => {
  const store = createConsentLinkStore(createMemoryMap<ConsentLinkRecord>(), { ttlMs: 1_000 })
  const { linkId } = await store.mint({
    principalId: 'U1',
    provider: 'slack',
    accountType: 'user',
    redirectUri: 'https://example.com/cb',
  })
  const peeked = await store.peek(linkId)
  assert.equal(peeked.ok, true)
  if (peeked.ok) assert.equal(peeked.rec.principalId, 'U1')
  const peekedAgain = await store.peek(linkId)
  assert.equal(peekedAgain.ok, true)
  const redeemed = await store.redeem(linkId)
  assert.equal(redeemed.ok, true)
  const secondRedeem = await store.redeem(linkId)
  assert.equal(secondRedeem.ok, false)
  if (!secondRedeem.ok) assert.equal(secondRedeem.reason, 'not_found')
})

test('consent-link: expired records are not_found/expired on redeem', async () => {
  const store = createConsentLinkStore(createMemoryMap<ConsentLinkRecord>(), { ttlMs: 100 })
  const { linkId } = await store.mint({
    principalId: 'U1',
    provider: 'slack',
    accountType: 'user',
    redirectUri: 'https://example.com/cb',
  })
  const r = await store.redeem(linkId, Date.now() + 5_000)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.reason, 'expired')
})

test('secret-envelope: round-trip encrypts with v2 prefix and decrypts back', () => {
  const key = deriveConnectorKey('master-key-material')
  const enc = encryptSecret('hunter2', key)
  assert.match(enc, /^v2:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
  assert.equal(decryptSecret(enc, key), 'hunter2')
})

test('secret-envelope: wrong key fails (no plaintext leakage)', () => {
  const k1 = deriveConnectorKey('one')
  const k2 = deriveConnectorKey('two')
  const enc = encryptSecret('top-secret', k1)
  assert.throws(() => decryptSecret(enc, k2))
})

test('browser-session: round-trip stores encrypted at rest, returns plaintext on get', async () => {
  const key = deriveConnectorKey('browser-master')
  const sessions = createMemoryMap<StoredBrowserSession>()
  const store = createBrowserSessionStore({ sessions, key })
  await store.put('U1', JSON.stringify({ cookies: [], origins: [] }))
  const rec = await sessions.get('U1')
  assert.ok(rec)
  assert.notEqual(rec?.stateEnc, '{"cookies":[],"origins":[]}')
  assert.match(rec!.stateEnc, /^v2:/)
  const got = await store.get('U1')
  assert.deepEqual(JSON.parse(got!), { cookies: [], origins: [] })
})

test('browser-session: failed decrypt returns null (does not throw)', async () => {
  const k1 = deriveConnectorKey('one')
  const k2 = deriveConnectorKey('two')
  const sessions = createMemoryMap<StoredBrowserSession>()
  const writer = createBrowserSessionStore({ sessions, key: k1 })
  await writer.put('U1', JSON.stringify({ cookies: [] }))
  const reader = createBrowserSessionStore({ sessions, key: k2 })
  assert.equal(await reader.get('U1'), null)
})

test('browser-session: missing record returns null', async () => {
  const store = createBrowserSessionStore({ sessions: createMemoryMap<StoredBrowserSession>(), key: deriveConnectorKey('x') })
  assert.equal(await store.get('nobody'), null)
})