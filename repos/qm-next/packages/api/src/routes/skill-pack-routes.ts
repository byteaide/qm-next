/**
 * /v1/admin/skill-packs — pack registry management (qm skill-packs.ts):
 * admin-gated with `skill_pack.*` audit intent; lane A has no git fetcher,
 * so register records qm's fetch-failure import row and catalog/sync/
 * import surface the fetch error (deviation #46).
 */
import type { SkillPackStore } from '../services/skill-pack-store.ts'
import { SkillPackFetchError } from '../services/skill-pack-store.ts'
import type { SkillStore } from '@qm/skills'
import { badRequest, sendJson, type ApiRouteContext, type Route } from './framework.ts'
import { AdminError } from '../services/admin-service.ts'

export interface SkillPackDeps {
  packs: SkillPackStore
  skills?: SkillStore
  orgScope: string
  admins: { adminStatusOf(principalId: string): Promise<{ isAdmin: boolean }> }
}

function asSubset(v: unknown): 'all' | string[] | undefined {
  if (v === 'all' || v === undefined) return 'all'
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[]
  return undefined
}

function asScopeIds(v: unknown): string[] | undefined {
  if (v === undefined) return []
  if (!Array.isArray(v)) return undefined
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') return undefined
    out.push(x)
  }
  return [...new Set(out)]
}

async function authorize(ctx: ApiRouteContext, deps: SkillPackDeps): Promise<string | null> {
  if (!ctx.actor) {
    sendJson(ctx, 403, { error: 'forbidden', message: 'admin grant required for this scope' })
    return null
  }
  const status = await deps.admins.adminStatusOf(ctx.actor.id)
  if (!status.isAdmin) {
    sendJson(ctx, 403, { error: 'forbidden', message: 'admin grant required for this scope' })
    return null
  }
  return ctx.actor.id
}

async function registerPack(ctx: ApiRouteContext, deps: SkillPackDeps): Promise<unknown> {
  const actorId = await authorize(ctx, deps)
  if (!actorId) return undefined
  const b = (ctx.body ?? {}) as Record<string, unknown>
  if (typeof b.url !== 'string' || !b.url.trim()) return badRequest(ctx, 'url is required')
  const subset = asSubset(b.subset)
  if (subset === undefined) return badRequest(ctx, "subset must be 'all' or string[]")
  const pack = await deps.packs.create({
    kind: 'git',
    url: b.url.trim(),
    ref: typeof b.ref === 'string' ? b.ref.trim() : '',
    syncMode: 'pinned',
    trustTier: b.trustTier === 'internal' ? 'internal' : 'third-party',
    targetScopeId: deps.orgScope,
    subset,
    createdBy: actorId,
  })
  try {
    throw new SkillPackFetchError()
  } catch (error) {
    await deps.packs.recordImport(pack.id, {
      at: Date.now(),
      commit: pack.ref,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return { pack: await deps.packs.get(pack.id) }
}

async function listPacks(ctx: ApiRouteContext, deps: SkillPackDeps): Promise<unknown> {
  const actorId = await authorize(ctx, deps)
  if (!actorId) return undefined
  const packs = await deps.packs.list()
  return { packs: packs.map((p) => ({ ...p, importedCount: 0 })) }
}

async function packCatalog(ctx: ApiRouteContext, deps: SkillPackDeps): Promise<unknown> {
  const actorId = await authorize(ctx, deps)
  if (!actorId) return undefined
  const id = ctx.params.id
  if (!id) return badRequest(ctx, 'id required')
  const pack = await deps.packs.get(id)
  if (!pack) throw new Error(`unknown skill pack: ${id}`)
  return sendJson(ctx, 400, { error: 'bad_request', message: 'git pack fetching is not available in this deployment' })
}

async function importPack(ctx: ApiRouteContext, deps: SkillPackDeps): Promise<unknown> {
  const actorId = await authorize(ctx, deps)
  if (!actorId) return undefined
  const body = (ctx.body ?? {}) as Record<string, unknown>
  const subset = asSubset(body.selected)
  if (subset === undefined) return badRequest(ctx, "selected must be 'all' or string[]")
  const scopeIds = asScopeIds(body.scopeIds)
  if (scopeIds === undefined) return badRequest(ctx, "scopeIds must be an array of 'kind:ref' scope ids")
  const id = ctx.params.id
  const pack = id ? await deps.packs.get(id) : null
  if (!pack) throw new Error(`unknown skill pack: ${id}`)
  return sendJson(ctx, 400, { error: 'bad_request', message: 'git pack fetching is not available in this deployment' })
}

async function syncPack(ctx: ApiRouteContext, deps: SkillPackDeps): Promise<unknown> {
  const actorId = await authorize(ctx, deps)
  if (!actorId) return undefined
  const id = ctx.params.id
  const pack = id ? await deps.packs.get(id) : null
  if (!pack) throw new Error(`unknown skill pack: ${id}`)
  return sendJson(ctx, 400, { error: 'bad_request', message: 'git pack fetching is not available in this deployment' })
}

async function patchPack(ctx: ApiRouteContext, deps: SkillPackDeps): Promise<unknown> {
  const actorId = await authorize(ctx, deps)
  if (!actorId) return undefined
  const b = (ctx.body ?? {}) as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  if (typeof b.ref === 'string' && b.ref.trim()) patch.ref = b.ref.trim()
  if (typeof b.url === 'string' && b.url.trim()) patch.url = b.url.trim()
  if (b.trustTier === 'internal' || b.trustTier === 'third-party') patch.trustTier = b.trustTier
  if (b.syncMode === 'pinned' || b.syncMode === 'tracked') patch.syncMode = b.syncMode
  if (b.subset !== undefined) {
    const subset = asSubset(b.subset)
    if (subset === undefined) return badRequest(ctx, "subset must be 'all' or string[]")
    patch.subset = subset
  }
  const pack = await deps.packs.update(ctx.params.id!, patch)
  return { pack }
}

async function removePack(ctx: ApiRouteContext, deps: SkillPackDeps): Promise<unknown> {
  const actorId = await authorize(ctx, deps)
  if (!actorId) return undefined
  const id = ctx.params.id
  const mine = ((await deps.skills?.list()) ?? []).filter((s) => s.createdBy === `pack:${id}`)
  for (const s of mine) await deps.skills!.delete(s.id)
  await deps.packs.remove(id!)
  return { removed: mine.length }
}

export function skillPackRoutes(deps: SkillPackDeps): ReadonlyArray<Route> {
  void AdminError
  return [
    { method: 'POST', path: '/v1/admin/skill-packs', auth: 'either', handle: (ctx) => registerPack(ctx, deps) },
    { method: 'GET', path: '/v1/admin/skill-packs', auth: 'either', handle: (ctx) => listPacks(ctx, deps) },
    { method: 'GET', path: '/v1/admin/skill-packs/:id/catalog', auth: 'either', handle: (ctx) => packCatalog(ctx, deps) },
    { method: 'POST', path: '/v1/admin/skill-packs/:id/import', auth: 'either', handle: (ctx) => importPack(ctx, deps) },
    { method: 'POST', path: '/v1/admin/skill-packs/:id/sync', auth: 'either', handle: (ctx) => syncPack(ctx, deps) },
    { method: 'PATCH', path: '/v1/admin/skill-packs/:id', auth: 'either', handle: (ctx) => patchPack(ctx, deps) },
    { method: 'DELETE', path: '/v1/admin/skill-packs/:id', auth: 'either', handle: (ctx) => removePack(ctx, deps) },
  ]
}
