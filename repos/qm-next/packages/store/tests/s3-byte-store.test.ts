/**
 * S3 byte-store contract suite.  Mocks the underlying S3Client so the test
 * runs without network or AWS credentials.  Behavioural parity with the
 * memory + local-FS legs:
 *   - `put(bytes)` is idempotent on sha256 (re-upload is a no-op)
 *   - `open(blobKey)` returns null on missing key (matches local-FS)
 *   - `open(blobKey)` enforces a streaming cap (defaults to 64 MiB)
 *   - `delete(blobKey)` is idempotent
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { mockClient } from 'aws-sdk-client-mock'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type PutObjectCommandOutput,
} from '@aws-sdk/client-s3'
import { createS3ByteStore } from '../src/s3-byte-store.ts'

function makeStore(opts?: { bucket?: string; maxReadBytes?: number; region?: string }) {
  const mock = mockClient(S3Client)
  // Default mocks: HeadObject → 404, GetObject → 404, PutObject → ok
  mock.on(HeadObjectCommand).rejects({ name: 'NotFound' })
  mock.on(GetObjectCommand).rejects({ name: 'NoSuchKey' })
  mock.on(PutObjectCommand).resolves({} as PutObjectCommandOutput)
  mock.on(DeleteObjectCommand).resolves({})
  return {
    store: createS3ByteStore({
      bucket: opts?.bucket ?? 'test-bucket',
      region: opts?.region ?? 'us-east-1',
      ...(opts?.maxReadBytes ? { maxReadBytes: opts.maxReadBytes } : {}),
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
    }),
    mock,
  }
}

test('put returns content-addressed blobKey + sha256', async () => {
  const { store, mock } = makeStore()
  // First call to Head returns 404, then PutObject → exists (idempotent re-put hits PutObject again, so
  // for the first put we expect no Head since we go straight to PutObject). Wait — put() checks
  // has() first. Let me track sequence:
  let headCalls = 0
  let putCalls = 0
  mock.on(HeadObjectCommand).callsFake(() => {
    headCalls++
    return Promise.reject({ name: 'NotFound' })
  })
  mock.on(PutObjectCommand).callsFake(() => {
    putCalls++
    return Promise.resolve({} as PutObjectCommandOutput)
  })

  const bytes = new Uint8Array(Buffer.from('hello world'))
  const out = await store.put(bytes)
  assert.equal(out.sizeBytes, 11)
  assert.equal(out.sha256.length, 64)
  assert.equal(out.blobKey, `files/${out.sha256}`)
  assert.equal(headCalls, 1, 'first put should HeadObject first')
  assert.equal(putCalls, 1, 'first put should PutObject when not present')

  // Re-put same bytes → idempotent skip (Head returns 404? No, it returns ok now because it exists)
  mock.on(HeadObjectCommand).callsFake(() => {
    headCalls++
    return Promise.resolve({})
  })
  const out2 = await store.put(bytes)
  assert.deepEqual(out2, out)
  assert.equal(headCalls, 2, 'second put should HeadObject again')
  assert.equal(putCalls, 1, 'second put should NOT PutObject when present')
})

test('open reads body and returns bytes + sizeBytes', async () => {
  const { store, mock } = makeStore()
  const payload = Buffer.from('round-trip bytes')
  mock.on(GetObjectCommand).resolves({
    Body: Readable.from([payload]),
  } as unknown as GetObjectCommandOutput)

  const put = await store.put(new Uint8Array(payload))
  const opened = await store.open(put.blobKey)
  assert.ok(opened)
  assert.equal(opened!.sizeBytes, payload.length)
  assert.deepEqual(opened!.bytes, payload)
})

test('open returns null on missing key (NoSuchKey)', async () => {
  const { store } = makeStore()
  const opened = await store.open('files/'.padEnd(71, 'a'))
  assert.equal(opened, null)
})

test('open returns null when blobKey does not match files/<sha256> shape', async () => {
  const { store } = makeStore()
  const opened = await store.open('not-valid')
  assert.equal(opened, null)
})

test('open enforces maxReadBytes and throws ByteSourceTooLargeError', async () => {
  const { store } = makeStore({ maxReadBytes: 8 })
  const big = Buffer.alloc(1024, 'a')
  mockClient(S3Client).on(GetObjectCommand).resolves({
    Body: Readable.from([big]),
  } as unknown as GetObjectCommandOutput)
  const put = await store.put(new Uint8Array(big))
  await assert.rejects(() => store.open(put.blobKey), /file exceeds the size limit/)
})

test('delete issues DeleteObjectCommand for valid blobKey', async () => {
  const { store, mock } = makeStore()
  let deleteCalls = 0
  mock.on(DeleteObjectCommand).callsFake(() => {
    deleteCalls++
    return Promise.resolve({})
  })
  await store.delete('files/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
  assert.equal(deleteCalls, 1)
})

test('delete is a no-op for malformed blobKey', async () => {
  const { store, mock } = makeStore()
  let deleteCalls = 0
  mock.on(DeleteObjectCommand).callsFake(() => {
    deleteCalls++
    return Promise.resolve({})
  })
  await store.delete('not-a-valid-blob-key')
  assert.equal(deleteCalls, 0, 'malformed blobKey should not issue DeleteObjectCommand')
})

test('createS3ByteStore throws when bucket or region missing', () => {
  assert.throws(() => createS3ByteStore({ bucket: '', region: 'us-east-1' }), /bucket is required/)
  assert.throws(() => createS3ByteStore({ bucket: 'b', region: '' }), /region is required/)
})