/**
 * Lane-A file store: uploads land as in-memory files owned by a personal
 * scope; visibility is owner-or-grant. Uploads consume staged blobs from
 * the blob transfer service (the qm flow); list/content mirror qm's
 * listFilesForViewer / openFileForViewer shapes.
 */
import { randomUUID } from 'node:crypto'
import type { BlobTransferService } from './blob-transfer.ts'
import type { GrantLedger } from './grant-ledger.ts'

export const MAX_UPLOAD_BYTES = 100_000_000

export class ByteSourceTooLargeError extends Error {
  constructor(message = 'file exceeds the maximum upload size') {
    super(message)
  }
}

export interface StoredFile {
  id: string
  ownerScopeId: string
  principalId: string
  name: string
  mimetype?: string
  sizeBytes: number
  blobId: string
  createdAt: number
}

export interface FilePage {
  files: Array<StoredFile & { url?: string }>
  nextCursor?: string
}

export interface FileStoreService {
  listForViewer(viewer: string, opts?: { limit?: number; cursor?: string }, scope?: string): Promise<FilePage>
  /** Admin view: files owned by any of the scopes (no viewer grant check). */
  listByScopes(scopes: string[], opts?: { limit?: number }): Promise<FilePage>
  openForViewer(id: string, viewer: string): Promise<(StoredFile & { bytes: Buffer }) | null>
  uploadForViewer(
    principalId: string,
    input: { scopeId?: string; name: string; mimetype?: string; bytes: Buffer },
  ): Promise<StoredFile | null>
}

export function createMemoryFileStore(deps: { blobTransfer: BlobTransferService; grants: GrantLedger }): FileStoreService {
  const files = new Map<string, StoredFile>()
  const contents = new Map<string, Buffer>()

  const visibleTo = (file: StoredFile, viewer: string): boolean =>
    file.principalId === viewer || file.ownerScopeId === `personal:${viewer}` || false

  return {
    async listForViewer(viewer, opts, scope) {
      const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200)
      const candidates = [...files.values()]
        .filter((f) => visibleTo(f, viewer))
        .filter((f) => (scope ? f.ownerScopeId === scope : true))
      for (const f of [...files.values()]) {
        if (visibleTo(f, viewer)) continue
        if (scope && f.ownerScopeId !== scope) continue
        if (await deps.grants.hasGrant(f.ownerScopeId, `personal:${viewer}`)) candidates.push(f)
      }
      const all = candidates.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))
      const startIndex = opts?.cursor ? all.findIndex((f) => f.id === opts.cursor) + 1 : 0
      const page = all.slice(Math.max(startIndex, 0), Math.max(startIndex, 0) + limit)
      const next = all[Math.max(startIndex, 0) + limit]
      return next ? { files: page, nextCursor: next.id } : { files: page }
    },
    async listByScopes(scopes, opts) {
      const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 2000)
      const scopeSet = new Set(scopes)
      const all = [...files.values()]
        .filter((f) => scopeSet.size === 0 || scopeSet.has(f.ownerScopeId))
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))
      const page = all.slice(0, limit)
      const next = all[limit]
      return next ? { files: page, nextCursor: next.id } : { files: page }
    },
    async openForViewer(id, viewer) {
      const file = files.get(id)
      if (!file) return null
      if (!visibleTo(file, viewer) && !(await deps.grants.hasGrant(file.ownerScopeId, `personal:${viewer}`))) return null
      const bytes = contents.get(id)
      if (!bytes) return null
      return { ...file, bytes }
    },
    async uploadForViewer(principalId, input) {
      const homeScope = input.scopeId ?? `personal:${principalId}`
      if (homeScope !== `personal:${principalId}`) return null
      if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new ByteSourceTooLargeError()
      const staged = await deps.blobTransfer.put(input.bytes, { maxBytes: MAX_UPLOAD_BYTES })
      const file: StoredFile = {
        id: randomUUID(),
        ownerScopeId: homeScope,
        principalId,
        name: input.name,
        ...(input.mimetype ? { mimetype: input.mimetype } : {}),
        sizeBytes: staged.sizeBytes,
        blobId: staged.blobId,
        createdAt: Date.now(),
      }
      files.set(file.id, file)
      contents.set(file.id, input.bytes)
      return file
    },
  }
}
