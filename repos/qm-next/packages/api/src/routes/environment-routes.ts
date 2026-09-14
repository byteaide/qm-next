/**
 * Parity environment routes (11.0 tranche 5, contract "environments"):
 * agent-scoped runtime environments with qm's owner-mediation attach flow.
 * qm requires an agent capability token; lane A's signed bearer substitutes
 * it (deviation #43) and the attach scope is the caller's personal scope.
 */
import type { ApiRouteContext, Route } from './framework.ts'
import { isObj, notFound, sendJson } from './framework.ts'
import { personalScope } from '@qm/types'
import type { EnvironmentRegistry } from '../services/environment-registry.ts'

export interface EnvironmentRoutesDeps {
  environments?: EnvironmentRegistry
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function requireCapabilityActor(ctx: ApiRouteContext): string | null {
  if (!ctx.actor) {
    sendJson(ctx, 403, { error: 'forbidden', message: 'environments require an agent capability token' })
    return null
  }
  return ctx.actor.id
}

export function environmentRoutes(deps: EnvironmentRoutesDeps): ReadonlyArray<Route> {
  return [
    {
      method: 'GET',
      path: '/v1/environments',
      auth: 'either',
      handle: async (ctx: ApiRouteContext) => {
        const viewer = requireCapabilityActor(ctx)
        if (!viewer) return
        if (!deps.environments) return notFound(ctx)
        const rows = deps.environments.list().filter(({ environment }) => environment.ownerActorId === viewer)
        return sendJson(ctx, 200, {
          environments: rows.map(({ environment, attachments }) => ({
            id: environment.id,
            name: environment.name,
            ownerActorId: environment.ownerActorId,
            attachedScopes: attachments.map((a) => a.scopeId),
          })),
        })
      },
    },
    {
      method: 'POST',
      path: '/v1/environments',
      auth: 'either',
      handle: async (ctx: ApiRouteContext) => {
        const viewer = requireCapabilityActor(ctx)
        if (!viewer) return
        if (!deps.environments) return notFound(ctx)
        const body = isObj(ctx.body) ? ctx.body : {}
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (!name) return sendJson(ctx, 400, { error: 'bad_request', message: 'name (string) required' })
        try {
          const env = deps.environments.create({ name, ownerActorId: viewer })
          return sendJson(ctx, 200, { environment: { id: env.id, name: env.name, ownerActorId: env.ownerActorId } })
        } catch (e) {
          return sendJson(ctx, 400, { error: 'environment_create_failed', message: errMessage(e) })
        }
      },
    },
    {
      method: 'POST',
      path: '/v1/environments/attach',
      auth: 'either',
      handle: async (ctx: ApiRouteContext) => {
        const viewer = requireCapabilityActor(ctx)
        if (!viewer) return
        if (!deps.environments) return notFound(ctx)
        const body = isObj(ctx.body) ? ctx.body : {}
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (!name) return sendJson(ctx, 400, { error: 'bad_request', message: 'name (string) required' })
        const env = deps.environments.resolveByName(name)
        if (!env) return sendJson(ctx, 404, { error: 'environment_not_found', message: `no environment named "${name}"` })
        if (env.ownerActorId && env.ownerActorId !== viewer) {
          return sendJson(ctx, 403, {
            error: 'owner_mediation_required',
            message: `environment "${name}" is owned by ${env.ownerActorId}. Ask them to attach this conversation to it (the same way you'd ask an owner for a credential grant) — only its owner can attach others.`,
            ownerActorId: env.ownerActorId,
          })
        }
        try {
          deps.environments.attach(env.id, personalScope(viewer))
          return sendJson(ctx, 200, { ok: true, environment: { id: env.id, name: env.name } })
        } catch (e) {
          return sendJson(ctx, 400, { error: 'environment_attach_failed', message: errMessage(e) })
        }
      },
    },
  ]
}
