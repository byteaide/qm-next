/**
 * S3 leg of DurableByteStore: durable across instances, suitable for
 * multi-host blue-green. Content-addressed `files/<sha256>` keys match
 * the local-FS leg exactly so a migration can move bytes by copying.
 *
 * Auth modes:
 *   - Production: IAM role (no explicit creds; SDK default chain).
 *   - Test / non-AWS: pass `accessKeyId` + `secretAccessKey` + optional
 *     `endpoint` (minio, R2, etc.); `forcePathStyle` is auto-enabled
 *     when an endpoint override is present.
 *
 * Streaming reads enforce `maxBytes` exactly like the local-FS leg,
 * so callers cannot OOM the process by accident.
 */
import { createHash } from 'node:crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { ByteSourceTooLargeError, type DurableByteStore, type PutBytesResult } from './byte-store.ts'

export interface S3ByteStoreOptions {
  /** Bucket name; required. */
  bucket: string
  /** AWS region (or minio region placeholder). */
  region: string
  /** Endpoint override for S3-compatible stores (minio, R2, etc.). */
  endpoint?: string
  /** Path-style addressing (required by most non-AWS S3 implementations). */
  forcePathStyle?: boolean
  /** Optional explicit credentials (test/CI; production should rely on the SDK default chain). */
  accessKeyId?: string
  secretAccessKey?: string
  /** Key prefix; defaults to `files` so the layout matches local-FS. */
  prefix?: string
  /** Optional streaming cap for `open`; defaults to 64 MiB. */
  maxReadBytes?: number
  /** Pass-through to S3Client for advanced tuning. */
  clientConfig?: Omit<S3ClientConfig, 'region' | 'endpoint' | 'forcePathStyle' | 'credentials'>
}

const BLOB_KEY = /^files\/[0-9a-f]{64}$/
const DEFAULT_MAX_READ = 64 * 1024 * 1024

function keyFor(prefix: string, blobKey: string): string {
  return `${prefix}/${blobKey}`
}

function errName(err: unknown): string | undefined {
  if (err == null || typeof err !== 'object') return undefined
  const name = (err as { name?: unknown }).name
  return typeof name === 'string' ? name : undefined
}

export function createS3ByteStore(opts: S3ByteStoreOptions): DurableByteStore {
  if (!opts.bucket) throw new Error('createS3ByteStore: bucket is required')
  if (!opts.region) throw new Error('createS3ByteStore: region is required')

  const prefix = opts.prefix ?? 'files'
  const forcePathStyle = opts.forcePathStyle ?? Boolean(opts.endpoint)
  const credentials =
    opts.accessKeyId && opts.secretAccessKey
      ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
      : undefined

  const client = new S3Client({
    region: opts.region,
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    forcePathStyle,
    ...(credentials ? { credentials } : {}),
    ...(opts.clientConfig ?? {}),
  })

  const objectKeyFor = (blobKey: string) => keyFor(prefix, blobKey)

  const has = async (blobKey: string): Promise<boolean> => {
    if (!BLOB_KEY.test(blobKey)) return false
    try {
      await client.send(new HeadObjectCommand({ Bucket: opts.bucket, Key: objectKeyFor(blobKey) }))
      return true
    } catch (err) {
      if (errName(err) === 'NotFound') return false
      throw err
    }
  }

  return {
    async put(bytes, putOpts): Promise<PutBytesResult> {
      const max = putOpts?.maxBytes
      if (max != null && bytes.byteLength > max) throw new ByteSourceTooLargeError()
      const data = Buffer.from(bytes)
      const sha256 = createHash('sha256').update(data).digest('hex')
      const blobKey = `files/${sha256}`
      // Idempotent: if the object already exists, skip the upload (matches
      // the local-FS leg's "stat-first" semantics).
      if (await has(blobKey)) return { blobKey, sizeBytes: data.length, sha256 }
      await client.send(
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: objectKeyFor(blobKey),
          Body: data,
          ContentLength: data.length,
        }),
      )
      return { blobKey, sizeBytes: data.length, sha256 }
    },

    async open(blobKey) {
      if (!BLOB_KEY.test(blobKey)) return null
      let res
      try {
        res = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: objectKeyFor(blobKey) }))
      } catch (err) {
        const name = errName(err)
        if (name === 'NoSuchKey' || name === 'NotFound') return null
        throw err
      }
      const body = res.Body
      if (!body) return null
      const cap = opts.maxReadBytes ?? DEFAULT_MAX_READ
      const chunks: Buffer[] = []
      let total = 0
      // AWS SDK v3 streams can be Node Readable, Web ReadableStream, or Blob
      // depending on runtime — normalise to async iterator of Buffers.
      const asyncIter = (body as AsyncIterable<Buffer | Uint8Array>)[Symbol.asyncIterator]
      if (typeof asyncIter === 'function') {
        for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          total += buf.length
          if (total > cap) throw new ByteSourceTooLargeError()
          chunks.push(buf)
        }
      } else if (typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
        const reader = (body as ReadableStream<Uint8Array>).getReader()
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (value) {
              const buf = Buffer.from(value)
              total += buf.length
              if (total > cap) throw new ByteSourceTooLargeError()
              chunks.push(buf)
            }
          }
        } finally {
          reader.releaseLock()
        }
      } else {
        throw new Error('createS3ByteStore: GetObject body is not streamable')
      }
      const bytes = Buffer.concat(chunks)
      return { bytes, sizeBytes: bytes.length }
    },

    async delete(blobKey) {
      if (!BLOB_KEY.test(blobKey)) return
      await client.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: objectKeyFor(blobKey) }))
    },
  }
}