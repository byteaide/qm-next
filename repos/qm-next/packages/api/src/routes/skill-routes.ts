/**
 * Parity skills routes (11.0 tranche 4, contract "skills"): registry CRUD +
 * restore over the `SkillStore`. Lane-A simplifications (deviation #43): no
 * packs → `source:"native"`, `pack` omitted, `assetCount:0`, `files:[]`;
 * `grantedCapabilities:[]` until the 12.0 capability grants; `editable` is
 * `createdBy === viewer` (admin override arrives with the admin service);
 * qm's `trigger_blocked` 403s need the trigger mode (13.0).
 */
import type { ScopeId } from '@qm/types'
import { parseScopeId, personalScope } from '@qm/types'
import { isSafeSkillName } from '@qm/skills'
import type { SkillRecord, SkillStore } from '@qm/skills'
import type { ApiRouteContext, Route } from './framework.ts'
import { notFound, sendJson } from './framework.ts'

export interface SkillRoutesDeps {
  skills?: SkillStore | undefined
  scopeFor: () => ScopeId
}

function badRequest(ctx: ApiRouteContext, message: string) {
  return sendJson(ctx, 400, { error: 'bad_request', message })
}

function forbidden(ctx: ApiRouteContext, message: string) {
  return sendJson(ctx, 403, { error: 'forbidden', message })
}

function viewerOf(ctx: ApiRouteContext): string | undefined {
  return ctx.actor?.id ?? (typeof ctx.query.principalId === 'string' ? ctx.query.principalId : undefined)
}

function scopeChain(deps: SkillRoutesDeps, viewer: string): ScopeId[] {
  return [personalScope(viewer), deps.scopeFor()]
}

function skillView(r: { skill: SkillRecord; shadowed: SkillRecord[] }, viewer: string): Record<string, unknown> {
  const s = r.skill
  const view: Record<string, unknown> = {
    id: s.id,
    name: s.name,
    description: s.description,
    scope: parseScopeId(s.scopeId).kind ?? s.scopeId,
    scopeId: s.scopeId,
    shadowed: r.shadowed.length > 0,
    status: s.status,
    version: s.version,
    source: 'native',
    assetCount: 0,
    requiredCapabilities: s.requiredCapabilities,
    editable: s.createdBy === viewer,
  }
  return view
}

async function visibleSkills(store: SkillStore, viewer: string, deps: SkillRoutesDeps): Promise<Array<{ skill: SkillRecord; shadowed: SkillRecord[] }>> {
  const resolved = await store.visibleFor(scopeChain(deps, viewer))
  return resolved.filter((r): r is { skill: SkillRecord; shadowed: SkillRecord[] } => r.skill !== null)
}

export function skillRoutes(deps: SkillRoutesDeps): ReadonlyArray<Route> {
  return [
    {
      method: 'GET',
      path: '/v1/skills',
      auth: 'source',
      handle: async (ctx) => {
        if (!deps.skills) return notFound(ctx)
        const principalId = ctx.query.principalId
        if (typeof principalId !== 'string' || !principalId) return badRequest(ctx, 'principalId required')
        const includeShadowed = ctx.query.includeShadowed === '1'
        const visible = await visibleSkills(deps.skills, principalId, deps)
        const archived = (await deps.skills.list())
          .filter((skill) => skill.status === 'archived' && skill.createdBy === principalId)
          .map((skill) => ({ skill, shadowed: [] as SkillRecord[] }))
        const rows = visible.flatMap((r) => [
          r,
          ...(includeShadowed ? r.shadowed.map((skill) => ({ skill, shadowed: [] as SkillRecord[] })) : []),
        ])
        return sendJson(ctx, 200, { skills: [...rows, ...archived].map((r) => skillView(r, principalId)) })
      },
    },
    {
      method: 'GET',
      path: '/v1/skills/:id',
      auth: 'either',
      handle: async (ctx) => {
        if (!deps.skills) return notFound(ctx)
        const viewer = viewerOf(ctx)
        if (!viewer) return badRequest(ctx, 'viewer required')
        const id = ctx.params.id
        if (!id) return notFound(ctx)
        const record = await deps.skills.get(id)
        if (!record) return notFound(ctx)
        const visible = await visibleSkills(deps.skills, viewer, deps)
        const row = visible.find((r) => r.skill.id === id || r.shadowed.some((s) => s.id === id))
        const manageable = record.createdBy === viewer
        if (!row && !manageable) return notFound(ctx)
        const base = row ? skillView({ skill: record, shadowed: row.shadowed }, viewer) : skillView({ skill: record, shadowed: [] }, viewer)
        return sendJson(ctx, 200, {
          skill: {
            ...base,
            body: record.body,
            files: [] as Array<{ path: string; executable: boolean }>,
            grantedCapabilities: [] as string[],
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          },
        })
      },
    },
    {
      method: 'POST',
      path: '/v1/skills',
      auth: 'either',
      handle: async (ctx) => {
        if (!deps.skills) return notFound(ctx)
        const viewer = viewerOf(ctx)
        if (!viewer) return badRequest(ctx, 'viewer required')
        const b = (ctx.body ?? {}) as Record<string, unknown>
        if (typeof b.name !== 'string' || typeof b.description !== 'string' || typeof b.body !== 'string') {
          return badRequest(ctx, 'name, description, and body (strings) required')
        }
        if (!isSafeSkillName(b.name)) return badRequest(ctx, 'invalid skill name')
        let scopeId = personalScope(viewer)
        if (typeof b.scopeId === 'string' && b.scopeId !== scopeId) {
          const parsed = parseScopeId(b.scopeId)
          if (parsed.kind === 'org' || parsed.kind === 'team' || parsed.kind === null) {
            return forbidden(ctx, 'skills can only be created in your personal scope')
          }
          if (parsed.kind !== 'personal' || parsed.ref !== viewer) {
            return forbidden(ctx, 'skills can only be created in your personal scope')
          }
          scopeId = b.scopeId
        }
        try {
          const record = await deps.skills.register({
            scopeId,
            name: b.name,
            description: b.description,
            body: b.body,
            createdBy: viewer,
          })
          return sendJson(ctx, 201, { skill: skillView({ skill: record, shadowed: [] }, viewer) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (message.includes('collision')) {
            return sendJson(ctx, 409, { error: 'exists', message })
          }
          throw error
        }
      },
    },
    {
      method: 'PUT',
      path: '/v1/skills/:id',
      auth: 'either',
      handle: async (ctx) => {
        if (!deps.skills) return notFound(ctx)
        const viewer = viewerOf(ctx)
        if (!viewer) return badRequest(ctx, 'viewer required')
        const id = ctx.params.id
        if (!id) return notFound(ctx)
        const record = await deps.skills.get(id)
        if (!record) return notFound(ctx)
        if (record.createdBy !== viewer) return forbidden(ctx, 'only the creator can update a skill')
        const body = (ctx.body ?? {}) as Record<string, unknown>
        const patch: { description?: string; body?: string } = {}
        if (body.description !== undefined) {
          if (typeof body.description !== 'string') return badRequest(ctx, 'description must be a string')
          patch.description = body.description
        }
        if (body.body !== undefined) {
          if (typeof body.body !== 'string') return badRequest(ctx, 'body must be a string')
          patch.body = body.body
        }
        const updated = await deps.skills.update(id, patch)
        return sendJson(ctx, 200, {
          skill: { id: updated.id, name: updated.name, description: updated.description, body: updated.body, status: updated.status, version: updated.version },
        })
      },
    },
    {
      method: 'DELETE',
      path: '/v1/skills/:id',
      auth: 'either',
      handle: async (ctx) => {
        if (!deps.skills) return notFound(ctx)
        const viewer = viewerOf(ctx)
        if (!viewer) return badRequest(ctx, 'viewer required')
        const id = ctx.params.id
        if (!id) return notFound(ctx)
        const record = await deps.skills.get(id)
        if (!record) return sendJson(ctx, 404, { error: 'missing', message: 'unknown skill' })
        if (record.createdBy !== viewer) return forbidden(ctx, 'only the creator can delete a skill')
        // qm's DELETE is a soft delete (restore brings it back).
        await deps.skills.archive(id)
        return sendJson(ctx, 200, { ok: true })
      },
    },
    {
      method: 'POST',
      path: '/v1/skills/:id/restore',
      auth: 'either',
      handle: async (ctx) => {
        if (!deps.skills) return notFound(ctx)
        const viewer = viewerOf(ctx)
        if (!viewer) return badRequest(ctx, 'viewer required')
        const id = ctx.params.id
        if (!id) return notFound(ctx)
        const record = await deps.skills.get(id)
        if (!record) return notFound(ctx)
        if (record.createdBy !== viewer) return forbidden(ctx, 'only the creator can restore a skill')
        await deps.skills.publish(id)
        return sendJson(ctx, 200, { ok: true })
      },
    },
  ]
}
