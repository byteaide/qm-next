/**
 * Auth control-plane suite (12.0): signed payloads (JOSE + legacy HMAC),
 * capability-token mint/verify incl. blob grants, source-auth signing with
 * replay dedupe (memory and Postgres), the AWS role broker against a fake
 * STS, and portal identity. Postgres cases skip when QM_NEXT_PG_URL is
 * unreachable.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Pool } from 'pg'
import {
  BLOB_TRANSFER_AUD,
  CAPABILITY_TTL_MS,
  brokerSessionName,
  canonicalPayload,
  createAwsRoleBroker,
  createMemoryReplayDedupe,
  createPostgresReplayDedupe,
  createSourceAuth,
  isValidCapabilityTimezone,
  mintCapabilityToken,
  mintSignedPayload,
  signCanonicalRequest,
  signRequest,
  signedRequestHeaders,
  verifyBlobTransferCapability,
  verifyCapabilityToken,
  verifyPortalIdentity,
  verifySignedPayload,
  ALLOW_UNSIGNED_TEST_IDENTITY,
  MissingPortalSecretError,
  requirePortalIdentitySecret,
} from '../src/index.ts'

const SECRET = 'unit-test-signing-secret-0123456789abcdef'
const SECRET2 = 'rotated-signing-secret-9876543210fedcba'
const pgUrl = process.env.QM_NEXT_PG_URL

async function probePg(): Promise<boolean> {
  if (!pgUrl) return false
  const probe = new Pool({ connectionString: pgUrl, connectionTimeoutMillis: 3000 })
  try {
    await probe.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await probe.end().catch(() => undefined)
  }
}

test('signed payloads round-trip and support rotation', async () => {
  const token = await mintSignedPayload({ p: 'alice', exp: 1 }, SECRET)
  assert.deepEqual(await verifySignedPayload(token, [SECRET2, SECRET]), { p: 'alice', exp: 1 })
  assert.equal(await verifySignedPayload(`${token}x`, SECRET), null)
  assert.equal(await verifySignedPayload('garbage', SECRET), null)
})

test('legacy payload.hmac tokens keep verifying', async () => {
  const { createHmac } = await import('node:crypto')
  const payload = Buffer.from(JSON.stringify({ legacy: true })).toString('base64url')
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url')
  assert.deepEqual(await verifySignedPayload(`${payload}.${sig}`, SECRET), { legacy: true })
})

test('capability tokens verify claims and reject tampering', async () => {
  const now = 1_000_000
  const token = await mintCapabilityToken(
    { actorId: 'agent-1', scopeId: 'personal:u', exp: now + CAPABILITY_TTL_MS, grants: ['files'], timezone: 'UTC' },
    SECRET,
    'default',
  )
  const claims = await verifyCapabilityToken(token, SECRET, now)
  assert.equal(claims?.actorId, 'agent-1')
  assert.equal(await verifyCapabilityToken(token, SECRET, now + CAPABILITY_TTL_MS), null)
  assert.equal(await verifyCapabilityToken(token.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')), SECRET, now), null)
  const bad = await mintCapabilityToken({ actorId: 'agent-1', scopeId: 's', exp: now + 1, timezone: 'Not/AZone' }, SECRET, 'default')
  assert.equal(await verifyCapabilityToken(bad, SECRET, now), null)
  const badGrants = await mintCapabilityToken(
    { actorId: 'a', scopeId: 's', exp: now + 1, grants: 'files' as unknown as string[] },
    SECRET,
    'default',
  )
  assert.equal(await verifyCapabilityToken(badGrants, SECRET, now), null)
})

test('capability timezone validator', () => {
  assert.equal(isValidCapabilityTimezone('Asia/Shanghai'), true)
  assert.equal(isValidCapabilityTimezone(' nope '), false)
  assert.equal(isValidCapabilityTimezone(42), false)
})

test('blob transfer capability binds audience, direction and id', async () => {
  const now = Date.now()
  const readToken = await mintCapabilityToken(
    { actorId: 'a', scopeId: 's', aud: BLOB_TRANSFER_AUD, exp: now + 1000, blob: { dir: 'read', id: 'a'.repeat(32) } },
    SECRET,
    'default',
  )
  const ok = await verifyBlobTransferCapability(readToken, SECRET, { dir: 'read', id: 'a'.repeat(32) }, now)
  assert.equal(ok?.blob.dir, 'read')
  assert.equal(await verifyBlobTransferCapability(readToken, SECRET, { dir: 'write' }, now), null)
  assert.equal(await verifyBlobTransferCapability(readToken, SECRET, { dir: 'read', id: 'b'.repeat(32) }, now), null)
  const writeToken = await mintCapabilityToken(
    { actorId: 'a', scopeId: 's', aud: BLOB_TRANSFER_AUD, exp: now + 1000, blob: { dir: 'write' } },
    SECRET,
    'default',
  )
  assert.ok(await verifyBlobTransferCapability(writeToken, SECRET, { dir: 'write' }, now))
  const wrongAud = await mintCapabilityToken(
    { actorId: 'a', scopeId: 's', aud: 'control-plane', exp: now + 1000, blob: { dir: 'write' } },
    SECRET,
    'default',
  )
  assert.equal(await verifyBlobTransferCapability(wrongAud, SECRET, { dir: 'write' }, now), null)
})

test('source-auth signs canonically and verifies with replay dedupe', async () => {
  const auth = createSourceAuth({ signingSecret: SECRET, now: () => 10_000 })
  const signature = signRequest(SECRET, 10, 'body')
  assert.equal(signature.startsWith('v0='), true)
  assert.equal((await auth.verify({ signature, timestamp: 10, body: 'body', eventId: 'e1' })).ok, true)
  assert.deepEqual(await auth.verify({ signature, timestamp: 10, body: 'body', eventId: 'e1' }), {
    ok: false,
    reason: 'duplicate event (already processed)',
  })
  assert.deepEqual(await auth.verify({ signature: '', timestamp: 10, body: 'body', eventId: 'e2' }), {
    ok: false,
    reason: 'missing signature (unsigned request)',
  })
  const stale = createSourceAuth({ signingSecret: SECRET, now: () => 10_000, replayWindowMs: 1_000 })
  assert.deepEqual(await stale.verify({ signature: signRequest(SECRET, 1, 'body'), timestamp: 1, body: 'body', eventId: 'e3' }), {
    ok: false,
    reason: 'stale timestamp (replay protection)',
  })
  const tampered = await auth.verify({ signature, timestamp: 10, body: 'BODY', eventId: 'e4' })
  assert.equal(tampered.ok, false)
})

test('signedRequestHeaders adds timestamp and signature only with a secret', () => {
  const base = { authorization: 'Bearer x' }
  assert.deepEqual(signedRequestHeaders(undefined, 'POST', '/p', '', base), base)
  const signed = signedRequestHeaders(SECRET, 'POST', '/p', '', base, 7)
  assert.equal(signed['x-timestamp'], '7')
  assert.equal(signed['x-signature'], signCanonicalRequest(SECRET, 7, canonicalPayload('POST', '/p', '')))
})

test('memory replay dedupe claims once within the window', async () => {
  let t = 1000
  const dedupe = createMemoryReplayDedupe(() => t)
  assert.equal(dedupe.durable, false)
  assert.equal(await dedupe.claim('e1', 2000), true)
  assert.equal(await dedupe.claim('e1', 3000), false)
  t = 2500
  assert.equal(await dedupe.claim('e1', 4000), true)
})

test('aws role broker vends cached per-actor creds from a fake STS', async () => {
  let calls = 0
  const assumeRole = async (input: { RoleSessionName: string; DurationSeconds: number }) => {
    calls++
    return {
      Credentials: {
        AccessKeyId: `AKIA-${input.RoleSessionName}`,
        SecretAccessKey: 'sk',
        SessionToken: 'st',
        Expiration: new Date(Date.now() + input.DurationSeconds * 1000),
      },
    }
  }
  const broker = createAwsRoleBroker({
    roleArn: 'arn:aws:iam::1:role/r',
    region: 'us-east-1',
    sessionActions: ['s3:GetObject'],
    assumeRole,
  })
  const first = await broker.credsForActor('alice@example.com')
  const second = await broker.credsForActor('alice@example.com')
  assert.equal(first.accessKeyId, 'AKIA-alice@example.com')
  assert.equal(second.accessKeyId, first.accessKeyId)
  assert.equal(calls, 1)
  assert.equal(brokerSessionName('a!b@c'), 'a-b@c')
})

test('aws role broker rejects incomplete STS responses', async () => {
  const broker = createAwsRoleBroker({
    roleArn: 'arn:aws:iam::1:role/r',
    region: 'us-east-1',
    sessionActions: ['s3:GetObject'],
    assumeRole: async () => ({ Credentials: { AccessKeyId: 'ak' } }),
  })
  await assert.rejects(broker.credsForActor('u'), /incomplete credentials/)
})

test('portal identity verifies principal and expiry', async () => {
  const { mintSignedPayload } = await import('../src/index.ts')
  const token = await mintSignedPayload({ p: 'alice', n: 'Alice', exp: Date.now() + 60_000 }, SECRET)
  const identity = await verifyPortalIdentity(token, SECRET, Date.now())
  assert.equal(identity?.p, 'alice')
  assert.equal(await verifyPortalIdentity(token, SECRET2, Date.now()), null)
  const expired = await mintSignedPayload({ p: 'alice', exp: 1 }, SECRET)
  assert.equal(await verifyPortalIdentity(expired, SECRET, Date.now()), null)
})

test('postgres replay dedupe is durable and single-claim', async (t) => {
  if (!(await probePg())) return t.skip('QM_NEXT_PG_URL unreachable')
  const dedupe = createPostgresReplayDedupe(pgUrl!)
  assert.equal(dedupe.durable, true)
  const id = `pg-event-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  assert.equal(await dedupe.claim(id, Date.now() + 60_000), true)
  assert.equal(await dedupe.claim(id, Date.now() + 60_000), false)
})

test('postgres replay dedupe: an expired entry stops blocking after a prune', async (t) => {
  if (!(await probePg())) return t.skip('QM_NEXT_PG_URL unreachable')
  const id = `pg-expired-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const first = createPostgresReplayDedupe(pgUrl!)
  assert.equal(await first.claim(id, Date.now() - 1), true, 'the expired claim itself succeeds')
  const second = createPostgresReplayDedupe(pgUrl!)
  assert.equal(
    await second.claim(id, Date.now() + 60_000),
    true,
    'a fresh instance prunes the lapsed entry on first claim (qm restart shape)',
  )
})

test('requirePortalIdentitySecret fails closed in production without a secret', () => {
  assert.equal(requirePortalIdentitySecret('a-portal-secret', 'production'), true)
  assert.throws(() => requirePortalIdentitySecret(undefined, 'production'), MissingPortalSecretError)
})

test('requirePortalIdentitySecret keeps the unsigned dev lane with a warning', () => {
  const warn = console.warn
  const seen: string[] = []
  console.warn = (msg: string) => { seen.push(String(msg)) }
  try {
    assert.equal(requirePortalIdentitySecret(undefined, 'development'), true)
    assert.equal(seen.length, 1)
    const first = seen[0]
    assert.ok(first, 'expected one console.warn line')
    assert.match(first, new RegExp(ALLOW_UNSIGNED_TEST_IDENTITY))
    assert.match(first, /portalIdentitySecret/)
  } finally {
    console.warn = warn
  }
})
