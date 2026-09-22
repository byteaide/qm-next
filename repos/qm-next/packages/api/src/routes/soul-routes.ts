/**
 * /v1/soul — qm soul surface: read composes the org policy with the scope
 * soul (qm getSoul shape); writes enforce the personal-scope ownership rule
 * and allow shared-scope writes only through `managesScope` (server.ts
 * derives it from the directory — qm `createCanManageScope` semantics).
 */
import { parseScopeId } from '@qm/types'
import type { SoulStore } from '../services/soul-store.ts'
import type { ScopeAccessCheck } from './scope-access.ts'
import { badRequest, isObj, sendJson, type ApiRouteContext, type Route } from './framework.ts'

export interface SoulDeps {
  soul: SoulStore
  /** Directory-backed shared-scope write gate; deny-all for shared scopes when absent. */
  managesScope?: ScopeAccessCheck
}

function getSoul(ctx: ApiRouteContext, deps: SoulDeps): unknown {
  const scopeIdVal = ctx.query.scopeId
  if (!scopeIdVal) return sendJson(ctx, 400, { error: 'bad_request', message: 'scopeId required' })
  return deps.soul.getSoul(scopeIdVal)
}

async function postSoul(ctx: ApiRouteContext, deps: SoulDeps): Promise<unknown> {
  const b = isObj(ctx.body) ? (ctx.body as Record<string, unknown>) : {}
  const scopeIdVal = typeof b.scopeId === 'string' ? b.scopeId : undefined
  const content = typeof b.content === 'string' ? b.content : undefined
  const actorId = typeof b.actorId === 'string' ? b.actorId : undefined
  if (!scopeIdVal || !content || !actorId) {
    return badRequest(ctx, 'scopeId, content, actorId required')
  }
  const parsed = parseScopeId(scopeIdVal)
  const allowedPersonal = parsed.kind === 'personal' && parsed.ref === actorId
  const allowedShared =
    !allowedPersonal && Boolean(deps.managesScope && (await deps.managesScope(actorId, scopeIdVal)))
  if (!allowedPersonal && !allowedShared) {
    return sendJson(ctx, 403, { error: 'soul_update_denied', message: 'not authorized to update SOUL for this scope' })
  }
  try {
    const version = await deps.soul.setSoul(scopeIdVal, content)
    return { ok: true, version }
  } catch (error) {
    return sendJson(ctx, 500, {
      error: 'soul_update_failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

export function soulRoutes(deps: SoulDeps): ReadonlyArray<Route> {
  return [
    { method: 'GET', path: '/v1/soul', auth: 'either', handle: (ctx) => Promise.resolve(getSoul(ctx, deps)) },
    { method: 'POST', path: '/v1/soul', auth: 'either', handle: (ctx) => postSoul(ctx, deps) },
  ]
}
