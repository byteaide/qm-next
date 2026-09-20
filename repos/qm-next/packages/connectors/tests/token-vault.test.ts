/**
 * Connector token vault contract tests (plan §Phase 6, ADR-0016,
 * ADR-0017): seal/open round-trip with ciphertext-only rows at rest,
 * KEK-chain rotation + resealAll, fail-closed construction, payload
 * audit, and §6.5 decrypt counters.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryMap } from '@qm/store'
import { createRunMetricsRegistry, _resetDefaultRunMetricsRegistryForTests } from '@qm/runs'
import {
  createConnectorTokenVault,
  deriveConnectorKey,
  deriveConnectorTokenKeks,
  type SealedConnectorToken,
  type TokenAuditEntry,
} from '../src/index.ts'

function snapshotCounter(registry: ReturnType<typeof createRunMetricsRegistry>, name: string) {
  return registry.snapshot().find((c) => c.name === name)
}

test('token-vault: seal then open round-trips the token', async () => {
  const keks = deriveConnectorTokenKeks(['master-material'])
  const backing = createMemoryMap<SealedConnectorToken>()
  const vault = createConnectorTokenVault({ backing, keks })
  await vault.seal({ host: 'github.com', principalId: 'person:ada', accessToken: 'at-p6-roundtrip-0001', expiresAt: 12345 })
  const opened = await vault.open('github.com', 'person:ada')
  assert.ok(opened)
  assert.equal(opened!.accessToken, 'at-p6-roundtrip-0001')
  assert.equal(opened!.expiresAt, 12345)
})

test('token-vault: durable row carries ciphertext only, no plaintext', async () => {
  const chain = deriveConnectorTokenKeks(['master-material'])
  const backing = createMemoryMap<SealedConnectorToken>()
  const vault = createConnectorTokenVault({ backing, keks: chain })
  await vault.seal({ host: 'github.com', principalId: 'person:ada', accessToken: 'at-p6-plaintext-check-0002', refreshToken: 'rt-p6-plaintext-check-0003' })
  const rows = await backing.all()
  assert.equal(rows.length, 1)
  const row = rows[0]!
  assert.match(row.tokenEnc, /^v2:/)
  assert.ok(!JSON.stringify(row).includes('at-p6-plaintext-check-0002'), 'accessToken must never appear in the durable row')
  assert.ok(!JSON.stringify(row).includes('rt-p6-plaintext-check-0003'), 'refreshToken must never appear in the durable row')
  // Non-secret metadata stays readable (ADR-0016: presence/provider/expiry diagnostics).
  assert.equal(row.principalId, 'person:ada')
  assert.equal(row.host, 'github.com')
  assert.equal(row.keyId, chain[0]!.kid)
})

test('token-vault: open on missing token returns null (audited missing)', async () => {
  const keks = deriveConnectorTokenKeks(['master-material'])
  const audits: TokenAuditEntry[] = []
  const vault = createConnectorTokenVault({ backing: createMemoryMap<SealedConnectorToken>(), keks, audit: (e) => audits.push(e) })
  assert.equal(await vault.open('github.com', 'person:nobody'), null)
  assert.equal(audits.length, 1)
  assert.equal(audits[0]!.outcome, 'missing')
})

test('token-vault: wrong-key decrypt fails closed with audit + error metric', async () => {
  _resetDefaultRunMetricsRegistryForTests()
  const registry = createRunMetricsRegistry()
  const audits: TokenAuditEntry[] = []
  const backing = createMemoryMap<SealedConnectorToken>()
  const writer = createConnectorTokenVault({ backing, keks: deriveConnectorTokenKeks(['key-one']), audit: (e) => audits.push(e), metrics: registry })
  await writer.seal({ host: 'github.com', principalId: 'person:ada', accessToken: 'at-p6-wrongkey-0004' })
  const reader = createConnectorTokenVault({ backing, keks: deriveConnectorTokenKeks(['key-two']), audit: (e) => audits.push(e), metrics: registry })
  assert.equal(await reader.open('github.com', 'person:ada', 'default', 'github'), null)
  const decryptErrors = snapshotCounter(registry, 'oauth_token_decrypt_total')
  assert.ok(decryptErrors)
  assert.equal(decryptErrors!.total, 1)
  assert.deepEqual(decryptErrors!.byLabels[0]!.labels, { provider: 'github', outcome: 'error' })
  const errorAudit = audits.find((a) => a.outcome === 'error')
  assert.ok(errorAudit)
  assert.ok(!JSON.stringify(errorAudit).includes('at-p6-wrongkey-0004'), 'audit entries are payload-free')
})

test('token-vault: KEK chain rotation — old records still open, new seals use the new KEK', async () => {
  const backing = createMemoryMap<SealedConnectorToken>()
  const chain1 = deriveConnectorTokenKeks(['key-one'])
  const v1 = createConnectorTokenVault({ backing, keks: chain1 })
  await v1.seal({ host: 'github.com', principalId: 'person:ada', accessToken: 'at-p6-rot-0005' })

  // Append the new secret: entry 0 encrypts, entry 1 still decrypts.
  const chain2 = deriveConnectorTokenKeks(['key-two', 'key-one'])
  const v2 = createConnectorTokenVault({ backing, keks: chain2 })
  await v2.seal({ host: 'gitlab.com', principalId: 'person:ada', accessToken: 'at-p6-rot-0006' })
  assert.equal((await backing.get('default:person:ada@github.com'))!.keyId, chain1[0]!.kid)
  assert.equal((await backing.get('default:person:ada@gitlab.com'))!.keyId, chain2[0]!.kid)
  assert.equal((await v2.open('github.com', 'person:ada'))!.accessToken, 'at-p6-rot-0005')
  assert.equal((await v2.open('gitlab.com', 'person:ada'))!.accessToken, 'at-p6-rot-0006')
})

test('token-vault: resealAll moves every record under the current KEK', async () => {
  const backing = createMemoryMap<SealedConnectorToken>()
  const v1 = createConnectorTokenVault({ backing, keks: deriveConnectorTokenKeks(['key-one']) })
  await v1.seal({ host: 'github.com', principalId: 'person:ada', accessToken: 'at-p6-reseal-0007' })
  await v1.seal({ host: 'slack.com', principalId: 'person:ada', accessToken: 'at-p6-reseal-0008' })

  const chain2 = deriveConnectorTokenKeks(['key-two', 'key-one'])
  const v2 = createConnectorTokenVault({ backing, keks: chain2 })
  const { total, resealed } = await v2.resealAll()
  assert.equal(total, 2)
  assert.equal(resealed, 2)
  for (const row of await backing.all()) assert.equal(row.keyId, chain2[0]!.kid)
  // After the sweep, the old KEK can be dropped from the chain entirely.
  const v3 = createConnectorTokenVault({ backing, keks: deriveConnectorTokenKeks(['key-two']) })
  assert.equal((await v3.open('github.com', 'person:ada'))!.accessToken, 'at-p6-reseal-0007')
  assert.equal((await v3.open('slack.com', 'person:ada'))!.accessToken, 'at-p6-reseal-0008')
})

test('token-vault: status is metadata-only (needsReconnect without decrypt)', async () => {
  const keks = deriveConnectorTokenKeks(['master-material'])
  const backing = createMemoryMap<SealedConnectorToken>()
  const vault = createConnectorTokenVault({ backing, keks })
  await vault.seal({ host: 'github.com', principalId: 'person:ada', accessToken: 'at-p6-status-0009', refreshToken: 'rt-p6-status-0010', expiresAt: 1 })
  const status = await vault.status('github.com', 'person:ada')
  assert.deepEqual(status, { connected: true, needsReconnect: true })

  await vault.seal({ host: 'slack.com', principalId: 'person:ada', accessToken: 'at-p6-status-0011', expiresAt: Date.now() + 60_000 })
  assert.deepEqual(await vault.status('slack.com', 'person:ada'), { connected: true })

  assert.deepEqual(await vault.status('github.com', 'person:nobody'), { connected: false })
})

test('token-vault: delete removes the record', async () => {
  const keks = deriveConnectorTokenKeks(['master-material'])
  const backing = createMemoryMap<SealedConnectorToken>()
  const vault = createConnectorTokenVault({ backing, keks })
  await vault.seal({ host: 'github.com', principalId: 'person:ada', accessToken: 'at-p6-del-0012' })
  await vault.delete('github.com', 'person:ada')
  assert.deepEqual(await vault.status('github.com', 'person:ada'), { connected: false })
})

test('token-vault: account types key separate records', async () => {
  const keks = deriveConnectorTokenKeks(['master-material'])
  const backing = createMemoryMap<SealedConnectorToken>()
  const vault = createConnectorTokenVault({ backing, keks })
  await vault.seal({ host: 'github.com', principalId: 'person:ada', accessToken: 'at-p6-acct-0013' })
  await vault.seal({ host: 'github.com', principalId: 'person:ada', accessToken: 'at-p6-acct-0014', accountType: 'org' })
  assert.equal((await vault.open('github.com', 'person:ada'))!.accessToken, 'at-p6-acct-0013')
  assert.equal((await vault.open('github.com', 'person:ada', 'org'))!.accessToken, 'at-p6-acct-0014')
})

test('token-vault: decrypt ok ticks oauth_token_decrypt_total', async () => {
  _resetDefaultRunMetricsRegistryForTests()
  const registry = createRunMetricsRegistry()
  const keks = deriveConnectorTokenKeks(['master-material'])
  const vault = createConnectorTokenVault({ backing: createMemoryMap<SealedConnectorToken>(), keks, metrics: registry })
  await vault.seal({ host: 'github.com', principalId: 'person:ada', accessToken: 'at-p6-metric-0015' })
  await vault.open('github.com', 'person:ada', 'default', 'github')
  const counter = snapshotCounter(registry, 'oauth_token_decrypt_total')
  assert.ok(counter)
  assert.deepEqual(counter!.byLabels[0]!.labels, { provider: 'github', outcome: 'ok' })
})

test('token-vault: purpose derivation isolates connector tokens from other surfaces', () => {
  // The whole point of purpose-derived KEKs (ADR-0017): material sealed
  // under another purpose's key must not open connector tokens.
  const connectorKey = deriveConnectorKey('shared-master', 'connector-tokens')
  const browserKey = deriveConnectorKey('shared-master', 'browser-sessions')
  assert.notDeepEqual(connectorKey, browserKey)
})
