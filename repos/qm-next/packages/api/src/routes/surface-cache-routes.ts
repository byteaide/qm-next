/**
 * Parity surface-cache routes (11.0 tranche 5, contract "surface-cache"):
 * the connector upserts surface events and reads/sets the per-container
 * ambient policy it renders. `toEvent` mirrors qm's normalizer — events
 * without container+ts are dropped before ingest.
 */
import type { ApiRouteContext, Route } from './framework.ts'
import { isObj, notFound, sendJson } from './framework.ts'
import type { ChannelPolicy } from '../services/channel-policy-store.ts'
import type { IngestEvent, SurfaceCacheStore } from '../services/surface-cache-store.ts'

export interface SurfaceCacheRoutesDeps {
  cache?: SurfaceCacheStore
  policy?: (container: string) => Promise<ChannelPolicy | null>
  setPolicy?: (container: string, orders: string, setBy?: string) => Promise<ChannelPolicy | null>
}

function strMap(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v
  return out
}

export function toEvent(raw: unknown): IngestEvent | null {
  if (!isObj(raw)) return null
  if (typeof raw.container !== 'string' || !raw.container) return null
  if (typeof raw.ts !== 'string' || !raw.ts) return null
  const files = Array.isArray(raw.files)
    ? raw.files
        .filter((f): f is Record<string, unknown> => isObj(f) && typeof f.fileId === 'string')
        .map((f) => ({
          fileId: f.fileId as string,
          ...(typeof f.name === 'string' ? { name: f.name } : {}),
          ...(typeof f.mimetype === 'string' ? { mimetype: f.mimetype } : {}),
        }))
    : undefined
  const members = Array.isArray(raw.members) ? raw.members.filter((m): m is string => typeof m === 'string') : undefined
  return {
    container: raw.container,
    ts: raw.ts,
    ...(typeof raw.sub === 'string' && raw.sub ? { sub: raw.sub } : {}),
    ...(typeof raw.authorId === 'string' ? { authorId: raw.authorId } : {}),
    ...(typeof raw.authorName === 'string' ? { authorName: raw.authorName } : {}),
    ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
    ...(isObj(raw.mentions) ? { mentions: strMap(raw.mentions) } : {}),
    ...(raw.self === true ? { self: true } : {}),
    ...(raw.bot === true ? { bot: true } : {}),
    ...(raw.mentionsSelf === true ? { mentionsSelf: true } : {}),
    ...(typeof raw.editedAt === 'number' ? { editedAt: raw.editedAt } : {}),
    ...(raw.deleted === true ? { deleted: true } : {}),
    ...(raw.handled === true ? { handled: true } : {}),
    ...(typeof raw.createdAt === 'number' ? { createdAt: raw.createdAt } : {}),
    ...(files ? { files } : {}),
    ...(members ? { members } : {}),
    ...(typeof raw.containerName === 'string' ? { containerName: raw.containerName } : {}),
    ...(raw.kind === 'channel' || raw.kind === 'dm' || raw.kind === 'group' ? { kind: raw.kind } : {}),
  }
}

export function surfaceCacheRoutes(deps: SurfaceCacheRoutesDeps): ReadonlyArray<Route> {
  return [
    {
      method: 'POST',
      path: '/v1/surface-cache/ingest',
      auth: 'source',
      handle: async (ctx: ApiRouteContext) => {
        if (!deps.cache) return notFound(ctx)
        const body = isObj(ctx.body) ? ctx.body : {}
        const surface = typeof body.surface === 'string' && body.surface ? body.surface : 'slack'
        const events = Array.isArray(body.events) ? body.events.map(toEvent).filter((e): e is IngestEvent => e !== null) : []
        if (!events.length) return sendJson(ctx, 400, { error: 'bad_request', message: 'events[] required' })
        const sb = isObj(body.self) ? body.self : {}
        const self =
          typeof sb.name === 'string' || typeof sb.mentionId === 'string'
            ? {
                ...(typeof sb.name === 'string' ? { name: sb.name } : {}),
                ...(typeof sb.mentionId === 'string' ? { mentionId: sb.mentionId } : {}),
              }
            : undefined
        const { upserted } = deps.cache.ingest(events, surface, self)
        return sendJson(ctx, 200, { ok: true, upserted })
      },
    },
    {
      method: 'GET',
      path: '/v1/surface-cache/policy',
      auth: 'source',
      handle: async (ctx: ApiRouteContext) => {
        const container = ctx.query.container
        if (!container) return sendJson(ctx, 400, { error: 'bad_request', message: 'container required' })
        if (!deps.policy) return notFound(ctx)
        const policy = await deps.policy(container)
        return sendJson(ctx, 200, { policy })
      },
    },
    {
      method: 'POST',
      path: '/v1/surface-cache/policy',
      auth: 'source',
      handle: async (ctx: ApiRouteContext) => {
        const body = isObj(ctx.body) ? ctx.body : {}
        if (typeof body.container !== 'string' || !body.container)
          return sendJson(ctx, 400, { error: 'bad_request', message: 'container required' })
        if (typeof body.orders !== 'string') return sendJson(ctx, 400, { error: 'bad_request', message: 'orders (string) required' })
        if (!deps.setPolicy) return notFound(ctx)
        const setBy = typeof body.setBy === 'string' ? body.setBy : undefined
        const policy = await deps.setPolicy(body.container, body.orders, setBy)
        if (!policy) return sendJson(ctx, 404, { error: 'not_found', message: 'surface cache not enabled' })
        return sendJson(ctx, 200, { policy })
      },
    },
  ]
}
