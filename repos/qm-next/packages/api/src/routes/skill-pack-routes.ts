/**
 * /v1/admin/skill-packs — pack registry management (qm skill-packs.ts).
 * Admin-gated with `skill_pack.*` audit intent. When the composition root
 * supplies a fetcher and SkillStore, catalog/import/sync run the real
 * git fetch + ingest pipeline; without them the routes return a 400
 * "git pack fetching is not available" so dev profiles without git still
 * work. Removes deviation #46.
 */
import type { SkillPackStore } from '../services/skill-pack-store.ts'
import type { SkillPackFetcher, SkillStore } from '@qm/skills'
import { collectSharedBundle, importPack, SkillPackCollisionError } from '@qm/skills'
import { badRequest, sendJson, type ApiRouteContext, type Route } from './framework.ts'

export interface SkillPackDeps {
  packs: SkillPackStore
  skills?: SkillStore
  fetcher?: SkillPackFetcher
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
  if (!deps.fetcher) {
    return sendJson(ctx, 400, { error: 'bad_request', message: 'git pack fetching is not available in this deployment' })
  }
  try {
    const repo = await deps.fetcher.fetch(pack)
    await deps.packs.recordImport(pack.id, {
      at: Date.now(),
      commit: repo.commit,
      status: 'ok',
      counts: { total: repo.files.length },
    })
    return { catalog: { commit: repo.commit, files: repo.files.length } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await deps.packs.recordImport(pack.id, {
      at: Date.now(),
      commit: pack.ref,
      status: 'error',
      error: message,
    })
    return sendJson(ctx, 502, { error: 'pack_fetch_failed', message })
  }
}

async function importPackRoute(ctx: ApiRouteContext, deps: SkillPackDeps): Promise<unknown> {
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
  if (!deps.fetcher || !deps.skills) {
    return sendJson(ctx, 400, { error: 'bad_request', message: 'git pack fetching is not available in this deployment' })
  }
  let repo
  try {
    repo = await deps.fetcher.fetch(pack)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await deps.packs.recordImport(pack.id, {
      at: Date.now(),
      commit: pack.ref,
      status: 'error',
      error: message,
    })
    return sendJson(ctx, 502, { error: 'pack_fetch_failed', message })
  }
  const bundleFiles = collectSharedBundle(repo, pack.config)
  const nativeNames = new Set((await deps.skills.list()).filter((s) => s.pack?.packId === pack.id).map((s) => s.name))
  try {
    const targetScopeId = scopeIds[0] ?? pack.targetScopeId
    const result = await importPack(repo, deps.skills, {
      pack,
      selected: subset,
      nativeNames,
      targetScopeId,
      bundleFiles,
    })
    await deps.packs.recordImport(pack.id, {
      at: Date.now(),
      commit: repo.commit,
      status: 'ok',
      counts: result.counts,
    })
    return { ...result, commit: repo.commit }
  } catch (error) {
    if (error instanceof SkillPackCollisionError) {
      return sendJson(ctx, 409, { error: 'pack_collision', message: error.message, collisions: error.collisions })
    }
    throw error
  }
}

async function syncPack(ctx: ApiRouteContext, deps: SkillPackDeps): Promise<unknown> {
  const actorId = await authorize(ctx, deps)
  if (!actorId) return undefined
  const id = ctx.params.id
  const pack = id ? await deps.packs.get(id) : null
  if (!pack) throw new Error(`unknown skill pack: ${id}`)
  if (!deps.fetcher) {
    return sendJson(ctx, 400, { error: 'bad_request', message: 'git pack fetching is not available in this deployment' })
  }
  try {
    const commit = await deps.fetcher.resolveRef(pack)
    const available = pack.lastImport ? commit !== pack.lastImport.commit : true
    if (available !== Boolean(pack.updateAvailable)) {
      await deps.packs.update(pack.id, { updateAvailable: available })
    }
    return { pack: { ...pack, updateAvailable: available, available } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return sendJson(ctx, 502, { error: 'pack_resolve_failed', message })
  }
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
  return [
    { method: 'POST', path: '/v1/admin/skill-packs', auth: 'either', handle: (ctx) => registerPack(ctx, deps) },
    { method: 'GET', path: '/v1/admin/skill-packs', auth: 'either', handle: (ctx) => listPacks(ctx, deps) },
    { method: 'GET', path: '/v1/admin/skill-packs/:id/catalog', auth: 'either', handle: (ctx) => packCatalog(ctx, deps) },
    { method: 'POST', path: '/v1/admin/skill-packs/:id/import', auth: 'either', handle: (ctx) => importPackRoute(ctx, deps) },
    { method: 'POST', path: '/v1/admin/skill-packs/:id/sync', auth: 'either', handle: (ctx) => syncPack(ctx, deps) },
    { method: 'PATCH', path: '/v1/admin/skill-packs/:id', auth: 'either', handle: (ctx) => patchPack(ctx, deps) },
    { method: 'DELETE', path: '/v1/admin/skill-packs/:id', auth: 'either', handle: (ctx) => removePack(ctx, deps) },
  ]
}
