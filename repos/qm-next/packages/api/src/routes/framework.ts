/**
 * Route framework for the parity surface (P3 11.0): declarative
 * `{ method, path, auth, handle }` tables over Fastify with qm's `RouteAuth`
 * semantics enforced uniformly. `source` maps onto signed bearer tokens (the
 * plugin-signer equivalent in qm-next); `either` means bearer optional until
 * real capability tokens land with the control plane (12.0) — handlers then
 * enforce capability requirements against `ctx.capability`, which is null in
 * lane A. Shapes and error codes follow docs/parity-api-contract.md.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Principal } from '@qm/types'
import { authenticateBearerWithClaims, type AuthenticatedRequest } from '../auth.ts'

/** qm RouteAuth: public, source-signed, either (source or capability), or audience-scoped. */
export type RouteAuth = 'public' | 'source' | 'either' | { aud: string }

export type RouteMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'

/** Per-request context handed to route handlers (qm ApiCtx slice, lane A). */
export interface ApiRouteContext {
  req: FastifyRequest
  reply: FastifyReply
  params: Record<string, string>
  query: Record<string, string>
  body: unknown
  /** Bearer-authenticated principal; null without a valid token. */
  actor: Principal | null
  /** Agent capability token claims; real tokens land with the control plane (12.0). */
  capability: null
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

/**
 * Register a route table. Auth guard: `source` requires a valid bearer;
 * `either` authenticates when a token is present; `{ aud }` requires the
 * named audience claim. Handlers run after the guard.
 */
export function registerRouteTable(app: FastifyInstance, opts: { secrets: string[] }, table: ReadonlyArray<Route>): void {
  for (const route of table) {
    const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      let authed: AuthenticatedRequest | null = null
      if (route.auth !== 'public') {
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
        actor: authed?.principal ?? null,
        capability: null,
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
