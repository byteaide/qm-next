/**
 * Lane-A blob transfer: in-memory staged blobs with sha-256 verification
 * and the qm size cap. files/upload consumes staged blobs from here; the
 * raw /v1/blobs routes put/open/delete through the same interface.
 */
import { createHash, randomUUID } from 'node:crypto'

export const MAX_BLOB_BYTES = 1_000_000_000

export class BlobTooLargeError extends Error {
  constructor(message = 'blob exceeds the maximum size') {
    super(message)
  }
}

export class BlobHashMismatchError extends Error {
  constructor(message = 'content hash does not match x-content-sha256') {
    super(message)
  }
}

export interface BlobInfo {
  blobId: string
  sizeBytes: number
}

export interface OpenedBlob {
  sizeBytes: number
  bytes: Buffer
}

export interface BlobTransferService {
  put(bytes: Buffer, opts?: { maxBytes?: number; expectedSha256?: string }): Promise<BlobInfo>
  open(id: string): Promise<OpenedBlob | null>
  delete(id: string): Promise<void>
}

export function createMemoryBlobTransfer(): BlobTransferService {
  const blobs = new Map<string, OpenedBlob>()
  return {
    async put(bytes, opts) {
      const maxBytes = opts?.maxBytes ?? MAX_BLOB_BYTES
      if (bytes.byteLength > maxBytes) {
        throw new BlobTooLargeError(`blob is ${bytes.byteLength} bytes; the maximum is ${maxBytes}`)
      }
      if (opts?.expectedSha256) {
        const actual = createHash('sha256').update(bytes).digest('hex')
        if (actual !== opts.expectedSha256.toLowerCase()) throw new BlobHashMismatchError()
      }
      const blobId = randomUUID()
      blobs.set(blobId, { sizeBytes: bytes.byteLength, bytes })
      return { blobId, sizeBytes: bytes.byteLength }
    },
    async open(id) {
      const blob = blobs.get(id)
      return blob ? { ...blob } : null
    },
    async delete(id) {
      blobs.delete(id)
    },
  }
}
