/**
 * Parity context-policy routes (11.0 tranche 5, contract "context-policy"):
 * per-channel standing orders / bot ledger / ambient opt-in with qm's exact
 * validation ladder and the optimistic-lock 409. When `memberScope` is wired
 * (server.ts derives it from the directory), both verbs return 403 for
 * principals outside the scope — qm's `memberScope` ladder (deviation #44
 * closed); without it the lane-A open behavior answers the policy.
 */
import type { ApiRouteContext, Route } from './framework.ts'
import { isObj, notFound, sendJson } from './framework.ts'
import { parseScopeId } from '@qm/types'
import type { ScopeAccessCheck } from './scope-access.ts'
import { parseBotLedger, type ChannelPolicyStore } from '../services/channel-policy-store.ts'

const MAX_ORDERS_CHARS = 20_000

export interface ContextPolicyRoutesDeps {
  channelPolicy?: ChannelPolicyStore
  /** Directory-backed member gate; open lane when absent. */
  memberScope?: ScopeAccessCheck
}

function channelContainer(scope: string): string | undefined {
  const { kind, ref } = parseScopeId(scope)
  return ref && (kind === 'channel' || kind === 'group') ? ref : undefined
}

function policyView(p: { orders: string; bots: Record<string, unknown>; ambientEnabled?: boolean; updatedAt: number } | null) {
  return {
    orders: p?.orders ?? '',
    bots: p?.bots ?? {},
    ambientEnabled: p?.ambientEnabled ?? null,
    updatedAt: p?.updatedAt ?? 0,
  }
}

export function contextPolicyRoutes(deps: ContextPolicyRoutesDeps): ReadonlyArray<Route> {
  return [
    {
      method: 'GET',
      path: '/v1/contexts/policy',
      auth: 'source',
      handle: async (ctx: ApiRouteContext) => {
        const principalId = (ctx.query.principalId ?? '').trim()
        const scope = (ctx.query.scope ?? '').trim()
        if (!principalId || !scope) return sendJson(ctx, 400, { error: 'bad_request', message: 'principalId and scope required' })
        const container = channelContainer(scope)
        if (!container) {
          return sendJson(ctx, 400, {
            error: 'bad_request',
            message: 'ambient policy applies to channel and group scopes only',
          })
        }
        if (!deps.channelPolicy) return notFound(ctx)
        if (deps.memberScope && !(await deps.memberScope(principalId, scope))) {
          return sendJson(ctx, 403, { error: 'forbidden' })
        }
        const p = await deps.channelPolicy.get(container)
        return sendJson(ctx, 200, { policy: policyView(p) })
      },
    },
    {
      method: 'PUT',
      path: '/v1/contexts/policy',
      auth: 'source',
      handle: async (ctx: ApiRouteContext) => {
        const body = isObj(ctx.body) ? ctx.body : {}
        const principalId = typeof body.principalId === 'string' ? body.principalId.trim() : ''
        const scope = typeof body.scope === 'string' ? body.scope.trim() : ''
        if (!principalId || !scope) return sendJson(ctx, 400, { error: 'bad_request', message: 'principalId and scope required' })
        const container = channelContainer(scope)
        if (!container) {
          return sendJson(ctx, 400, {
            error: 'bad_request',
            message: 'ambient policy applies to channel and group scopes only',
          })
        }
        if (!deps.channelPolicy) return notFound(ctx)
        if (deps.memberScope && !(await deps.memberScope(principalId, scope))) {
          return sendJson(ctx, 403, { error: 'forbidden' })
        }
        if (typeof body.orders !== 'string') return sendJson(ctx, 400, { error: 'bad_request', message: 'orders (string) required' })
        if (body.orders.length > MAX_ORDERS_CHARS) {
          return sendJson(ctx, 400, {
            error: 'bad_request',
            message: `standing order is capped at ${MAX_ORDERS_CHARS} characters — it is rendered into every ambient judgment`,
          })
        }
        const parsed = parseBotLedger(body.bots ?? {})
        if ('error' in parsed) return sendJson(ctx, 400, { error: 'bad_request', message: parsed.error })
        if (body.ambientEnabled !== undefined && body.ambientEnabled !== null && typeof body.ambientEnabled !== 'boolean') {
          return sendJson(ctx, 400, {
            error: 'bad_request',
            message: 'ambientEnabled must be a boolean or null (null = default rule)',
          })
        }
        const current = await deps.channelPolicy.get(container)
        if (typeof body.baseUpdatedAt === 'number' && (current?.updatedAt ?? 0) !== body.baseUpdatedAt) {
          return sendJson(ctx, 409, {
            error: 'conflict',
            message: "this channel's policy changed since you loaded it — reload and re-apply your edit",
          })
        }
        const setBy = principalId
        const ambientEnabled =
          body.ambientEnabled === undefined || body.ambientEnabled === null
            ? undefined
            : (body.ambientEnabled as boolean)
        const p = await deps.channelPolicy.set(container, body.orders, {
          ...(setBy ? { setBy } : {}),
          bots: parsed.bots,
          ...(ambientEnabled !== undefined ? { ambientEnabled } : {}),
        })
        return sendJson(ctx, 200, { policy: policyView(p) })
      },
    },
  ]
}
