/**
 * The portal cordis service: qm's portal-front topology on the qm-next
 * single-process runtime (deviation #49 closure). `createPortalServer` mounts
 * the SSO routes (`registerPortal`) plus the surface-relay half: every
 * non-/auth path proxies to the web-ui upstream, and a valid portal session
 * rides along as the `webuiuser` cookie + a short-TTL `x-portal-identity`
 * header — the exact trust shape of qm's `proxyToSurface`. The web-ui
 * verifies the header when `portalIdentitySecret` matches, so signed-in
 * principals reach the SPA and its api relay without the dev cookie lane.
 * Admin status probes the core `/v1/admin/whoami` lane (60s cache), matching
 * qm's whoami-based admin gate.
 */
import { mintPortalIdentity, mintSignedPayload, PORTAL_IDENTITY_HEADER } from '@qm/auth'
import { Service, type Context } from '@qm/cordis'
import Schema from '@qm/schemastery'
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { Readable } from 'node:stream'
import { createPortalState, portalBootProblems, registerPortal, renewSessionCookies, currentSession, type PortalDeps } from './portal-routes.ts'

const IDENTITY_TTL_MS = 60_000
const ADMIN_CACHE_TTL_MS = 60_000

/**
 * Structural slices of the composed services the portal fronts. Declared
 * locally (no package imports) because @qm/api depends on @qm/portal — the
 * wiring happens at the cordis context level, not the package level.
 */
export interface PortalCoreApi {
  app: {
    inject(req: { method: 'GET'; url: string; headers: Record<string, string> }): Promise<{ statusCode: number; body: string; json(): unknown }>
  }
  config: { secrets?: string[] }
}

export interface PortalWebUi {
  address: { host: string; port: number }
}

/** Headers never forwarded in either direction (hop-by-hop + identity seams). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

export interface PortalServerDeps extends PortalDeps {}

export interface PortalServerOpts {
  host: string
  port: number
  /** The web-ui surface upstream, e.g. `http://127.0.0.1:8096`. */
  webUiOrigin: string
}

/**
 * The portal front: SSO routes on /auth/*, the admin gate, and the web-ui
 * surface proxy for everything else. The Fastify instance listens on the
 * caller's host/port.
 */
export function createPortalServer(deps: PortalServerDeps, opts: PortalServerOpts): FastifyInstance {
  const problems = portalBootProblems(deps)
  if (problems.length) throw new Error(`portal config invalid: ${problems.join('; ')}`)
  const app = fastify({ logger: false })
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
  app.addContentTypeParser('text/plain', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

  registerPortal(app, deps)
  const state = createPortalState(deps)
  const upstream = opts.webUiOrigin.replace(/\/$/, '')

  app.all('/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const session = currentSession(state, req)
    const headers: Record<string, string> = { host: new URL(upstream).host }
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase()
      if (HOP_BY_HOP.has(key) || key === PORTAL_IDENTITY_HEADER) continue
      if (key === 'cookie') continue
      if (typeof v === 'string') headers[key] = v
    }
    if (session) {
      headers.cookie = `webuiuser=${encodeURIComponent(session.sub)}${session.name ? `; webuiuser_name=${encodeURIComponent(session.name)}` : ''}`
      headers[PORTAL_IDENTITY_HEADER] = mintPortalIdentity(
        {
          p: session.sub,
          ...(session.name ? { n: session.name } : {}),
          exp: (deps.now?.() ?? Date.now()) + IDENTITY_TTL_MS,
        },
        state.identitySecret,
      )
      const renewed = renewSessionCookies(state, req)
      if (renewed) reply.header('set-cookie', renewed)
    }
    // Fastify's parsers consumed the raw stream: JSON arrives as an object,
    // octet-stream/plain/other types as buffers. Serialize accordingly and
    // let undici compute content-length from the buffer.
    const parsed = req.body as Buffer | string | object | undefined
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && parsed !== undefined
    const body = !hasBody
      ? undefined
      : Buffer.isBuffer(parsed)
        ? parsed
        : typeof parsed === 'string'
          ? Buffer.from(parsed)
          : Buffer.from(JSON.stringify(parsed))
    const upstreamRes = await fetch(`${upstream}${req.raw.url ?? '/'}`, {
      method: req.method,
      headers,
      ...(body !== undefined ? { body: new Uint8Array(body) } : {}),
    })
    for (const [k, v] of upstreamRes.headers) {
      const key = k.toLowerCase()
      if (HOP_BY_HOP.has(key)) continue
      if (key === 'set-cookie') continue
      reply.header(k, v)
    }
    const cookies = upstreamRes.headers.getSetCookie()
    if (cookies.length) reply.header('set-cookie', [...(reply.getHeader('set-cookie') as string[] | undefined) ?? [], ...cookies])
    reply.code(upstreamRes.status)
    if (upstreamRes.body) return reply.send(Readable.fromWeb(upstreamRes.body as Parameters<typeof Readable.fromWeb>[0]))
    return reply.send()
  })
  return app
}

/** Whoami-based admin probe over the core api (qm `adminStatusFromCore`), 60s cached. */
export function createCoreAdminProbe(api: PortalCoreApi): (principalId: string) => Promise<boolean> {
  const cache = new Map<string, { value: boolean; expiresAt: number }>()
  return async (principalId: string): Promise<boolean> => {
    const now = Date.now()
    const hit = cache.get(principalId)
    if (hit && hit.expiresAt > now) return hit.value
    const secret = api.config.secrets?.[0] ?? ''
    const res = await api.app.inject({
      method: 'GET',
      url: '/v1/admin/whoami',
      headers: { authorization: `Bearer ${await mintSignedPayload({ p: principalId, exp: now + 60_000 }, secret)}` },
    })
    let value = false
    try {
      const body = res.json() as { isAdmin?: unknown }
      value = body.isAdmin === true
    } catch {}
    cache.set(principalId, { value, expiresAt: now + ADMIN_CACHE_TTL_MS })
    return value
  }
}

export interface PortalConfig {
  /** Listen port. */
  port?: number
  /** Listen host; loopback by default. */
  host?: string
  /** Organization id stamped into session claims. */
  orgId?: string
  /** Public portal origin (returnTo sanitization + secure-cookie detection). */
  publicUrl?: string
  /** Session/identity signing secret; shared with web-ui's portalIdentitySecret. */
  sessionSecret?: string
  /** Identity-mint secret; defaults to sessionSecret. */
  identitySecret?: string
  /** Loopback dev sign-in without an OIDC round trip (dev only). */
  localAuthBypass?: boolean
  /** Principal for the local dev bypass lane. */
  devPrincipal?: string
  /** Parent domain for cross-subdomain session cookies. */
  appsDomain?: string
}

export const Config = Schema.object({
  port: Schema.number().default(8095).description('Portal listen port'),
  host: Schema.string().default('127.0.0.1').description('Listen host; loopback by default'),
  orgId: Schema.string().default('dev').description('Organization id stamped into session claims'),
  publicUrl: Schema.string().description('Public portal origin; defaults to the loopback bind'),
  sessionSecret: Schema.string().description('Session/identity signing secret; shared with web-ui portalIdentitySecret'),
  identitySecret: Schema.string().description('Identity-mint secret; defaults to sessionSecret'),
  localAuthBypass: Schema.boolean().default(true).description('Loopback dev sign-in without an OIDC round trip'),
  devPrincipal: Schema.string().description('Principal for the local dev bypass lane'),
  appsDomain: Schema.string().description('Parent domain for cross-subdomain session cookies'),
})

export class PortalService extends Service<PortalConfig> {
  static Config = Config

  static inject = ['api', 'web-ui'] as const

  /** Listen address; available once the plugin fiber is active. */
  address = { port: 0, host: '' }

  constructor(ctx: Context, public config: PortalConfig) {
    super(ctx, 'portal')
  }

  async [Service.init]() {
    // Structural view: the portal package intentionally has no compile-time
    // dependency on @qm/api (@qm/api imports @qm/portal); the cordis context
    // wires the instances at the profile level.
    const ctx = this.ctx as unknown as { api?: PortalCoreApi; 'web-ui'?: PortalWebUi }
    const api = ctx.api
    if (!api) throw new Error('portal requires the api service (ctx.api) — load @qm/api first')
    const webUi = ctx['web-ui']
    if (!webUi) throw new Error('portal requires the web-ui service (ctx.web-ui) — load @qm/web-ui first')
    const host = this.config.host ?? '127.0.0.1'
    const port = this.config.port ?? 8095
    const sessionSecret = this.config.sessionSecret ?? ''
    if (!sessionSecret) throw new Error('portal requires sessionSecret (shared with web-ui portalIdentitySecret)')
    const publicUrl = this.config.publicUrl ?? `http://127.0.0.1:${port}`
    const deps: PortalServerDeps = {
      orgId: this.config.orgId ?? 'dev',
      publicUrl,
      sessionSecret,
      ...(this.config.identitySecret ? { identitySecret: this.config.identitySecret } : {}),
      ...(this.config.appsDomain ? { appsDomain: this.config.appsDomain } : {}),
      localAuthBypass: this.config.localAuthBypass ?? true,
      ...(this.config.devPrincipal ? { devPrincipal: this.config.devPrincipal } : {}),
      adminStatusOf: createCoreAdminProbe(api),
    }
    const app = createPortalServer(deps, {
      host,
      port,
      webUiOrigin: `http://${webUi.address.host}:${webUi.address.port}`,
    })
    await app.listen({ port, host })
    const addr = app.server.address()
    if (typeof addr === 'object' && addr !== null) this.address = { port: addr.port, host: addr.address }
    return async () => {
      await app.close()
    }
  }
}

export default PortalService
