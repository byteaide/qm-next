/**
 * Lane-A file store: uploads land as in-memory files owned by a personal
 * scope; visibility is owner-or-grant. Uploads consume staged blobs from
 * the blob transfer service (the qm flow); list/content mirror qm's
 * listFilesForViewer / openFileForViewer shapes.
 */
import { randomUUID } from 'node:crypto'
import type { BlobTransferService } from './blob-transfer.ts'
import type { GrantLedger } from './grant-ledger.ts'
import { createPgPool, type DurableByteStore } from '@qm/store'

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

const FILE_ARTIFACTS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS file_artifacts(
    id               TEXT PRIMARY KEY,
    kind             TEXT NOT NULL DEFAULT 'file',
    owner_scope_id   TEXT NOT NULL,
    path             TEXT NOT NULL,
    name             TEXT NOT NULL,
    mimetype         TEXT NOT NULL,
    size_bytes       BIGINT NOT NULL,
    blob_key         TEXT,
    sha256           TEXT,
    direction        TEXT NOT NULL,
    created_by       TEXT NOT NULL,
    created_in_scope TEXT,
    created_at       BIGINT NOT NULL,
    updated_at       BIGINT NOT NULL,
    enabled          BOOLEAN NOT NULL DEFAULT TRUE,
    source           TEXT NOT NULL DEFAULT 'live'
  )`,
  `CREATE INDEX IF NOT EXISTS file_artifacts_owner_created
    ON file_artifacts (owner_scope_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS file_artifacts_owner_path
    ON file_artifacts (owner_scope_id, path)`,
  `CREATE INDEX IF NOT EXISTS file_artifacts_scope_created
    ON file_artifacts (created_in_scope, created_at DESC, id DESC) WHERE enabled = TRUE`,
]

interface ArtifactRow {
  id: string
  ownerScopeId: string
  principalId: string
  name: string
  mimetype: string
  sizeBytes: number
  blobId: string | null
  createdAt: number
  path: string
  sha256: string | null
  enabled: boolean
}

function rowToArtifact(r: Record<string, unknown>): ArtifactRow {
  return {
    id: r.id as string,
    ownerScopeId: r.owner_scope_id as string,
    principalId: r.created_by as string,
    name: r.name as string,
    mimetype: r.mimetype as string,
    sizeBytes: Number(r.size_bytes),
    blobId: (r.blob_key as string | null) ?? null,
    createdAt: Number(r.created_at),
    path: r.path as string,
    sha256: (r.sha256 as string | null) ?? null,
    enabled: r.enabled as boolean,
  }
}

const toStored = (a: ArtifactRow): StoredFile => ({
  id: a.id,
  ownerScopeId: a.ownerScopeId,
  principalId: a.principalId,
  name: a.name,
  ...(a.mimetype ? { mimetype: a.mimetype } : {}),
  sizeBytes: a.sizeBytes,
  blobId: a.blobId ?? '',
  createdAt: a.createdAt,
})

const artifactPathFor = (id: string, name: string): string => `artifacts/${id}/${name}`

/**
 * Postgres twin of the file store (20.0 twin lane): metadata lives in the
 * `file_artifacts` table with qm's exact column layout (migration copies
 * rows verbatim), bytes go through the content-addressed DurableByteStore
 * (`files/<sha256>` keys — a migration moves them by copying the
 * directory). Viewer/grant semantics mirror the memory store.
 */
export function createPostgresFileStore(deps: {
  databaseUrl: string
  byteStore: DurableByteStore
  grants: GrantLedger
}): FileStoreService {
  const store = createPgPool(deps.databaseUrl, FILE_ARTIFACTS_SCHEMA_STATEMENTS)
  const insertArtifact = async (file: StoredFile, sha256: string | null, path: string): Promise<void> => {
    await store.query(
      `INSERT INTO file_artifacts (id, kind, owner_scope_id, path, name, mimetype, size_bytes, blob_key, sha256,
         direction, created_by, created_in_scope, created_at, updated_at, enabled, source)
       VALUES ($1, 'file', $2, $3, $4, $5, $6, $7, $8, 'in', $9, NULL, $10, $10, TRUE, 'live')
       ON CONFLICT (id) DO NOTHING`,
      [
        file.id,
        file.ownerScopeId,
        path,
        file.name,
        file.mimetype ?? 'application/octet-stream',
        file.sizeBytes,
        file.blobId ?? null,
        sha256,
        file.principalId,
        file.createdAt,
      ],
    )
  }
  return {
    async listForViewer(viewer, opts, scope) {
      const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200)
      const rows = (
        await store.q(
          'SELECT * FROM file_artifacts WHERE enabled ORDER BY created_at DESC, id DESC LIMIT $1',
          [2000],
        )
      ).map(rowToArtifact)
      const visibleTo = (f: ArtifactRow): boolean =>
        f.principalId === viewer || f.ownerScopeId === `personal:${viewer}`
      const candidates = rows
        .filter((f) => visibleTo(f))
        .filter((f) => (scope ? f.ownerScopeId === scope : true))
      for (const f of rows) {
        if (visibleTo(f)) continue
        if (scope && f.ownerScopeId !== scope) continue
        if (await deps.grants.hasGrant(f.ownerScopeId, `personal:${viewer}`)) candidates.push(f)
      }
      const all = candidates.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))
      const startIndex = opts?.cursor ? all.findIndex((f) => f.id === opts.cursor) + 1 : 0
      const page = all.slice(Math.max(startIndex, 0), Math.max(startIndex, 0) + limit).map(toStored)
      const next = all[Math.max(startIndex, 0) + limit]
      return next ? { files: page, nextCursor: next.id } : { files: page }
    },
    async listByScopes(scopes, opts) {
      const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 2000)
      const rows = (
        await store.q(
          'SELECT * FROM file_artifacts WHERE enabled AND owner_scope_id = ANY($1) ORDER BY created_at DESC, id DESC LIMIT $2',
          [scopes, limit + 1],
        )
      ).map(rowToArtifact)
      const page = rows.slice(0, limit).map(toStored)
      const next = rows[limit]
      return next ? { files: page, nextCursor: next.id } : { files: page }
    },
    async openForViewer(id, viewer) {
      const rows = await store.q('SELECT * FROM file_artifacts WHERE id = $1', [id])
      const row = rows[0] ? rowToArtifact(rows[0]!) : null
      if (!row || !row.enabled) return null
      const visibleTo = row.principalId === viewer || row.ownerScopeId === `personal:${viewer}`
      if (!visibleTo && !(await deps.grants.hasGrant(row.ownerScopeId, `personal:${viewer}`))) return null
      if (!row.blobId) return null
      const bytes = await deps.byteStore.open(row.blobId)
      if (!bytes) return null
      return { ...toStored(row), bytes: bytes.bytes }
    },
    async uploadForViewer(principalId, input) {
      const homeScope = input.scopeId ?? `personal:${principalId}`
      if (homeScope !== `personal:${principalId}`) return null
      if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new ByteSourceTooLargeError()
      const put = await deps.byteStore.put(input.bytes, { maxBytes: MAX_UPLOAD_BYTES })
      const file: StoredFile = {
        id: randomUUID(),
        ownerScopeId: homeScope,
        principalId,
        name: input.name,
        ...(input.mimetype ? { mimetype: input.mimetype } : {}),
        sizeBytes: put.sizeBytes,
        blobId: put.blobKey,
        createdAt: Date.now(),
      }
      await insertArtifact(file, put.sha256, artifactPathFor(file.id, file.name))
      return file
    },
  }
}
