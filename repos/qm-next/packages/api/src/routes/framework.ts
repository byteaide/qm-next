/**
 * Route framework for the parity surface (P3 11.0): declarative
 * `{ method, path, auth, handle }` tables over Fastify with qm's `RouteAuth`
 * semantics enforced uniformly. `source` maps onto signed bearer tokens (the
 * plugin-signer equivalent in qm-next); the `x-agent-capability` header is
 * verified as an agent capability token (12.0 control plane) — a capability
 * caller rides `ctx.capability` and `ctx.actor`; `either` means bearer
 * optional. Shapes and error codes follow docs/parity-api-contract.md.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Principal } from '@qm/types'
import { CONTROL_PLANE_AUD, verifyCapabilityToken, type CapabilityClaims } from '@qm/auth'
import { authenticateBearerWithClaims, type AuthenticatedRequest } from '../auth.ts'

/** qm RouteAuth: public, source-signed, either (source or capability), or audience-scoped. */
export type RouteAuth = 'public' | 'source' | 'either' | { aud: string }

export type RouteMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'

/** qm capability header (api/contract.ts). */
export const CAPABILITY_HEADER = 'x-agent-capability'

/** Per-request context handed to route handlers (qm ApiCtx slice, lane A). */
export interface ApiRouteContext {
  req: FastifyRequest
  reply: FastifyReply
  params: Record<string, string>
  query: Record<string, string>
  body: unknown
  /** Bearer-authenticated principal; also set from a verified capability token. */
  actor: Principal | null
  /** Agent capability token claims; verified from the capability header (12.0). */
  capability: CapabilityClaims | null
}

export interface Route {
  method: RouteMethod
  path: string
  auth: RouteAuth
  /** Must respond via `sendJson` (or reply directly); a returned value is sent as 200 JSON. */
  handle: (ctx: ApiRouteContext) => Promise<unknown>
}

export function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** qm `sendJson` equivalent: one JSON body with an explicit status. */
export function sendJson(ctx: ApiRouteContext, status: number, body: unknown): void {
  void ctx.reply.code(status).send(body)
}

export function badRequest(ctx: ApiRouteContext, message: string, error = 'bad_request'): void {
  sendJson(ctx, 400, { error, message })
}

/** Dependency not wired (qm 通用守卫): `404 { error: "not_found" }`. */
export function notFound(ctx: ApiRouteContext): void {
  sendJson(ctx, 404, { error: 'not_found' })
}

const UNAUTHORIZED = { error: 'unauthorized', message: 'missing or invalid bearer token' } as const

function capabilityFromHeaders(req: FastifyRequest): string | null {
  const h = req.headers[CAPABILITY_HEADER]
  const value = Array.isArray(h) ? h[0] : h
  return typeof value === 'string' && value ? value : null
}

/**
 * Capability gate (qm server.ts gate): a capability header must verify
 * (401 when invalid/expired); aud routes demand a matching audience (401
 * without, 403 mismatched); `either` accepts control-plane/audience-less
 * tokens (403 for foreign audiences). Returns the claims or an error reply
 * descriptor.
 */
async function capabilityGate(
  req: FastifyRequest,
  opts: { secrets: string[] },
  routeAuth: RouteAuth,
): Promise<{ claims: CapabilityClaims | null; error?: { status: number; body: unknown } }> {
  const capToken = capabilityFromHeaders(req)
  if (!capToken) {
    if (typeof routeAuth === 'object') {
      return {
        claims: null,
        error: { status: 401, body: { error: 'unauthorized', message: `${routeAuth.aud} capability token required` } },
      }
    }
    return { claims: null }
  }
  const capability = await verifyCapabilityToken(capToken, opts.secrets)
  if (!capability) {
    return {
      claims: null,
      error: { status: 401, body: { error: 'unauthorized', message: 'invalid or expired capability token' } },
    }
  }
  if (typeof routeAuth === 'object') {
    if (capability.aud !== routeAuth.aud) {
      return {
        claims: capability,
        error: {
          status: 403,
          body: {
            error: 'forbidden',
            message: `this route requires a capability token with audience "${routeAuth.aud}"`,
          },
        },
      }
    }
  } else if (routeAuth === 'either') {
    if (capability.aud !== undefined && capability.aud !== CONTROL_PLANE_AUD) {
      return {
        claims: capability,
        error: {
          status: 403,
          body: { error: 'forbidden', message: 'capability token audience not valid for this route' },
        },
      }
    }
  } else if (routeAuth === 'source') {
    return {
      claims: capability,
      error: { status: 403, body: { error: 'forbidden', message: 'capability token not valid for this route' } },
    }
  }
  return { claims: capability }
}

/**
 * Register a route table. Auth guard: a valid capability header rides the
 * capability ladder; otherwise `source` requires a valid bearer, `either`
 * authenticates when a token is present, and `{ aud }` requires the named
 * audience claim on the bearer. Handlers run after the guard.
 */
export function registerRouteTable(app: FastifyInstance, opts: { secrets: string[] }, table: ReadonlyArray<Route>): void {
  for (const route of table) {
    const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const cap = await capabilityGate(req, opts, route.auth)
      if (cap.error) return reply.code(cap.error.status).send(cap.error.body)
      let authed: AuthenticatedRequest | null = null
      if (!cap.claims && route.auth !== 'public') {
        authed = await authenticateBearerWithClaims(req.headers.authorization, opts.secrets)
        if (route.auth === 'source') {
          if (!authed) return reply.code(401).send(UNAUTHORIZED)
        } else if (typeof route.auth === 'object') {
          if (!authed) return reply.code(401).send(UNAUTHORIZED)
          if (authed.claims.aud !== route.auth.aud) {
            return reply.code(403).send({ error: 'forbidden', message: `audience ${route.auth.aud} required` })
          }
        }
      }
      const ctx: ApiRouteContext = {
        req,
        reply,
        params: (req.params ?? {}) as Record<string, string>,
        query: (req.query ?? {}) as Record<string, string>,
        body: req.body,
        actor: cap.claims
          ? { id: cap.claims.actorId, type: 'internal' }
          : (authed?.principal ?? null),
        capability: cap.claims,
      }
      const result = await route.handle(ctx)
      if (!reply.sent) {
        if (result === undefined) return reply.code(200).send({ ok: true })
        return reply.code(200).send(result)
      }
      return reply
    }
    app.route({ method: route.method, url: route.path, handler })
  }
}
