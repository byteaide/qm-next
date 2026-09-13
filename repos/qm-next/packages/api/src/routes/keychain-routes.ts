/**
 * Keychain routes (parity contract "keychain", 11 routes) over the
 * @qm/credentials Keychain. Auth `either`; every handler requires an
 * authenticated principal (lane-A capability stand-in, deviation #37) and
 * answers `401 {error:"unauthorized"}` without one — qm's shape.
 * `KeychainError` maps to `{error:"keychain", message}` with its own status.
 * Lane-A gaps (deviation #41): overview usage log and scope names are empty
 * until the audit/credential-usage sinks land (12.0); the ask-owner notice
   enqueue and the liveActor own-use gate arrive with the control plane.
 */
import { renderUseScript } from '@qm/credentials'
import { KeychainError, type Keychain, type KeychainGrant, type MaterializedCred } from '@qm/types'
import type { ApiRouteContext, Route } from './framework.ts'
import { badRequest, isObj, notFound, sendJson } from './framework.ts'

export interface KeychainRoutesDeps {
  keychain?: () => Keychain | undefined
  /** Conversation scope of the caller (grant audience / ask origin). */
  scopeFor?: (actorId: string) => string
}

function err(ctx: ApiRouteContext, e: unknown): void {
  if (e instanceof KeychainError) {
    return sendJson(ctx, e.status, { error: 'keychain', message: e.message })
  }
  const message = e instanceof Error ? e.message : String(e)
  sendJson(ctx, 400, { error: 'bad_request', message })
}

function scopeOf(ctx: ApiRouteContext, deps: KeychainRoutesDeps): string {
  return deps.scopeFor?.(ctx.actor?.id ?? '') ?? 'org:default'
}

/** Guards shared by every keychain route (contract: 401 without capability). */
function gate(ctx: ApiRouteContext, deps: KeychainRoutesDeps): { keychain: Keychain; actorId: string } | null {
  if (!ctx.actor) {
    sendJson(ctx, 401, { error: 'unauthorized', message: 'keychain access requires an agent capability token' })
    return null
  }
  const keychain = deps.keychain?.()
  if (!keychain) {
    notFound(ctx)
    return null
  }
  return { keychain, actorId: ctx.actor.id }
}

function dedupeGrants(grants: KeychainGrant[]): KeychainGrant[] {
  return [...new Map(grants.map((g) => [g.id, g])).values()]
}

async function ownerAndScopeGrants(keychain: Keychain, actorId: string, scopeId: string): Promise<KeychainGrant[]> {
  const owned = await keychain.listGrants({ ownerId: actorId })
  const scoped = (await keychain.grantsForScope(scopeId)).map((g) => g.grant)
  return dedupeGrants([...owned, ...scoped])
}

export function keychainRoutes(deps: KeychainRoutesDeps): ReadonlyArray<Route> {
  return [
    {
      method: 'POST',
      path: '/v1/keychain/credentials',
      auth: 'either',
      handle: async (ctx) => {
        const g = gate(ctx, deps)
        if (!g) return
        const b = isObj(ctx.body) ? ctx.body : {}
        if (typeof b.service !== 'string' || !b.service.trim()) return badRequest(ctx, 'service is required', 'keychain')
        try {
          const credential = await g.keychain.save({
            ownerId: g.actorId,
            service: b.service,
            ...(typeof b.secret === 'string' ? { secret: b.secret } : {}),
            ...(typeof b.envKey === 'string' ? { envKey: b.envKey } : {}),
            ...(Array.isArray(b.fields) ? { fields: b.fields } : {}),
            ...(typeof b.target === 'string' ? { target: b.target } : {}),
            ...(Array.isArray(b.files) ? { files: b.files } : {}),
            ...(typeof b.host === 'string' ? { host: b.host } : {}),
            ...(typeof b.accountLabel === 'string' ? { accountLabel: b.accountLabel } : {}),
            ...(typeof b.origin === 'string' ? { origin: b.origin } : { origin: `agent-session:${scopeOf(ctx, deps)}` }),
            ...(typeof b.expiresAt === 'number' ? { expiresAt: b.expiresAt } : {}),
          })
          return sendJson(ctx, 200, { credential })
        } catch (e) {
          return err(ctx, e)
        }
      },
    },
    {
      method: 'GET',
      path: '/v1/keychain/credentials',
      auth: 'either',
      handle: async (ctx) => {
        const g = gate(ctx, deps)
        if (!g) return
        try {
          return sendJson(ctx, 200, { credentials: await g.keychain.listByOwner(g.actorId) })
        } catch (e) {
          return err(ctx, e)
        }
      },
    },
    {
      method: 'GET',
      path: '/v1/keychain/overview',
      auth: 'either',
      handle: async (ctx) => {
        const g = gate(ctx, deps)
        if (!g) return
        try {
          const [credentials, grants, asks] = await Promise.all([
            g.keychain.listByOwner(g.actorId),
            ownerAndScopeGrants(g.keychain, g.actorId, scopeOf(ctx, deps)),
            g.keychain.listAsks({ requesterId: g.actorId }),
          ])
          const pending = asks.filter((a) => a.status === 'pending')
          return sendJson(ctx, 200, {
            credentials,
            connectorCredentials: [],
            grants,
            asks: pending,
            usage: [],
            scopeNames: {},
          })
        } catch (e) {
          return err(ctx, e)
        }
      },
    },
    {
      method: 'DELETE',
      path: '/v1/keychain/credentials/:id',
      auth: 'either',
      handle: async (ctx) => {
        const g = gate(ctx, deps)
        if (!g) return
        const id = ctx.params.id
        if (!id) return notFound(ctx)
        try {
          if (!(await g.keychain.remove(g.actorId, id))) return notFound(ctx)
          return sendJson(ctx, 200, { ok: true })
        } catch (e) {
          return err(ctx, e)
        }
      },
    },
    {
      method: 'POST',
      path: '/v1/keychain/grants',
      auth: 'either',
      handle: async (ctx) => {
        const g = gate(ctx, deps)
        if (!g) return
        const b = isObj(ctx.body) ? ctx.body : {}
        const mode = b.mode === 'standing' ? 'standing' : 'once'
        if (typeof b.purpose !== 'string' || !b.purpose.trim()) return badRequest(ctx, 'purpose is required', 'keychain')
        try {
          const scopeId = scopeOf(ctx, deps)
          if (typeof b.ask === 'string' && b.ask) {
            const approved = await g.keychain.approveAsk({
              askId: b.ask,
              ownerId: g.actorId,
              mode,
              purpose: b.purpose,
              ...(typeof b.expiresAt === 'number' ? { expiresAt: b.expiresAt } : {}),
            })
            return sendJson(ctx, 200, { grant: approved.grant, ask: approved.ask })
          }
          if (typeof b.credential !== 'string' || !b.credential) return badRequest(ctx, 'credential or ask id is required', 'keychain')
          const grant = await g.keychain.createGrant({
            credentialId: b.credential,
            ownerId: g.actorId,
            audienceScopeId: scopeId,
            mode,
            purpose: b.purpose,
            ...(typeof b.expiresAt === 'number' ? { expiresAt: b.expiresAt } : {}),
          })
          return sendJson(ctx, 200, {
            grant,
            ...(grant.audienceScopeId === scopeId
              ? { use: { note: 'grant is valid for this conversation — call POST /v1/keychain/use with {grant}' } }
              : {}),
          })
        } catch (e) {
          return err(ctx, e)
        }
      },
    },
    {
      method: 'GET',
      path: '/v1/keychain/grants',
      auth: 'either',
      handle: async (ctx) => {
        const g = gate(ctx, deps)
        if (!g) return
        try {
          return sendJson(ctx, 200, { grants: await ownerAndScopeGrants(g.keychain, g.actorId, scopeOf(ctx, deps)) })
        } catch (e) {
          return err(ctx, e)
        }
      },
    },
    {
      method: 'POST',
      path: '/v1/keychain/grants/:id/revoke',
      auth: 'either',
      handle: async (ctx) => {
        const g = gate(ctx, deps)
        if (!g) return
        const id = ctx.params.id
        if (!id) return notFound(ctx)
        try {
          if (!(await g.keychain.revokeGrant(g.actorId, id))) return notFound(ctx)
          return sendJson(ctx, 200, { ok: true })
        } catch (e) {
          return err(ctx, e)
        }
      },
    },
    {
      method: 'POST',
      path: '/v1/keychain/asks',
      auth: 'either',
      handle: async (ctx) => {
        const g = gate(ctx, deps)
        if (!g) return
        const b = isObj(ctx.body) ? ctx.body : {}
        if (typeof b.credential !== 'string' || !b.credential) return badRequest(ctx, 'credential is required', 'keychain')
        if (typeof b.purpose !== 'string' || !b.purpose.trim()) return badRequest(ctx, 'purpose is required', 'keychain')
        try {
          const result = await g.keychain.createAsk({
            credentialId: b.credential,
            requesterId: g.actorId,
            requesterScopeId: scopeOf(ctx, deps),
            purpose: b.purpose,
            ...(b.requestedMode === 'once' || b.requestedMode === 'standing' ? { requestedMode: b.requestedMode } : {}),
            ...(typeof b.expiresAt === 'number' ? { expiresAt: b.expiresAt } : {}),
          })
          return sendJson(ctx, 200, result)
        } catch (e) {
          return err(ctx, e)
        }
      },
    },
    {
      method: 'GET',
      path: '/v1/keychain/asks',
      auth: 'either',
      handle: async (ctx) => {
        const g = gate(ctx, deps)
        if (!g) return
        try {
          // qm's three-way visibility: requester, owner, requester scope.
          const [requested, owned, scoped] = await Promise.all([
            g.keychain.listAsks({ requesterId: g.actorId }),
            g.keychain.listAsks({ ownerId: g.actorId }),
            g.keychain.listAsks({ requesterScopeId: scopeOf(ctx, deps) }),
          ])
          const asks = [...new Map([...requested, ...owned, ...scoped].map((a) => [a.id, a])).values()]
          return sendJson(ctx, 200, { asks })
        } catch (e) {
          return err(ctx, e)
        }
      },
    },
    {
      method: 'POST',
      path: '/v1/keychain/asks/:id/decline',
      auth: 'either',
      handle: async (ctx) => {
        const g = gate(ctx, deps)
        if (!g) return
        const id = ctx.params.id
        if (!id) return notFound(ctx)
        const b = isObj(ctx.body) ? ctx.body : {}
        try {
          const ask = await g.keychain.declineAsk({
            askId: id,
            ownerId: g.actorId,
            ...(typeof b.note === 'string' ? { note: b.note } : {}),
          })
          return sendJson(ctx, 200, { ask })
        } catch (e) {
          return err(ctx, e)
        }
      },
    },
    {
      method: 'POST',
      path: '/v1/keychain/use',
      auth: 'either',
      handle: async (ctx) => {
        const g = gate(ctx, deps)
        if (!g) return
        const b = isObj(ctx.body) ? ctx.body : {}
        const grantId = typeof b.grant === 'string' ? b.grant : undefined
        const credentialId = typeof b.credential === 'string' ? b.credential : undefined
        if (!grantId && !credentialId) return badRequest(ctx, 'grant or credential is required', 'keychain')
        try {
          const scopeId = scopeOf(ctx, deps)
          let materialized: MaterializedCred
          if (grantId) materialized = await g.keychain.materialize(grantId, scopeId, g.actorId)
          else materialized = await g.keychain.materializeOwnById(g.actorId, credentialId!, scopeId)
          void ctx.reply.code(200).header('content-type', 'text/plain; charset=utf-8').send(renderUseScript(materialized))
        } catch (e) {
          return err(ctx, e)
        }
      },
    },
  ]
}
