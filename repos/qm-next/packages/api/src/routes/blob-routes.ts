/**
 * /v1/blobs — raw binary staging lane (qm blobs.ts): sha-256-verified
 * puts and octet-stream gets. Lane A accepts bearer-authenticated or
 * anonymous callers (source-signature and blob-transfer capability
 * verification land with the 12.0 control plane); declared hashes are
 * still enforced.
 */
import { BlobHashMismatchError, BlobTooLargeError, MAX_BLOB_BYTES, type BlobTransferService } from '../services/blob-transfer.ts'
import { rawSendJson, type RawRoute, type RawRouteContext } from './raw-framework.ts'

export interface BlobDeps {
  blobTransfer: BlobTransferService | null
}

async function putBlob(ctx: RawRouteContext, deps: BlobDeps): Promise<void> {
  if (!deps.blobTransfer) {
    return rawSendJson(ctx, 501, { error: 'not_configured', message: 'no blob transfer store wired' })
  }
  const declaredSha = (ctx.req.headers['x-content-sha256'] as string | undefined) ?? ''
  try {
    const info = await deps.blobTransfer.put(ctx.rawBody, {
      maxBytes: MAX_BLOB_BYTES,
      ...(declaredSha ? { expectedSha256: declaredSha } : {}),
    })
    return rawSendJson(ctx, 200, { blobId: info.blobId, sizeBytes: info.sizeBytes })
  } catch (error) {
    if (error instanceof BlobTooLargeError) return rawSendJson(ctx, 413, { error: 'payload_too_large', message: error.message })
    if (error instanceof BlobHashMismatchError) return rawSendJson(ctx, 400, { error: 'hash_mismatch', message: error.message })
    throw error
  }
}

async function getBlob(ctx: RawRouteContext, deps: BlobDeps): Promise<void> {
  if (!deps.blobTransfer) {
    return rawSendJson(ctx, 501, { error: 'not_configured', message: 'no blob transfer store wired' })
  }
  const id = ctx.params.id
  if (!id) return rawSendJson(ctx, 404, { error: 'not_found' })
  const blob = await deps.blobTransfer.open(id)
  if (!blob) return rawSendJson(ctx, 404, { error: 'not_found' })
  ctx.reply.raw.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(blob.sizeBytes) })
  ctx.reply.raw.end(blob.bytes)
}

export function blobRoutes(deps: BlobDeps): ReadonlyArray<RawRoute> {
  return [
    { method: 'POST', path: '/v1/blobs', auth: 'either', readBody: true, bodyLimitBytes: MAX_BLOB_BYTES, handle: (ctx) => putBlob(ctx, deps) },
    { method: 'GET', path: '/v1/blobs/:id', auth: 'either', handle: (ctx) => getBlob(ctx, deps) },
  ]
}
