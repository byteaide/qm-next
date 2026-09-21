/**
 * Emoji upload service contract tests (cluster 2 brief `qm-next-c2-emoji-upload`).
 *
 * Covers the provider-neutral core:
 *   - validation: name regex, content-type must be image/*, bytes non-empty,
 *     size cap enforced
 *   - durability: round-trip bytes via injected DurableByteStore
 *   - audit: every successful upload emits an `emoji.uploaded` row
 *   - provider graceful path: with no provider wired, returns
 *     `pendingProviderRegistration: true`; with a provider that throws,
 *     the same shape (no 500).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryByteStore } from '@qm/store'
import {
  createEmojiUploadService,
  type EmojiRegistry,
} from '../src/emoji-upload-service.ts'

interface AuditRow {
  at: number
  principalId: string
  action: string
  resource: string
  scopeLabel: string
  status?: string
  detail?: string
}

function makeHarness(opts?: { provider?: EmojiRegistry; maxBytes?: number; failingProvider?: boolean }) {
  const bytes = createMemoryByteStore()
  const audit: AuditRow[] = []
  const provider: EmojiRegistry | undefined = opts?.failingProvider
    ? {
        async registerEmoji() {
          throw new Error('simulated provider outage')
        },
      }
    : opts?.provider
  const service = createEmojiUploadService({
    bytes,
    audit: {
      record(e) {
        audit.push(e)
      },
    },
    ...(opts?.maxBytes ? { maxBytes: opts.maxBytes } : {}),
    ...(provider ? { provider } : {}),
  })
  return { bytes, audit, service, provider }
}

const PRINCIPAL = 'person:ada'

test('valid upload stores bytes and audits', async () => {
  const { service, bytes, audit } = makeHarness()
  const payload = Buffer.from('not a real png but the validator only checks prefix')
  const result = await service.upload(PRINCIPAL, {
    name: 'party-parrot',
    contentType: 'image/png',
    bytes: payload,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.match(result.blobKey, /^files\//)
  assert.equal(result.sizeBytes, payload.length)
  assert.equal(result.pendingProviderRegistration, true, 'no provider wired → graceful true')
  assert.equal(audit.length, 1)
  assert.equal(audit[0]!.action, 'emoji.uploaded')
  assert.equal(audit[0]!.resource, result.blobKey)

  // Bytes round-trip
  const read = await bytes.open(result.blobKey)
  assert.ok(read)
  assert.equal(read!.bytes.toString('utf8'), payload.toString('utf8'))
})

test('rejects invalid name', async () => {
  const { service } = makeHarness()
  const result = await service.upload(PRINCIPAL, {
    name: 'with space',
    contentType: 'image/png',
    bytes: new Uint8Array([1, 2, 3]),
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error, 'invalid_name')
})

test('rejects non-image contentType', async () => {
  const { service } = makeHarness()
  const result = await service.upload(PRINCIPAL, {
    name: 'whatever',
    contentType: 'application/zip',
    bytes: new Uint8Array([1, 2, 3]),
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error, 'invalid_content_type')
})

test('rejects empty bytes', async () => {
  const { service } = makeHarness()
  const result = await service.upload(PRINCIPAL, {
    name: 'empty',
    contentType: 'image/png',
    bytes: new Uint8Array(0),
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error, 'invalid_bytes')
})

test('enforces maxBytes cap', async () => {
  const { service } = makeHarness({ maxBytes: 4 })
  const result = await service.upload(PRINCIPAL, {
    name: 'big',
    contentType: 'image/png',
    bytes: new Uint8Array([1, 2, 3, 4, 5, 6]),
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error, 'too_large')
})

test('with working provider, pendingProviderRegistration is false', async () => {
  let registered: { name: string; blobKey: string } | null = null
  const { service } = makeHarness({
    provider: {
      async registerEmoji(input) {
        registered = { name: input.name, blobKey: input.blobKey }
      },
    },
  })
  const result = await service.upload(PRINCIPAL, {
    name: 'cat',
    contentType: 'image/gif',
    bytes: new Uint8Array([9, 8, 7]),
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.pendingProviderRegistration, false)
  const r = registered
  assert.ok(r)
  assert.equal((r as { name: string }).name, 'cat')
})

test('failing provider → pendingProviderRegistration: true + audit row, no 500', async () => {
  const { service, audit } = makeHarness({ failingProvider: true })
  const result = await service.upload(PRINCIPAL, {
    name: 'will-fail',
    contentType: 'image/png',
    bytes: new Uint8Array([1]),
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.pendingProviderRegistration, true, 'failing provider must surface as graceful, not throw')
  assert.equal(audit.length, 2, 'one emoji.uploaded + one emoji.register_failed')
  assert.equal(audit[1]!.action, 'emoji.register_failed')
  assert.match(String(audit[1]!.detail), /simulated provider outage/)
})