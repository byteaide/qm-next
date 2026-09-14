/**
 * /v1/blobs — raw binary staging lane (qm blobs.ts): sha-256-verified puts
 * and octet-stream gets. Auth is dual-mode (qm authorizeBlob): a valid
 * blob-transfer capability token rides the x-agent-capability header and
 * binds the direction (and blob id on reads); other callers pass
 * bearer-authenticated or anonymous (the source-signature mapping) with
 * declared hashes still enforced.
 */
import { verifyBlobTransferCapability } from '@qm/auth'
import { BlobHashMismatchError, BlobTooLargeError, MAX_BLOB_BYTES, type BlobTransferService } from '../services/blob-transfer.ts'
import { rawSendJson, type RawRoute, type RawRouteContext } from './raw-framework.ts'

export interface BlobDeps {
  blobTransfer: BlobTransferService | null
}

async function authorizeBlob(ctx: RawRouteContext, secrets: string[], dir: 'read' | 'write', blobId: string | null): Promise<boolean> {
  const capHeader = ctx.req.headers['x-agent-capability']
  const capToken = Array.isArray(capHeader) ? capHeader[0] : capHeader
  if (!capToken) return true
  const expected = dir === 'read' ? { dir, id: blobId ?? '' } : { dir }
  const claims = await verifyBlobTransferCapability(capToken, secrets, expected)
  if (claims) return true
  rawSendJson(ctx, 403, {
    error: 'forbidden',
    message: 'blob-transfer capability token not valid for this transfer',
  })
  return false
}

async function putBlob(ctx: RawRouteContext, deps: BlobDeps, secrets: string[]): Promise<void> {
  if (!deps.blobTransfer) {
    return rawSendJson(ctx, 501, { error: 'not_configured', message: 'no blob transfer store wired' })
  }
  if (!(await authorizeBlob(ctx, secrets, 'write', null))) return
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

async function getBlob(ctx: RawRouteContext, deps: BlobDeps, secrets: string[]): Promise<void> {
  if (!deps.blobTransfer) {
    return rawSendJson(ctx, 501, { error: 'not_configured', message: 'no blob transfer store wired' })
  }
  const id = ctx.params.id
  if (!id) return rawSendJson(ctx, 404, { error: 'not_found' })
  if (!(await authorizeBlob(ctx, secrets, 'read', id))) return
  const blob = await deps.blobTransfer.open(id)
  if (!blob) return rawSendJson(ctx, 404, { error: 'not_found' })
  ctx.reply.raw.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(blob.sizeBytes) })
  ctx.reply.raw.end(blob.bytes)
}

export function blobRoutes(deps: BlobDeps, secrets: string[]): ReadonlyArray<RawRoute> {
  return [
    {
      method: 'POST',
      path: '/v1/blobs',
      auth: 'either',
      readBody: true,
      bodyLimitBytes: MAX_BLOB_BYTES,
      handle: (ctx) => putBlob(ctx, deps, secrets),
    },
    { method: 'GET', path: '/v1/blobs/:id', auth: 'either', handle: (ctx) => getBlob(ctx, deps, secrets) },
  ]
}
