/**
 * Admin console (qm plugins/admin): the byte-level SPA shell served with
 * qm's CSP/etag/gzip discipline plus the /api/* proxy onto the in-process
 * /v1/admin surface with the x-admin-actor header. Identity rides the
 * x-portal-identity header when a portal secret is configured; without one
 * (dev only) the unsigned `admin` cookie is trusted, exactly like qm's
 * ALLOW_UNSIGNED_TEST_IDENTITY lane. Branding injection and streaming file
 * uploads land with the portal/web-runtime convergence (13.0).
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { PORTAL_IDENTITY_HEADER, verifyPortalIdentity, MissingPortalSecretError, requirePortalIdentitySecret } from '@qm/auth'
import type { AdminStatus } from '../services/admin-service.ts'

export interface AdminUiDeps {
  orgId: string
  adminStatus: ((principalId: string) => Promise<AdminStatus>) | undefined
  portalIdentitySecret?: string
}

const ADMIN_BASE = '/admin/ui'

const WRITES = new Map<string, string[]>([
  ['grants', ['POST', 'DELETE']],
  ['external-users', ['POST', 'DELETE']],
  ['memory', ['PUT']],
  ['crons', ['PUT']],
  ['skills', ['DELETE']],
  ['skill-packs', ['POST', 'PATCH', 'DELETE']],
  ['users', ['PUT', 'POST']],
  ['slack-installation', ['PUT', 'DELETE']],
  ['model-providers', ['PUT', 'DELETE']],
  ['custom-providers', ['PUT', 'DELETE']],
  ['scopes', ['PUT', 'POST']],
])

const READS = [
  'metrics',
  'egress',
  'errors',
  'audit',
  'crons',
  'deployments',
  'skills',
  'skill-packs',
  'sessions',
  'runs',
  'files',
  'retention',
  'users',
  'directory',
  'keychain',
  'memory',
  'slack-mirror',
  'ambient-judgments',
  'ack-emoji-picks',
  'slack-installation',
  'slack-emoji',
  'model-providers',
  'custom-providers',
  'scopes',
  'resources',
]

interface Shell {
  html: string
  gzip: Buffer
  etag: string
  csp: string
}

let shellCache: Shell | null = null

function loadShell(): Shell {
  if (shellCache) return shellCache
  const base = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../admin-ui/index.html'), 'utf8')
  const html = base.replaceAll('__ADMIN_BASE__', () => ADMIN_BASE)
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ''
  const csp = [
    "default-src 'self'",
    `script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
  shellCache = {
    html,
    gzip: gzipSync(html),
    etag: `"${createHash('sha256').update(html).digest('hex').slice(0, 16)}"`,
    csp,
  }
  return shellCache
}

function cookieValue(req: FastifyRequest, name: string): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

async function principalFrom(req: FastifyRequest, deps: AdminUiDeps): Promise<string | null> {
  const raw = req.headers[PORTAL_IDENTITY_HEADER]
  const token = Array.isArray(raw) ? raw[0] : raw
  if (typeof token === 'string' && token && deps.portalIdentitySecret) {
    const identity = await verifyPortalIdentity(token, deps.portalIdentitySecret, Date.now())
    return identity?.p ?? null
  }
  if (deps.portalIdentitySecret) return null
  // No portal identity secret configured (parity #47b): fail closed in
  // production (requirePortalIdentitySecret throws MissingPortalSecretError,
  // translated to 503 by the route handlers) and keep the unsigned admin
  // cookie dev lane with a console warning.
  requirePortalIdentitySecret(deps.portalIdentitySecret, process.env.NODE_ENV)
  return cookieValue(req, 'admin')
}

type AdminPrincipal =
  | { ok: true; principal: string | null }
  | { ok: false }

/**
 * Resolve the admin principal, translating a MissingPortalSecretError (parity
 * #47b: production without portalIdentitySecret) into a 503 so a misconfigured
 * deployment refuses the admin gate rather than trusting the unsigned cookie.
 */
async function resolveAdminPrincipal(req: FastifyRequest, deps: AdminUiDeps, reply: FastifyReply): Promise<AdminPrincipal> {
  try {
    return { ok: true, principal: await principalFrom(req, deps) }
  } catch (e) {
    if (e instanceof MissingPortalSecretError) {
      reply.code(503).send({ error: 'portal_identity_secret_required' })
      return { ok: false }
    }
    throw e
  }
}

function acceptsGzip(req: FastifyRequest): boolean {
  const ae = req.headers['accept-encoding']
  return typeof ae === 'string' && /\bgzip\b/.test(ae)
}

function serveShell(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const shell = loadShell()
  if (req.headers['if-none-match'] === shell.etag) {
    return reply.code(304).header('etag', shell.etag).header('cache-control', 'no-cache').send()
  }
  const gz = acceptsGzip(req)
  reply
    .code(200)
    .header('content-type', 'text/html; charset=utf-8')
    .header('etag', shell.etag)
    .header('cache-control', 'no-cache')
    .header('content-security-policy', shell.csp)
    .header('x-frame-options', 'DENY')
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
  if (gz) reply.header('content-encoding', 'gzip')
  return reply.send(gz ? shell.gzip : shell.html)
}

async function proxyToAdmin(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  principal: string,
  orgId: string,
): Promise<FastifyReply> {
  const innerPath = (req.params as { '*': string })['*'] ?? ''
  const method = req.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  const first = innerPath.split('/')[0] ?? ''
  const allowed = method === 'GET' ? READS.includes(first) : (WRITES.get(first)?.includes(method) ?? false)
  if (!allowed) return reply.code(404).send({ error: 'not_found' })
  const url = `/v1/admin/${innerPath}${new URL(req.url, 'http://localhost').search}`
  const res = await app.inject({
    method,
    url,
    headers: {
      'content-type': 'application/json',
      'x-admin-actor': `${principal}@${orgId}`,
    },
    ...(method === 'GET' || method === 'DELETE' ? {} : { payload: JSON.stringify(req.body ?? {}) }),
  })
  const contentType = res.headers['content-type']
  reply.code(res.statusCode)
  if (typeof contentType === 'string') reply.header('content-type', contentType)
  return reply.send(res.body)
}

export function registerAdminUi(app: FastifyInstance, deps: AdminUiDeps): void {
  app.get(ADMIN_BASE, (req, reply) => serveShell(req, reply))
  app.get(`${ADMIN_BASE}/`, (req, reply) => serveShell(req, reply))
  app.get('/admin/ui/healthz', async () => ({ ok: true }))

  const whoamiHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const outcome = await resolveAdminPrincipal(req, deps, reply)
    if (!outcome.ok) return reply
    const principal = outcome.principal
    if (!principal) return reply.code(401).send({ error: 'signed_out' })
    if (!deps.adminStatus) return reply.code(404).send({ error: 'not_found' })
    const status = await deps.adminStatus(principal)
    return reply.code(200).send({ principal, org: deps.orgId, ...status })
  }
  app.get('/admin/ui/api/me', whoamiHandler)
  app.get('/admin/ui/api/whoami', whoamiHandler)

  app.post('/admin/ui/api/logout', async (_req, reply) => {
    return reply
      .code(200)
      .header('content-type', 'application/json')
      .header('set-cookie', 'admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax')
      .send({ ok: true })
  })

  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/admin/ui/api/*',
    handler: async (req, reply) => {
      const outcome = await resolveAdminPrincipal(req, deps, reply)
      if (!outcome.ok) return reply
      const principal = outcome.principal
      if (!principal) return reply.code(401).send({ error: 'signed_out' })
      return proxyToAdmin(app, req, reply, principal, deps.orgId)
    },
  })

  app.get('/admin/ui/*', (req, reply) => serveShell(req, reply))
}
