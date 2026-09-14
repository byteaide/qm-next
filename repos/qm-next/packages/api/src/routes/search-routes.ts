/**
 * Parity search route (11.0 tranche 5, contract "search"): POST /v1/search
 * fans the query out to the wired search backends. qm requires an agent
 * capability token (401 capability_required); lane A's signed bearer
 * substitutes the capability (deviation #43), and the member set is the
 * caller — shared-conversation member sets arrive with real tokens (12.0).
 * The `search.query` audit event lands with the 12.0 sinks.
 */
import type { ApiRouteContext, Route } from './framework.ts'
import { isObj, notFound, sendJson } from './framework.ts'

export interface SearchHit {
  backend: string
  [key: string]: unknown
}

export interface SearchResult {
  hits: SearchHit[]
  failedBackends: string[]
}

export type SearchBackend = (query: string, principals: string[], limit?: number) => Promise<SearchResult>

export interface SearchRoutesDeps {
  search?: SearchBackend
}

export function searchRoutes(deps: SearchRoutesDeps): ReadonlyArray<Route> {
  return [
    {
      method: 'POST',
      path: '/v1/search',
      auth: 'either',
      handle: async (ctx: ApiRouteContext) => {
        if (!ctx.actor) {
          return sendJson(ctx, 401, { error: 'capability_required', message: 'agent capability token required' })
        }
        if (!deps.search) return notFound(ctx)
        const body = isObj(ctx.body) ? ctx.body : {}
        const query = typeof body.query === 'string' ? body.query.trim() : ''
        if (!query) return sendJson(ctx, 400, { error: 'bad_request', message: 'query required' })
        const principals = [ctx.actor.id]
        const result = await deps.search(query, principals, typeof body.limit === 'number' ? body.limit : undefined)
        return sendJson(ctx, 200, result)
      },
    },
  ]
}
