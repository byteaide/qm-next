/**
 * Durable byte store for file blobs (20.0 twin lane): content-addressed
 * `files/<sha256>` keys exactly like qm, so a migration can move bytes by
 * copying the directory. Memory backing for tests; local-FS backing for
 * production (S3 stays out of v1 — parity deviation).
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { errMessage } from './pg-pool.ts'

export class ByteSourceTooLargeError extends Error {
  constructor() {
    super('file exceeds the size limit')
    this.name = 'ByteSourceTooLargeError'
  }
}

export interface PutBytesResult {
  blobKey: string
  sizeBytes: number
  sha256: string
}

export interface DurableByteStore {
  put(bytes: Uint8Array, opts?: { maxBytes?: number }): Promise<PutBytesResult>
  open(blobKey: string): Promise<{ bytes: Buffer; sizeBytes: number } | null>
  delete(blobKey: string): Promise<void>
}

const BLOB_KEY = /^files\/[0-9a-f]{64}$/
const keyFor = (sha256: string): string => `files/${sha256}`

function collect(bytes: Uint8Array, maxBytes?: number): { data: Buffer; sha256: string } {
  if (maxBytes != null && bytes.byteLength > maxBytes) throw new ByteSourceTooLargeError()
  const data = Buffer.from(bytes)
  return { data, sha256: createHash('sha256').update(data).digest('hex') }
}

export function createMemoryByteStore(): DurableByteStore {
  const blobs = new Map<string, Buffer>()
  return {
    async put(bytes, opts) {
      const { data, sha256 } = collect(bytes, opts?.maxBytes)
      const blobKey = keyFor(sha256)
      if (!blobs.has(blobKey)) blobs.set(blobKey, data)
      return { blobKey, sizeBytes: data.length, sha256 }
    },
    async open(blobKey) {
      const hit = blobs.get(blobKey)
      if (!hit) return null
      return { bytes: hit, sizeBytes: hit.length }
    },
    async delete(blobKey) {
      blobs.delete(blobKey)
    },
  }
}

export function createLocalByteStore(dir: string): DurableByteStore {
  const base = join(dir, 'files')
  let ensured: Promise<unknown> | null = null
  const ensureDir = (): Promise<unknown> => (ensured ??= mkdir(base, { recursive: true }))

  return {
    async put(bytes, opts) {
      const { data, sha256 } = collect(bytes, opts?.maxBytes)
      const blobKey = keyFor(sha256)
      await ensureDir()
      const finalPath = join(base, sha256)
      try {
        if ((await stat(finalPath)).isFile()) return { blobKey, sizeBytes: data.length, sha256 }
      } catch (error) {
        void error
      }
      const partPath = join(base, `${sha256}.${randomUUID()}.part`)
      await writeFile(partPath, data)
      try {
        await rename(partPath, finalPath)
      } catch (err) {
        await rm(partPath, { force: true }).catch((e) => void errMessage(e))
        throw err
      }
      return { blobKey, sizeBytes: data.length, sha256 }
    },
    async open(blobKey) {
      if (!BLOB_KEY.test(blobKey)) return null
      const path = join(base, blobKey.slice('files/'.length))
      let st
      try {
        st = await stat(path)
      } catch (err) {
        if (err != null && typeof err === 'object' && (err as { code?: unknown }).code === 'ENOENT') return null
        throw err
      }
      if (!st.isFile()) return null
      const chunks: Buffer[] = []
      for await (const chunk of createReadStream(path)) chunks.push(chunk as Buffer)
      const bytes = Buffer.concat(chunks)
      return { bytes, sizeBytes: bytes.length }
    },
    async delete(blobKey) {
      if (!BLOB_KEY.test(blobKey)) return
      await rm(join(base, blobKey.slice('files/'.length)), { force: true }).catch((e) => void errMessage(e))
    },
  }
}
