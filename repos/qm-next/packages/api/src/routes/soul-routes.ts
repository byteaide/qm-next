/**
 * /v1/soul — qm soul surface: read composes the org policy with the scope
 * soul (qm getSoul shape); writes enforce the personal-scope ownership
 * rule (shared-scope writes need managesScope — a real directory check
 * that lands with 13.0).
 */
import { parseScopeId } from '@qm/types'
import type { SoulStore } from '../services/soul-store.ts'
import { badRequest, isObj, sendJson, type ApiRouteContext, type Route } from './framework.ts'

export interface SoulDeps {
  soul: SoulStore
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
  if (!allowedPersonal) {
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
