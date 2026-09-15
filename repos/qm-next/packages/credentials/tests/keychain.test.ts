/**
 * Keychain contract tests over the memory implementation; PG variants of
 * the same scenarios run when QM_NEXT_PG_URL is set.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryMap, type DurableMap } from '@qm/store'
import type { Keychain, KeychainCredential, KeychainGrant, KeychainAsk } from '@qm/types'
import { createKeychain, decryptSecret, deriveConnectorKey, encryptSecret, renderUseScript } from '../src/index.ts'

const KEY = deriveConnectorKey('test-master-key-material')

export interface KeychainFixture {
  keychain: Keychain
  creds: DurableMap<KeychainCredential>
  grants: DurableMap<KeychainGrant>
  asks: DurableMap<KeychainAsk>
}

export function createMemoryKeychainFixture(
  opts: {
    now?: () => number
    refreshConnector?: Parameters<typeof createKeychain>[0]['refreshConnector']
    orgId?: string
  } = {},
): KeychainFixture {
  const creds = createMemoryMap<KeychainCredential>()
  const grants = createMemoryMap<KeychainGrant>()
  const asks = createMemoryMap<KeychainAsk>()
  const keychain = createKeychain({
    creds,
    grants,
    asks,
    key: KEY,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.refreshConnector ? { refreshConnector: opts.refreshConnector } : {}),
    ...(opts.orgId ? { orgId: () => opts.orgId! } : {}),
  })
  return { keychain, creds, grants, asks }
}

test('secret cipher: encrypt/decrypt round-trip, wrong key fails, legacy fallback', () => {
  const enc = encryptSecret('hunter2', KEY)
  assert.match(enc, /^v2:/)
  assert.equal(decryptSecret(enc, KEY), 'hunter2')
  assert.throws(() => decryptSecret(enc, deriveConnectorKey('other-key')))
  const legacy = deriveConnectorKey('k')
  const rotated = { current: deriveConnectorKey('k2').current, legacy: legacy.legacy, fallbacks: [legacy] }
  assert.equal(decryptSecret(encryptSecret('s', legacy), rotated), 's')
})

test('env credential: save, list, readOwnSecret and materializeOwn round-trip', async () => {
  const { keychain } = createMemoryKeychainFixture()
  const meta = await keychain.save({ ownerId: 'u1', service: 'github', secret: 'tok1', envKey: 'GITHUB_TOKEN' })
  assert.equal(meta.service, 'github')
  assert.equal(meta.envKey, 'GITHUB_TOKEN')
  assert.ok(!('secretEnc' in meta))
  const listed = await keychain.listByOwner('u1')
  assert.equal(listed.length, 1)
  assert.equal(listed[0]!.id, meta.id)
  assert.equal(await keychain.readOwnSecret('u1', meta.id), 'tok1')
  assert.equal(await keychain.readOwnSecret('u2', meta.id), null)
  const owned = await keychain.materializeOwn('u1')
  assert.deepEqual(owned.map((m) => m.env), [[{ key: 'GITHUB_TOKEN', value: 'tok1' }]])
  assert.equal(await keychain.materializeOwn('u2').then((m) => m.length), 0)
})

test('env credential: multi-field fields and default envKey derivation', async () => {
  const { keychain } = createMemoryKeychainFixture()
  await keychain.save({ ownerId: 'u1', service: 'svc-x', fields: [
    { envKey: 'A_KEY', value: 'va' },
    { envKey: 'B_KEY', value: 'vb' },
  ] })
  await keychain.save({ ownerId: 'u1', service: 'svc-y', secret: 'plain' })
  const owned = await keychain.materializeOwn('u1')
  const byService = new Map(owned.map((m) => [m.service, m.env]))
  assert.deepEqual(
    byService.get('svc-x')!.map((e) => e.key).sort(),
    ['A_KEY', 'B_KEY'],
  )
  assert.equal(byService.get('svc-y')![0]!.key, 'SVC_Y_TOKEN')
})

test('file credential: materializeOwnFiles + renderUseScript env form', async () => {
  const { keychain } = createMemoryKeychainFixture()
  await keychain.save({
    ownerId: 'u1',
    service: 'aws-bundle',
    files: [
      { path: '.aws/config', contentBase64: Buffer.from('[default]').toString('base64') },
      { path: '.aws/credentials', contentBase64: Buffer.from('aws_access_key_id=x').toString('base64') },
    ],
  })
  const files = await keychain.materializeOwnFiles('u1')
  assert.equal(files.length, 1)
  assert.equal(files[0]!.files.length, 2)
  const script = renderUseScript({ kind: 'file', ...files[0]! })
  assert.match(script, /AWS_SHARED_CREDENTIALS_FILE/)
  assert.match(script, /AWS_CONFIG_FILE/)
  assert.match(script, /umask 077/)
  const envCred = await keychain.save({ ownerId: 'u1', service: 'github', secret: 'tok1' })
  const owned = await keychain.materializeOwn('u1')
  const useScript = renderUseScript({ kind: 'env', ...owned.find((m) => m.credentialId === envCred.id)! })
  assert.match(useScript, /^export GITHUB_TOKEN=/)
})

test('standing grant: grantsForScope, materializeStanding injection, revoke', async () => {
  const { keychain } = createMemoryKeychainFixture()
  const cred = await keychain.save({ ownerId: 'u1', service: 'github', secret: 'tok1' })
  const grant = await keychain.createGrant({
    credentialId: cred.id,
    ownerId: 'u1',
    audienceScopeId: 'channel:c1',
    mode: 'standing',
    purpose: 'deploy keys',
  })
  const forScope = await keychain.grantsForScope('channel:c1')
  assert.equal(forScope.length, 1)
  assert.equal(forScope[0]!.grant.id, grant.id)
  const injected = await keychain.materializeStanding('channel:c1')
  assert.deepEqual(injected[0]!.env, [{ key: 'GITHUB_TOKEN', value: 'tok1' }])
  assert.equal(injected[0]!.purpose, 'deploy keys')
  assert.equal(await keychain.materializeStanding('channel:c2').then((m) => m.length), 0)
  assert.equal(await keychain.revokeGrant('u1', grant.id), true)
  assert.equal(await keychain.materializeStanding('channel:c1').then((m) => m.length), 0)
})

test('one-time grant: materialize claims exactly once then refuses', async () => {
  const { keychain } = createMemoryKeychainFixture()
  const cred = await keychain.save({ ownerId: 'u1', service: 'github', secret: 'tok1' })
  const grant = await keychain.createGrant({
    credentialId: cred.id,
    ownerId: 'u1',
    audienceScopeId: 'channel:c1',
    mode: 'once',
    purpose: 'one deploy',
  })
  const m = await keychain.materialize(grant.id, 'channel:c1', 'u9')
  assert.equal(m.kind, 'env')
  await assert.rejects(() => keychain.materialize(grant.id, 'channel:c1', 'u9'), /one-time grant already used/)
})

test('grant ownership: only the owner can grant; other scope refused at materialize', async () => {
  const { keychain } = createMemoryKeychainFixture()
  const cred = await keychain.save({ ownerId: 'u1', service: 'github', secret: 'tok1' })
  await assert.rejects(
    () =>
      keychain.createGrant({
        credentialId: cred.id,
        ownerId: 'u2',
        audienceScopeId: 'channel:c1',
        mode: 'once',
        purpose: 'nope',
      }),
    /only the credential's owner/,
  )
  const grant = await keychain.createGrant({
    credentialId: cred.id,
    ownerId: 'u1',
    audienceScopeId: 'channel:c1',
    mode: 'standing',
    purpose: 'ok',
  })
  await assert.rejects(() => keychain.materialize(grant.id, 'channel:c2', 'u9'), /different conversation/)
  await assert.rejects(() => keychain.materialize('missing', 'channel:c1', 'u9'), /unknown grant/)
})

test('asks: dedupe per scope, approve mints grant and adopts, decline records note', async () => {
  const { keychain } = createMemoryKeychainFixture()
  const cred = await keychain.save({ ownerId: 'u1', service: 'github', secret: 'tok1' })
  const first = await keychain.createAsk({
    credentialId: cred.id,
    requesterId: 'u2',
    requesterScopeId: 'channel:c1',
    purpose: 'rotate the deploy key',
  })
  assert.equal(first.existing, false)
  const dup = await keychain.createAsk({
    credentialId: cred.id,
    requesterId: 'u2',
    requesterScopeId: 'channel:c1',
    purpose: 'rotate the deploy key again',
  })
  assert.equal(dup.existing, true)
  assert.equal(dup.ask.id, first.ask.id)
  await assert.rejects(
    () =>
      keychain.createAsk({
        credentialId: cred.id,
        requesterId: 'u1',
        requesterScopeId: 'channel:c1',
        purpose: 'self',
      }),
    /you own this credential/,
  )
  const { ask, grant } = await keychain.approveAsk({
    askId: first.ask.id,
    ownerId: 'u1',
    mode: 'standing',
    purpose: 'sure, standing',
  })
  assert.equal(ask.status, 'approved')
  assert.equal(grant.audienceScopeId, 'channel:c1')
  const adopted = await keychain.resolveAsksForGrant(grant)
  assert.equal(adopted.length, 0)
  const cred2 = await keychain.save({ ownerId: 'u1', service: 'glacier', secret: 'tok2' })
  const ask2 = await keychain.createAsk({
    credentialId: cred2.id,
    requesterId: 'u3',
    requesterScopeId: 'channel:c2',
    purpose: 'need it',
  })
  const declined = await keychain.declineAsk({ askId: ask2.ask.id, ownerId: 'u1', note: 'not now' })
  assert.equal(declined.status, 'declined')
  assert.equal(declined.note, 'not now')
  const unnotified = await keychain.unnotifiedResolvedAsks(Date.now())
  assert.equal(unnotified.some((a) => a.id === declined.id), true)
})

test('service credentials: broker CRUD, conditional writes, secret decryption', async () => {
  let clock = 1_789_436_029_070
  const { keychain } = createMemoryKeychainFixture({ now: () => clock })
  const orgScope = 'org:acme'
  await keychain.setServiceCredential(orgScope, { slug: 'stripe', name: 'Stripe', secret: 'svc-cred-test-fixture', host: 'api.stripe.com' })
  const listed = await keychain.listServiceCredentials(orgScope)
  assert.equal(listed.length, 1)
  assert.equal(listed[0]!.hasSecret, true)
  assert.equal(listed[0]!.enabled, true)
  const secret = await keychain.getServiceCredentialSecret(orgScope, 'stripe')
  assert.equal(secret!.secret, 'svc-cred-test-fixture')
  const updatedAt = listed[0]!.updatedAt
  clock = updatedAt
  assert.equal(await keychain.setServiceCredentialIfCurrent(orgScope, { slug: 'stripe', name: 'Stripe', secret: 'svc-cred-test-fixture', host: 'api.stripe.com' }, updatedAt + 5), null)
  clock = updatedAt
  assert.equal(await keychain.setServiceCredentialIfCurrent(orgScope, { slug: 'stripe', name: 'Stripe', secret: 'svc-cred-test-fixture', host: 'api.stripe.com' }, updatedAt), updatedAt + 1)
  assert.equal(await keychain.deleteServiceCredentialIfCurrent(orgScope, 'stripe', updatedAt + 99), false)
  assert.equal(await keychain.deleteServiceCredentialIfCurrent(orgScope, 'stripe', updatedAt + 1), true)
  assert.equal(await keychain.getServiceCredentialSecret(orgScope, 'stripe'), null)
})

test('connector tokens: status, access token, derived auth and single-flight refresh', async () => {
  let refreshCalls = 0
  let clock = 1_000_000
  const now = () => clock
  const { keychain } = createMemoryKeychainFixture({
    now,
    refreshConnector: async () => {
      refreshCalls += 1
      await new Promise((r) => setTimeout(r, 5))
      return { accessToken: 'at-new', expiresAt: clock + 3_600_000 }
    },
  })
  await keychain.setConnectorToken('app.example.com', 'u1', { accessToken: 'at-old', refreshToken: 'rt1', expiresAt: clock + 4_000_000 })
  const status = await keychain.connectorTokenStatus('app.example.com', 'u1')
  assert.equal(status.connected, true)
  assert.equal(status.hasRefreshToken, true)
  assert.equal(await keychain.connectorAccessToken('app.example.com', 'u1'), 'at-old')
  clock += 4_500_000
  const [a, b] = await Promise.all([
    keychain.connectorAccessToken('app.example.com', 'u1'),
    keychain.connectorAccessToken('app.example.com', 'u1'),
  ])
  assert.equal(a, 'at-new')
  assert.equal(b, 'at-new')
  assert.equal(refreshCalls, 1)
  const derived = await keychain.connectorDerivedAuth('app.example.com', 'u1')
  assert.equal(derived!.accessToken, 'at-new')
  await keychain.deleteConnectorToken('app.example.com', 'u1')
  assert.equal((await keychain.connectorTokenStatus('app.example.com', 'u1')).connected, false)
})

test('expired env credential: materializeOwn skips it; grant creation refuses', async () => {
  let clock = 1_000_000
  const { keychain } = createMemoryKeychainFixture({ now: () => clock })
  await keychain.save({ ownerId: 'u1', service: 'old', secret: 'tok', expiresAt: clock + 1_000 })
  clock += 2_000
  assert.equal((await keychain.materializeOwn('u1')).length, 0)
  const cred = (await keychain.listByOwner('u1'))[0]!
  await assert.rejects(
    () =>
      keychain.createGrant({
        credentialId: cred.id,
        ownerId: 'u1',
        audienceScopeId: 'channel:c1',
        mode: 'once',
        purpose: 'p',
      }),
    /credential is expired/,
  )
})

test('remove: owner can remove own non-managed credential; grants revoke first', async () => {
  const { keychain } = createMemoryKeychainFixture()
  const cred = await keychain.save({ ownerId: 'u1', service: 'github', secret: 'tok1' })
  const grant = await keychain.createGrant({
    credentialId: cred.id,
    ownerId: 'u1',
    audienceScopeId: 'channel:c1',
    mode: 'standing',
    purpose: 'p',
  })
  assert.equal(await keychain.remove('u2', cred.id), false)
  assert.equal(await keychain.remove('u1', cred.id), true)
  const g = await keychain.getGrant(grant.id)
  assert.equal(g!.status, 'revoked')
  assert.equal(await keychain.remove('u1', cred.id), false)
})

test('pg: keychain over Postgres maps matches memory semantics', { skip: process.env.QM_NEXT_PG_URL ? false : 'QM_NEXT_PG_URL not set' }, async () => {
  const { createPgPool, createPostgresMap } = await import('@qm/store')
  const pg = createPgPool(process.env.QM_NEXT_PG_URL!, [])
  const table = `kc_test_${Date.now()}`
  const keychain = createKeychain({
    creds: createPostgresMap<KeychainCredential>(pg, table),
    grants: createPostgresMap<KeychainGrant>(pg, `${table}_g`),
    asks: createPostgresMap<KeychainAsk>(pg, `${table}_a`),
    key: KEY,
  })
  const cred = await keychain.save({ ownerId: 'u1', service: 'github', secret: 'tok1' })
  const grant = await keychain.createGrant({
    credentialId: cred.id,
    ownerId: 'u1',
    audienceScopeId: 'channel:c1',
    mode: 'standing',
    purpose: 'pg parity',
  })
  const injected = await keychain.materializeStanding('channel:c1')
  assert.equal(injected.length, 1)
  assert.equal(await keychain.revokeGrant('u1', grant.id), true)
  await pg.close()
})
