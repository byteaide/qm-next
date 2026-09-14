/**
 * /v1/grants, /v1/grants/revoke, /v1/share — qm grant surface (source
 * signed) and artifact sharing. Grant validation mirrors
 * repos/qm/src/api/routes/surface.ts (isGrant); sharing requires a valid
 * agent capability token (qm shareArtifact gate) — files share through the
 * grant ledger, other artifact stores converge at 13.0.
 */
import { parseScopeId } from '@qm/types'
import type { DirectoryStore } from '@qm/directory'
import type { GrantLedger } from '../services/grant-ledger.ts'
import type { FileStoreService } from '../services/file-store.ts'
import { badRequest, isObj, sendJson, type ApiRouteContext, type Route } from './framework.ts'

export interface GrantDeps {
  grants: GrantLedger
  orgScope: string
  files?: FileStoreService
  directory?: DirectoryStore
}

const ARTIFACT_TYPES = ['file', 'skill', 'deploy', 'cron'] as const
type ArtifactType = (typeof ARTIFACT_TYPES)[number]

function isArtifactType(s: string): s is ArtifactType {
  return (ARTIFACT_TYPES as readonly string[]).includes(s)
}

function splitToScope(toScope: string): { scope: string } | { recipient: string } {
  const t = toScope.trim()
  return t === 'org' || parseScopeId(t).kind !== null ? { scope: t } : { recipient: t }
}

function isGrant(b: unknown): b is { ownerScopeId: string; ref: string; granteeScopeId: string; permission: 'read' | 'write'; grantedBy: string } {
  return (
    isObj(b) &&
    typeof b.ownerScopeId === 'string' &&
    typeof b.ref === 'string' &&
    typeof b.granteeScopeId === 'string' &&
    (b.permission === 'read' || b.permission === 'write') &&
    typeof b.grantedBy === 'string'
  )
}

async function createGrant(ctx: ApiRouteContext, deps: GrantDeps): Promise<unknown> {
  if (!isGrant(ctx.body)) return badRequest(ctx, 'expected a Grant')
  try {
    await deps.grants.grant(ctx.body)
    return { ok: true }
  } catch (error) {
    return sendJson(ctx, 400, { error: 'grant_failed', message: error instanceof Error ? error.message : String(error) })
  }
}

async function revokeGrant(ctx: ApiRouteContext, deps: GrantDeps): Promise<unknown> {
  const b = (ctx.body ?? {}) as { ownerScopeId?: string; ref?: string; granteeScopeId?: string; revokedBy?: string }
  if (!b.ownerScopeId || !b.ref || !b.granteeScopeId || typeof b.revokedBy !== 'string' || !b.revokedBy) {
    return badRequest(ctx, 'ownerScopeId, ref, granteeScopeId, revokedBy required')
  }
  try {
    await deps.grants.revokeGrant(b.ownerScopeId, b.ref, b.granteeScopeId, b.revokedBy)
    return { ok: true }
  } catch (error) {
    return sendJson(ctx, 400, { error: 'revoke_failed', message: error instanceof Error ? error.message : String(error) })
  }
}

async function shareArtifact(ctx: ApiRouteContext, deps: GrantDeps): Promise<unknown> {
  const capability = ctx.capability
  if (!capability) {
    return sendJson(ctx, 403, { error: 'forbidden', message: 'sharing requires an agent capability token' })
  }
  const b = (isObj(ctx.body) ? ctx.body : {}) as {
    type?: unknown
    id?: unknown
    toScope?: unknown
    permission?: unknown
    move?: unknown
  }
  if (typeof b.type !== 'string' || !isArtifactType(b.type)) {
    return sendJson(ctx, 400, { error: 'bad_request', message: `type must be one of: ${ARTIFACT_TYPES.join(', ')}` })
  }
  if (typeof b.id !== 'string' || !b.id.trim()) {
    return sendJson(ctx, 400, { error: 'bad_request', message: 'id required' })
  }
  if (typeof b.toScope !== 'string' || !b.toScope.trim()) {
    return sendJson(ctx, 400, {
      error: 'bad_request',
      message: 'toScope required ("org", a scope id, or a teammate\'s name)',
    })
  }
  if (b.permission !== undefined && b.permission !== 'read' && b.permission !== 'write') {
    return sendJson(ctx, 400, { error: 'bad_request', message: 'permission must be "read" or "write"' })
  }
  const target = splitToScope(b.toScope)
  if ('recipient' in target) {
    // Directory recipient resolution (qm resolveRecipient) lands with the
    // directory convergence milestone; names answer not_found for now.
    return sendJson(ctx, 404, { error: 'recipient_not_found', message: `no one matches "${target.recipient}"` })
  }
  const scope = target.scope === 'org' ? deps.orgScope : target.scope
  const permission = b.permission === 'write' ? 'write' : 'read'
  if (b.type !== 'file') {
    return sendJson(ctx, 404, {
      error: 'not_found',
      message: `${b.type} sharing needs the ${b.type} store wiring (converges at 13.0)`,
    })
  }
  if (!deps.files) {
    return sendJson(ctx, 404, { error: 'not_found', message: 'no file store wired' })
  }
  const file = await deps.files.openForViewer(b.id, capability.actorId)
  if (!file) {
    return sendJson(ctx, 404, { error: 'not_found', message: 'file not found in a scope you can see' })
  }
  const ownerScopeId = file.ownerScopeId
  if (ownerScopeId !== `personal:${capability.actorId}` && file.principalId !== capability.actorId) {
    return sendJson(ctx, 403, { error: 'forbidden', message: 'only the file owner can share it' })
  }
  try {
    await deps.grants.grant({
      ownerScopeId,
      ref: b.id,
      granteeScopeId: scope,
      permission,
      grantedBy: capability.actorId,
    })
  } catch (error) {
    return sendJson(ctx, 400, {
      error: 'share_failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  return sendJson(ctx, 200, {
    ok: true,
    verb: b.move === true ? 'move' : 'share',
    type: b.type,
    id: b.id,
    target: { scope, label: target.scope === 'org' ? 'everyone in the org' : scope },
    permission,
  })
}

export function grantRoutes(deps: GrantDeps): ReadonlyArray<Route> {
  return [
    { method: 'POST', path: '/v1/grants', auth: 'source', handle: (ctx) => createGrant(ctx, deps) },
    { method: 'POST', path: '/v1/grants/revoke', auth: 'source', handle: (ctx) => revokeGrant(ctx, deps) },
    { method: 'POST', path: '/v1/share', auth: 'either', handle: (ctx) => shareArtifact(ctx, deps) },
  ]
}
