/**
 * Raw-route framework for the parity surface: Fastify registrations that
 * hijack the request in onRequest (before body parsing) so handlers see
 * the exact request bytes — the qm BaseCtx lane for /v1/blobs and
 * /v1/webhooks/incoming/:id. Auth reuses the bearer semantics of the
 * declarative table; source-signed payload verification lands with the
 * control plane (12.0).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Principal } from '@qm/types'
import { authenticateBearerWithClaims, type AuthenticatedRequest } from '../auth.ts'
import type { RouteAuth } from './framework.ts'

export interface RawRouteContext {
  req: FastifyRequest
  reply: FastifyReply
  params: Record<string, string>
  query: Record<string, string>
  url: URL
  rawBody: Buffer
  actor: Principal | null
  capability: null
}

export interface RawRoute {
  method: 'DELETE' | 'GET' | 'HEAD' | 'POST' | 'PUT'
  path: string
  auth: RouteAuth
  /** Collect the request body into rawBody (default false — GET-style routes). */
  readBody?: boolean
  /** Body size cap in bytes (default 1 MiB; blobs pass qm's MAX_BLOB_BYTES). */
  bodyLimitBytes?: number
  handle: (ctx: RawRouteContext) => Promise<void>
}

const DEFAULT_BODY_LIMIT_BYTES = 1_000_000

export function rawSendJson(ctx: RawRouteContext, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  ctx.reply.raw.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(payload)) })
  ctx.reply.raw.end(payload)
}

export function rawSendText(ctx: RawRouteContext, status: number, text: string): void {
  ctx.reply.raw.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) })
  ctx.reply.raw.end(text)
}

function collectBody(req: FastifyRequest, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    req.raw.on('data', (chunk: Buffer) => {
      total += chunk.byteLength
      if (total > limit) {
        req.raw.resume()
        done(() => reject(new Error('payload_too_large')))
        return
      }
      chunks.push(chunk)
    })
    req.raw.on('end', () => done(() => resolve(Buffer.concat(chunks))))
    req.raw.on('error', (error) => done(() => reject(error)))
  })
}

export function registerRawRouteTable(app: FastifyInstance, opts: { secrets: string[] }, table: ReadonlyArray<RawRoute>): void {
  for (const route of table) {
    const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      let authed: AuthenticatedRequest | null = null
      if (route.auth !== 'public') {
        authed = await authenticateBearerWithClaims(req.headers.authorization, opts.secrets)
        if (route.auth === 'source') {
          if (!authed) return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid bearer token' })
        } else if (typeof route.auth === 'object') {
          if (!authed) return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid bearer token' })
          if (authed.claims.aud !== route.auth.aud) {
            return reply.code(403).send({ error: 'forbidden', message: `audience ${route.auth.aud} required` })
          }
        }
      }
      reply.hijack()
      let rawBody: Buffer = Buffer.alloc(0)
      if (route.readBody) {
        try {
          rawBody = await collectBody(req, route.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES)
        } catch (error) {
          if (error instanceof Error && error.message === 'payload_too_large') {
            rawSendJson({ req, reply, params: {}, query: {}, url: new URL('http://localhost'), rawBody, actor: null, capability: null }, 413, {
              error: 'payload_too_large',
              message: `request body exceeds ${route.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES} bytes`,
            })
            return
          }
          throw error
        }
      }
      const ctx: RawRouteContext = {
        req,
        reply,
        params: (req.params ?? {}) as Record<string, string>,
        query: (req.query ?? {}) as Record<string, string>,
        url: new URL(req.url, 'http://localhost'),
        rawBody,
        actor: authed?.principal ?? null,
        capability: null,
      }
      await route.handle(ctx)
    }
    app.route({ method: route.method, url: route.path, onRequest: handler, handler: async () => {} })
  }
}
