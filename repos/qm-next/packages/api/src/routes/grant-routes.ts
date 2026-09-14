/**
 * /v1/grants, /v1/grants/revoke, /v1/share — qm grant surface (source
 * signed) and artifact sharing. Grant validation mirrors
 * repos/qm/src/api/routes/surface.ts (isGrant); sharing requires an agent
 * capability token — source-signed callers included — so lane A answers
 * the qm 403 until the 12.0 control plane mints capability tokens.
 */
import type { GrantLedger } from '../services/grant-ledger.ts'
import { badRequest, isObj, sendJson, type ApiRouteContext, type Route } from './framework.ts'

export interface GrantDeps {
  grants: GrantLedger
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

export function grantRoutes(deps: GrantDeps): ReadonlyArray<Route> {
  return [
    { method: 'POST', path: '/v1/grants', auth: 'source', handle: (ctx) => createGrant(ctx, deps) },
    { method: 'POST', path: '/v1/grants/revoke', auth: 'source', handle: (ctx) => revokeGrant(ctx, deps) },
    {
      method: 'POST',
      path: '/v1/share',
      auth: 'either',
      handle: (ctx) => {
        sendJson(ctx, 403, { error: 'forbidden', message: 'sharing requires an agent capability token' })
        return Promise.resolve(undefined)
      },
    },
  ]
}
