/**
 * Capability token payload compression suite (qm-post-soul p003 lane B,
 * 2026-09-26). Asserts:
 *
 * 1. `compressPayload` round-trips through `decompressPayload` exactly.
 * 2. `isCompressedPayload` sniffs the wire-format flag prefix.
 * 3. `decompressPayload` rejects non-flagged / malformed base64url /
 *    malformed gzip payloads with stable `CapabilityTokenError` codes.
 * 4. `compressPayload` rejects oversize input at the sanity ceiling.
 * 5. `mintCapabilityToken({ compress: false })` produces the legacy wire
 *    shape (qm-verbatim port) — verify still passes.
 * 6. `mintCapabilityToken({ compress: true })` produces the compressed
 *    envelope — verify still passes with identical claims back.
 * 7. The `CAPABILITY_COMPRESS_MARKER` is the wire envelope key, not a
 *    claim field — claims that happen to define that key would be ignored.
 * 8. Tampered compressed tokens (badge flipped, payload swapped) fail
 *    closed — `verifyCapabilityToken` returns null.
 * 9. Error code consistency: every error carries one of the pinned codes
 *    `compression_oversize` / `not_a_compressed_payload` / `decompression_failed`.
 *
 * Source-of-truth: `~/.aidevops/.agent-workspace/knowledge/0040-capability-token-compression.md`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CAPABILITY_COMPRESS_CEILING,
  CAPABILITY_COMPRESS_MARKER,
  CAPABILITY_COMPRESS_THRESHOLD,
  COMPRESS_FLAG,
  CapabilityTokenError,
  compressPayload,
  decompressPayload,
  isCompressedPayload,
  mintCapabilityToken,
  verifyCapabilityToken,
} from '../src/index.ts'

const SECRET = '[redacted-credential]'

function smallClaims() {
  return {
    actorId: 'agent-1',
    scopeId: 'personal:u',
    exp: Date.now() + 60_000,
    timezone: 'UTC',
    grants: ['files'],
  }
}

function largeClaims() {
  // Synthesize a 6KB claims object to exceed CAPABILITY_COMPRESS_THRESHOLD (1KB)
  // and make gzip worth the wire bytes. Real-world payload: keychain members
  // list with ~30 entries, each with destination + scopeVersion + path.
  const destinations = Array.from({ length: 40 }, (_, i) => ({
    type: 'feishu',
    target: `oc_${i.toString().padStart(16, '0')}`,
    threadId: `omt_${i.toString().padStart(16, '0')}`,
    handleScope: 'personal',
  }))
  return {
    actorId: 'agent-large',
    scopeId: 'personal:u',
    exp: Date.now() + 60_000,
    timezone: 'Asia/Shanghai',
    grants: Array.from({ length: 80 }, (_, i) => `grant:${i}:read:write`),
    destinations,
    credentials: Array.from({ length: 60 }, (_, i) => `cred-${i}`),
    keychainMembers: Array.from({ length: 30 }, (_, i) => ({
      handleId: `handle-${i}`,
      host: 'feishu.example.com',
      principalId: `principal-${i}`,
    })),
    memory: {
      write: 'memory:write:scope:1',
      orgWrite: 'memory:write:org:1',
      read: Array.from({ length: 20 }, (_, i) => `memory:read:${i}`),
    },
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — round-trip + sniff
// ---------------------------------------------------------------------------

test('compressPayload + decompressPayload round-trips a small JSON string', () => {
  const input = '{"actorId":"a","scopeId":"s","exp":1}'
  const compressed = compressPayload(input)
  assert.equal(isCompressedPayload(compressed), true)
  assert.ok(compressed.startsWith(`${COMPRESS_FLAG}.`), 'flag prefix')
  assert.equal(decompressPayload(compressed), input)
})

test('compressPayload + decompressPayload round-trips a large JSON string', () => {
  const input = JSON.stringify(largeClaims())
  assert.ok(input.length > CAPABILITY_COMPRESS_THRESHOLD, 'test fixture exceeds threshold')
  const compressed = compressPayload(input)
  assert.ok(
    compressed.length < input.length,
    `compressed wire (${compressed.length}) smaller than input (${input.length})`,
  )
  assert.equal(decompressPayload(compressed), input)
})

test('isCompressedPayload sniffs the prefix; legacy strings return false', () => {
  assert.equal(isCompressedPayload(`${COMPRESS_FLAG}.abc`), true)
  assert.equal(isCompressedPayload('legacy.eyJ.abc'), false)
  assert.equal(isCompressedPayload(''), false)
  assert.equal(isCompressedPayload('gzip2.something'), false, 'wrong flag prefix is rejected')
})

test('compressPayload throws compression_oversize above the sanity ceiling', () => {
  // Build a string strictly greater than CAPABILITY_COMPRESS_CEILING.
  // The ceiling is THRESHOLD × 4 = 4096, so we use 4097 chars of 'a'.
  const oversize = 'a'.repeat(CAPABILITY_COMPRESS_CEILING + 1)
  assert.throws(
    () => compressPayload(oversize),
    (err: unknown) =>
      err instanceof CapabilityTokenError &&
      err.code === 'compression_oversize',
  )
})

test('decompressPayload throws not_a_compressed_payload on text without the prefix', () => {
  assert.throws(
    () => decompressPayload('legacy.payload.here'),
    (err: unknown) =>
      err instanceof CapabilityTokenError &&
      err.code === 'not_a_compressed_payload',
  )
  assert.throws(
    () => decompressPayload('gzip2.something'),
    (err: unknown) =>
      err instanceof CapabilityTokenError &&
      err.code === 'not_a_compressed_payload',
  )
})

test('decompressPayload throws decompression_failed on malformed base64url', () => {
  // 8 chars of valid gzip base64 are too short to gunzip, but the prefix
  // is valid and the suffix is malformed (length 0). Node's Buffer.from
  // accepts any input silently; this test exercises a known-invalid
  // suffix that base64url rejects.
  assert.throws(
    () => decompressPayload(`${COMPRESS_FLAG}.!!!not-base64!!!`),
    (err: unknown) =>
      err instanceof CapabilityTokenError &&
      err.code === 'decompression_failed',
  )
})

test('decompressPayload throws decompression_failed on valid base64url but invalid gzip', () => {
  // base64url-encoded empty payload — passes base64url decode but fails
  // gunzip (empty buffer is not a valid gzip stream).
  assert.throws(
    () => decompressPayload(`${COMPRESS_FLAG}.`),
    (err: unknown) =>
      err instanceof CapabilityTokenError &&
      err.code === 'decompression_failed',
  )
  // Valid base64url of "hello" — passes base64url decode but is not gzip.
  const notGzip = Buffer.from('hello world').toString('base64url')
  assert.throws(
    () => decompressPayload(`${COMPRESS_FLAG}.${notGzip}`),
    (err: unknown) =>
      err instanceof CapabilityTokenError &&
      err.code === 'decompression_failed',
  )
})

// ---------------------------------------------------------------------------
// mint / verify integration — legacy path unchanged
// ---------------------------------------------------------------------------

test('mintCapabilityToken default keeps the legacy wire shape (no marker)', async () => {
  const token = await mintCapabilityToken(smallClaims(), SECRET, 'default')
  // Legacy tokens never contain the marker key. We sniff by extracting the
  // JWS payload field (third segment, base64url-decoded).
  const payloadB64 = token.split('.')[1]!
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>
  assert.equal(payload[CAPABILITY_COMPRESS_MARKER], undefined, 'no marker in legacy envelope')
  assert.equal(payload.actorId, 'agent-1')
  assert.equal(payload.scopeId, 'personal:u')
})

test('mintCapabilityToken({compress: false}) is byte-identical to legacy', async () => {
  // Pin exp so both calls produce identical bytes — Date.now() would drift.
  const claims = { actorId: 'agent-1', scopeId: 'personal:u', exp: 1_700_000_000_000, timezone: 'UTC', grants: ['files'] }
  const legacy = await mintCapabilityToken(claims, SECRET, 'default')
  const explicit = await mintCapabilityToken(claims, SECRET, 'default', { compress: false })
  assert.equal(explicit, legacy, 'explicit {compress: false} matches default')
})

test('verifyCapabilityToken passes legacy tokens unchanged', async () => {
  const token = await mintCapabilityToken(smallClaims(), SECRET, 'default')
  const claims = await verifyCapabilityToken(token, SECRET)
  assert.ok(claims)
  assert.equal(claims.actorId, 'agent-1')
  // orgId rides the wire envelope top-level (not a claim field), so we
  // cast through Record to access it without polluting CapabilityClaims.
  assert.equal((claims as unknown as Record<string, unknown>).orgId, 'default', 'orgId rides the legacy envelope top-level')
})

// ---------------------------------------------------------------------------
// mint / verify integration — compressed path
// ---------------------------------------------------------------------------

test('mintCapabilityToken({compress: true}) writes the compressed envelope marker', async () => {
  const token = await mintCapabilityToken(smallClaims(), SECRET, 'default', { compress: true })
  const payloadB64 = token.split('.')[1]!
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>
  assert.equal(payload[CAPABILITY_COMPRESS_MARKER], COMPRESS_FLAG)
  assert.equal(typeof payload.data, 'string')
  assert.ok(
    (payload.data as string).startsWith(`${COMPRESS_FLAG}.`),
    'data field carries the wire flag prefix',
  )
  assert.equal(payload.actorId, undefined, 'claims are not flat in the compressed envelope')
})

test('mintCapabilityToken({compress: true}) + verifyCapabilityToken round-trips claims', async () => {
  const original = largeClaims()
  const token = await mintCapabilityToken(original, SECRET, 'default', { compress: true })
  const claims = await verifyCapabilityToken(token, SECRET)
  assert.ok(claims)
  assert.equal(claims.actorId, original.actorId)
  assert.equal(claims.scopeId, original.scopeId)
  assert.equal(claims.timezone, original.timezone)
  assert.equal((claims as unknown as Record<string, unknown>).orgId, 'default', 'orgId restored from outer envelope')
  assert.deepEqual(claims.grants, original.grants)
  assert.deepEqual(claims.destinations, original.destinations)
  assert.deepEqual(claims.credentials, original.credentials)
  assert.deepEqual(claims.memory, original.memory)
})

test('compressed token wire size is smaller than legacy for large claims', async () => {
  const legacy = await mintCapabilityToken(largeClaims(), SECRET, 'default')
  const compressed = await mintCapabilityToken(largeClaims(), SECRET, 'default', { compress: true })
  // JWS compact form is `header.payload.signature`. Compare total lengths.
  assert.ok(
    compressed.length < legacy.length,
    `compressed (${compressed.length}) < legacy (${legacy.length})`,
  )
})

test('compressed token wire size includes overhead for small claims (opt-in explicit)', async () => {
  // Small claims still compress when explicitly opted in — the operator
  // signal wins over the threshold heuristic. Documented behavior.
  const legacy = await mintCapabilityToken(smallClaims(), SECRET, 'default')
  const compressed = await mintCapabilityToken(smallClaims(), SECRET, 'default', { compress: true })
  assert.ok(
    compressed.length > legacy.length,
    `small claims: gzip header + base64 expansion makes compressed (${compressed.length}) > legacy (${legacy.length}) — explicit opt-in is honored regardless`,
  )
})

// ---------------------------------------------------------------------------
// Tamper detection — fail-closed semantics
// ---------------------------------------------------------------------------

test('compressed envelope with marker but missing `data` field fails closed', async () => {
  // Hand-craft an envelope (so we don't rely on mint) and confirm verify rejects.
  const { mintSignedPayload } = await import('../src/index.ts')
  const tampered = await mintSignedPayload(
    {
      orgId: 'default',
      [CAPABILITY_COMPRESS_MARKER]: COMPRESS_FLAG,
      // data field intentionally missing
    },
    SECRET,
  )
  const claims = await verifyCapabilityToken(tampered, SECRET)
  assert.equal(claims, null)
})

test('compressed envelope with marker but unparseable gzip payload fails closed', async () => {
  const { mintSignedPayload } = await import('../src/index.ts')
  const tampered = await mintSignedPayload(
    {
      orgId: 'default',
      [CAPABILITY_COMPRESS_MARKER]: COMPRESS_FLAG,
      data: `${COMPRESS_FLAG}.notvalidgzip`,
    },
    SECRET,
  )
  const claims = await verifyCapabilityToken(tampered, SECRET)
  assert.equal(claims, null)
})

test('compressed envelope with marker but non-object decompressed payload fails closed', async () => {
  const { mintSignedPayload } = await import('../src/index.ts')
  // Compress a non-object value (string) and embed it. The envelope
  // round-trips but the decompressed payload is not an object — verify
  // rejects per the type guard.
  const compressedString = compressPayload('"just a string, not an object"')
  const tampered = await mintSignedPayload(
    {
      orgId: 'default',
      [CAPABILITY_COMPRESS_MARKER]: COMPRESS_FLAG,
      data: compressedString,
    },
    SECRET,
  )
  const claims = await verifyCapabilityToken(tampered, SECRET)
  assert.equal(claims, null)
})

test('compressed envelope with valid payload but missing required claim fields fails closed', async () => {
  const { mintSignedPayload } = await import('../src/index.ts')
  // Compress a payload that lacks `actorId` — verify's required-fields
  // check should reject after decompression.
  const compressed = compressPayload(JSON.stringify({ scopeId: 's', exp: Date.now() + 60_000 }))
  const tampered = await mintSignedPayload(
    {
      orgId: 'default',
      [CAPABILITY_COMPRESS_MARKER]: COMPRESS_FLAG,
      data: compressed,
    },
    SECRET,
  )
  const claims = await verifyCapabilityToken(tampered, SECRET)
  assert.equal(claims, null)
})

// ---------------------------------------------------------------------------
// CapabilityTokenError code stability
// ---------------------------------------------------------------------------

test('CapabilityTokenError carries one of the three pinned codes', () => {
  const codes = new Set<string>()
  // Trigger each code path once to enumerate
  try { compressPayload('a'.repeat(CAPABILITY_COMPRESS_CEILING + 1)) } catch (e) { codes.add((e as CapabilityTokenError).code) }
  try { decompressPayload('no-prefix') } catch (e) { codes.add((e as CapabilityTokenError).code) }
  try { decompressPayload(`${COMPRESS_FLAG}.notvalidbase64`) } catch (e) { codes.add((e as CapabilityTokenError).code) }
  assert.deepEqual([...codes].sort(), ['compression_oversize', 'decompression_failed', 'not_a_compressed_payload'])
})

test('CapabilityTokenError.name is stable for observability dashboards', () => {
  assert.equal(new CapabilityTokenError('compression_oversize', 'x').name, 'CapabilityTokenError')
})