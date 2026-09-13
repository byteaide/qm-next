import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryMap, type DurableMap } from '@qm/store'
import { createKeychain, deriveConnectorKey } from '@qm/credentials'
import type { KeychainCredential, KeychainGrant, KeychainAsk } from '@qm/types'
import {
  builtInModelCatalog,
  codexOAuthJwtAccountIdFromToken,
  createCustomProviderStore,
  createModelCredentialStore,
  createSubscriptionOAuth,
  createUserModelCredentialStore,
  selectableCatalogForHarness,
  selectableModelCatalog,
  setCustomProviders,
  type ModelCatalogEntry,
} from '../src/index.ts'

test('custom provider store: encrypted keys, statuses, soft delete, enable roundtrip', async () => {
  const backing = createMemoryMap<any>()
  const store = createCustomProviderStore({ backing, keyMaterial: 'test-key-material' })
  assert.deepEqual(await store.enabled(), [])
  await store.upsert(
    { id: 'acme', name: 'Acme', protocol: 'openai', baseUrl: 'https://api.acme.dev/v1', models: [{ id: 'acme-large', name: 'Acme Large', contextWindow: 128_000, maxTokens: 8_192 }] },
    '  sk-acme-secret  ',
    ' admin@example.com ',
  )
  assert.equal(await store.resolveKey('acme'), 'sk-acme-secret')
  const raw = await backing.get('acme')
  assert.ok(raw?.apiKeyEnc && !raw.apiKeyEnc.includes('sk-acme-secret'))
  const statuses = await store.statuses()
  assert.equal(statuses.length, 1)
  assert.equal(statuses[0]!.hasKey, true)
  assert.equal(statuses[0]!.disabled, false)
  assert.equal(statuses[0]!.updatedBy, 'admin@example.com')
  await assert.rejects(store.upsert({ id: 'x', name: 'x', protocol: 'openai', baseUrl: 'https://x/v1', models: [] }, undefined, '  '))
  assert.equal(await store.delete('acme', 'admin@example.com'), true)
  assert.equal(await store.resolveKey('acme'), null)
  assert.deepEqual(await store.enabled(), [])
  assert.equal((await store.statuses())[0]!.disabled, true)
  assert.equal(await store.delete('acme', 'admin@example.com'), false)
  await store.upsert(
    { id: 'acme', name: 'Acme 2', protocol: 'openai', baseUrl: 'https://api.acme.dev/v2', models: [{ id: 'acme-large', name: 'Acme Large', contextWindow: 128_000, maxTokens: 8_192 }] },
    undefined,
    'admin@example.com',
  )
  assert.equal((await store.enabled()).length, 1)
  assert.equal(await store.resolveKey('acme'), 'sk-acme-secret')
})

test('model credential store: admin keys override env fallback, disable semantics, availability', async () => {
  const backing = createMemoryMap<any>()
  const store = createModelCredentialStore({
    backing,
    keyMaterial: 'test-key-material',
    fallback: { anthropic: '  env-anthropic-key  ' },
  })
  assert.equal(await store.resolve('anthropic'), 'env-anthropic-key')
  assert.equal(await store.resolve('openai'), null)
  await store.set('anthropic', 'sk-admin-anthropic', 'admin@example.com')
  assert.equal(await store.resolve('anthropic'), 'sk-admin-anthropic')
  await assert.rejects(store.set('openai', '   ', 'admin@example.com'))
  const statuses = await store.statuses()
  const anthropic = statuses.find((s) => s.provider === 'anthropic')!
  const openai = statuses.find((s) => s.provider === 'openai')!
  const openrouter = statuses.find((s) => s.provider === 'openrouter')!
  assert.equal(anthropic.source, 'admin')
  assert.equal(openai.source, 'absent')
  assert.equal(openrouter.source, 'absent')
  const availability = await store.availability()
  assert.deepEqual(availability, { anthropic: true, openai: false, openrouter: false })
  await store.delete('anthropic', 'admin@example.com')
  assert.equal(await store.resolve('anthropic'), null)
  assert.equal((await store.statuses()).find((s) => s.provider === 'anthropic')!.source, 'admin')
})

test('user model credential store: api keys and oauth logins swap per provider, derived oauth', async () => {
  const mem = () => createMemoryMap<any>() as unknown as DurableMap<KeychainCredential>
  const keychain = createKeychain({
    creds: mem(),
    grants: createMemoryMap<any>() as unknown as DurableMap<KeychainGrant>,
    asks: createMemoryMap<any>() as unknown as DurableMap<KeychainAsk>,
    key: deriveConnectorKey('test-key-material', 'keychain-test'),
    now: () => 1_000,
  })
  const store = createUserModelCredentialStore({ keychain })
  assert.deepEqual(await store.connections('u1'), [])
  assert.equal(await store.get('u1', 'anthropic'), null)
  await store.setApiKey('u1', 'anthropic', '  sk-user-anthropic  ')
  const apiKeyView = await store.get('u1', 'anthropic')
  assert.equal(apiKeyView?.kind, 'apikey')
  assert.equal(apiKeyView?.apiKey, 'sk-user-anthropic')
  await store.setOAuth('u1', 'anthropic', { accessToken: 'at-anthropic', refreshToken: 'rt-anthropic', expiresAt: 1_000_000 })
  const oauthView = await store.get('u1', 'anthropic')
  assert.equal(oauthView?.kind, 'oauth')
  assert.equal(oauthView?.oauth?.expiresAt, 1_000_000)
  assert.equal((await store.connections('u1')).length, 1)
  const derived = await store.derivedOAuth('u1', 'anthropic')
  assert.equal(derived?.accessToken, 'at-anthropic')
  await store.setApiKey('u1', 'anthropic', 'sk-user-back')
  const swapped = await store.get('u1', 'anthropic')
  assert.equal(swapped?.kind, 'apikey')
  assert.equal(await store.derivedOAuth('u1', 'anthropic'), null)
  await assert.rejects(store.setOAuth('u1', 'openai', { accessToken: '  ' }))
  await store.delete('u1', 'anthropic')
  assert.equal(await store.get('u1', 'anthropic'), null)
})

function jwt(claims: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`
}

test('codex account id extraction reads the openai auth claim', () => {
  const accountId = 'acc_123'
  const token = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })
  assert.equal(codexOAuthJwtAccountIdFromToken(token), accountId)
  assert.equal(codexOAuthJwtAccountIdFromToken(jwt({})), undefined)
  assert.equal(codexOAuthJwtAccountIdFromToken('not-a-jwt'), undefined)
})

test('subscription oauth: claude pkce flow and both refresh paths', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchImpl = (async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ url, body })
    if (url === 'https://claude.token.example/token') {
      return new Response(
        JSON.stringify({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }),
        { status: 200 },
      )
    }
    if (url === 'https://auth.openai.com/oauth/token') {
      const futureExp = Math.floor(Date.now() / 1000) + 3600
      return new Response(
        JSON.stringify({ access_token: jwt({ exp: futureExp }), refresh_token: 'rt-rotated', id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_9' } }) }),
        { status: 200 },
      )
    }
    return new Response('nope', { status: 500 })
  }) as typeof fetch

  const oauth = createSubscriptionOAuth({ claudeTokenUrl: 'https://claude.token.example/token', fetchImpl })
  const start = oauth.startClaudeLogin()
  assert.ok(start.authorizeUrl.includes('https://claude.ai/oauth/authorize?'))
  assert.ok(start.authorizeUrl.includes('code_challenge_method=S256'))
  assert.equal(start.verifier.length > 20, true)
  assert.equal(calls.length, 0)

  const claude = await oauth.completeClaudeLogin(' abc#state123 ', start.verifier)
  assert.equal(claude.accessToken, 'at-new')
  assert.equal(claude.refreshToken, 'rt-new')
  assert.ok(claude.expiresAt && claude.expiresAt > Date.now())
  assert.equal(calls[0]!.url, 'https://claude.token.example/token')
  assert.equal(calls[0]!.body.grant_type, 'authorization_code')
  assert.equal(calls[0]!.body.code, 'abc')
  assert.equal(calls[0]!.body.state, 'state123')
  assert.equal(calls[0]!.body.code_verifier, start.verifier)

  const claudeRefresh = await oauth.refreshClaudeTokens('rt-old')
  assert.equal(claudeRefresh.accessToken, 'at-new')
  assert.equal(claudeRefresh.refreshToken, 'rt-new')
  assert.equal(calls[1]!.body.grant_type, 'refresh_token')

  const chatgpt = await oauth.refreshChatGPTTokens('rt-old')
  assert.equal(chatgpt.accessToken.split('.').length, 3)
  assert.equal(chatgpt.refreshToken, 'rt-rotated')
  assert.equal(chatgpt.accountId, 'acc_9')
  assert.ok(chatgpt.expiresAt && chatgpt.expiresAt > Date.now())
})

test('subscription oauth rejects a missing claude endpoint config at call time', async () => {
  const oauth = createSubscriptionOAuth({ claudeTokenUrl: '', fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch })
  await assert.rejects(oauth.refreshClaudeTokens('rt'))
  await assert.rejects(oauth.completeClaudeLogin('abc', 'verifier'))
})

test('model catalog: builtin entries, harness filtering and openrouter fetch cache', async () => {
  setCustomProviders([
    { id: 'acme', name: 'Acme', protocol: 'openai', baseUrl: 'https://api.acme.dev/v1', models: [{ id: 'acme/large', name: 'Acme Large', contextWindow: 128_000, maxTokens: 8_192 }] },
  ])
  const builtIns = builtInModelCatalog()
  assert.ok(builtIns.some((m) => m.id === 'claude-opus-5' && m.provider === 'anthropic'))
  assert.ok(builtIns.some((m) => m.id === 'gpt-5.6-sol' && m.provider === 'openai'))
  assert.ok(builtIns.some((m) => m.id === 'acme/large' && m.provider === 'acme'))

  let fetches = 0
  const payload = {
    data: [
      {
        id: 'vendor/model-a',
        name: 'Model A',
        supported_parameters: ['tools', 'reasoning'],
        context_length: 200_000,
        top_provider: { max_completion_tokens: 16_000 },
        pricing: { prompt: '0.000003', completion: '0.000015' },
        architecture: { input_modalities: ['text', 'image'] },
      },
      { id: 'vendor/model-b', name: 'Model B', supported_parameters: [] },
      { id: 'bad id', name: 'Bad', supported_parameters: ['tools'] },
    ],
  }
  const fetchImpl = (async () => {
    fetches += 1
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-length': String(JSON.stringify(payload).length) } })
  }) as typeof fetch

  const first = await selectableModelCatalog(fetchImpl)
  assert.equal(fetches, 1)
  const vendorA = first.find((m) => m.id === 'vendor/model-a')
  assert.ok(vendorA)
  assert.equal(vendorA.provider, 'openrouter')
  const second = await selectableModelCatalog(fetchImpl)
  assert.equal(fetches, 1)
  assert.equal(second, first)

  const piCatalog = selectableCatalogForHarness(first, 'pi')
  assert.ok(piCatalog.some((m) => m.id === 'vendor/model-a'))
  assert.equal(selectableCatalogForHarness(first, 'claude').some((m) => m.id === 'vendor/model-a'), false)
  const piRows: ModelCatalogEntry[] = piCatalog
  assert.ok(piRows.length > 0)
})
