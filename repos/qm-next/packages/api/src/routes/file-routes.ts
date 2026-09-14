/**
 * /v1/files — qm surface file surface: paginated listing for a viewer,
 * inline binary content, and staged-blob uploads (source mode). Shapes
 * and status codes mirror repos/qm/src/api/routes/surface.ts.
 */
import { ByteSourceTooLargeError, type FileStoreService } from '../services/file-store.ts'
import type { BlobTransferService } from '../services/blob-transfer.ts'
import { badRequest, isObj, notFound, sendJson, type ApiRouteContext, type Route } from './framework.ts'

export interface FileDeps {
  files: FileStoreService
  blobTransfer: BlobTransferService | null
}

function viewerOf(ctx: ApiRouteContext): string | null {
  return ctx.actor?.id ?? null
}

function contentTypeWithUtf8Charset(mimetype: string): string {
  return /^text\//i.test(mimetype) || /(?:^|\/)(?:json|xml|javascript)(?:;|$)/i.test(mimetype)
    ? mimetype.includes('charset')
      ? mimetype
      : `${mimetype}; charset=utf-8`
    : mimetype
}

async function listFiles(ctx: ApiRouteContext, deps: FileDeps): Promise<unknown> {
  const viewer = viewerOf(ctx)
  if (!viewer) return sendJson(ctx, 401, { error: 'capability_required' })
  const limitRaw = ctx.query.limit
  const cursor = ctx.query.cursor
  const scope = ctx.query.scope
  const page = await deps.files.listForViewer(
    viewer,
    { ...(limitRaw ? { limit: Number(limitRaw) } : {}), ...(cursor ? { cursor } : {}) },
    scope || undefined,
  )
  return page
}

async function getFileContent(ctx: ApiRouteContext, deps: FileDeps): Promise<void> {
  const viewer = viewerOf(ctx)
  if (!viewer) return sendJson(ctx, 401, { error: 'capability_required' })
  const id = ctx.params.id
  if (!id) return notFound(ctx)
  const opened = await deps.files.openForViewer(id, viewer)
  if (!opened) return sendJson(ctx, 404, { error: 'not_found' })
  const mimetype = contentTypeWithUtf8Charset(opened.mimetype || 'application/octet-stream')
  ctx.reply.raw.writeHead(200, {
    'content-type': mimetype,
    'content-length': String(opened.sizeBytes),
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(opened.name)}`,
  })
  ctx.reply.raw.end(opened.bytes)
}

async function uploadFile(ctx: ApiRouteContext, deps: FileDeps): Promise<unknown> {
  if (!deps.blobTransfer) return sendJson(ctx, 501, { error: 'not_configured', message: 'blob transfer store not wired' })
  const b = isObj(ctx.body) ? ctx.body : {}
  const principalId = typeof b.principalId === 'string' ? b.principalId.trim() : ''
  const blobId = typeof b.blobId === 'string' ? b.blobId.trim() : ''
  const name = typeof b.name === 'string' ? b.name : ''
  const mimetype = typeof b.mimetype === 'string' ? b.mimetype : undefined
  const scopeId = typeof b.scopeId === 'string' && b.scopeId ? b.scopeId : undefined
  if (!principalId || !blobId || !name) return badRequest(ctx, 'principalId, blobId, and name required')
  const opened = await deps.blobTransfer.open(blobId)
  if (!opened) return sendJson(ctx, 404, { error: 'not_found', message: 'staged blob not found' })
  try {
    const file = await deps.files.uploadForViewer(principalId, {
      ...(scopeId ? { scopeId } : {}),
      name,
      ...(mimetype ? { mimetype } : {}),
      bytes: opened.bytes,
    })
    if (!file) return sendJson(ctx, 403, { error: 'forbidden', message: 'you can only upload to your own contexts' })
    return { file }
  } catch (error) {
    if (error instanceof ByteSourceTooLargeError) {
      return sendJson(ctx, 413, { error: 'payload_too_large', message: error.message })
    }
    throw error
  } finally {
    await deps.blobTransfer.delete(blobId)
  }
}

export function fileRoutes(deps: FileDeps): ReadonlyArray<Route> {
  return [
    { method: 'GET', path: '/v1/files', auth: 'either', handle: (ctx) => listFiles(ctx, deps) },
    { method: 'GET', path: '/v1/files/:id/content', auth: 'either', handle: (ctx) => getFileContent(ctx, deps) },
    { method: 'POST', path: '/v1/files/upload', auth: 'source', handle: (ctx) => uploadFile(ctx, deps) },
  ]
}
