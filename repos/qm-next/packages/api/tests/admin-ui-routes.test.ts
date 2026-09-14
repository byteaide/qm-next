/**
 * Admin console suite (12.0 tranche 2a): shell serving with CSP/etag/gzip,
 * the identity ladder (dev cookie vs portal identity), and the /api/*
 * proxy onto the in-process /v1/admin surface.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import { registerRouteTable } from '../src/routes/framework.ts'
import { registerAdminUi } from '../src/routes/admin-ui-routes.ts'
import { createMemoryAdminService } from '../src/services/admin-service.ts'
import { mintSignedPayload } from '@qm/auth'

const SECRET = 'admin-ui-test-secret-0123456789abcdef'
const PORTAL_SECRET = 'portal-identity-secret-0123456789abcdef'
const ORG = 'test'

interface Setup {
  adminUi: boolean
  withAdmin?: boolean
  portalIdentitySecret?: string
}

function build(setup: Setup) {
  const app = Fastify({ logger: false })
  const admin = createMemoryAdminService({ orgId: ORG, seedAdmins: ['person:ada'] })
  registerRouteTable(
    app,
    { secrets: [SECRET] },
    [
      { method: 'GET', path: '/v1/admin/whoami', auth: 'either', handle: async (ctx) => ({ actor: ctx.actor?.id ?? null }) },
      {
        method: 'GET',
        path: '/v1/admin/metrics',
        auth: 'either',
        handle: async (ctx) => {
          const adminActor = ctx.req.headers['x-admin-actor']
          return { actor: Array.isArray(adminActor) ? adminActor[0] : adminActor, scope: ctx.query.scope ?? null }
        },
      },
    ],
  )
  if (setup.adminUi) {
    registerAdminUi(app, {
      orgId: ORG,
      adminStatus: (principalId) => admin.adminStatusOf(principalId),
      ...(setup.portalIdentitySecret ? { portalIdentitySecret: setup.portalIdentitySecret } : {}),
    })
  }
  return app
}

function cookie(value: string): { cookie: string } {
  return { cookie: `admin=${encodeURIComponent(value)}` }
}

test('shell serves with CSP, etag 304 and gzip', async () => {
  const app = build({ adminUi: true })
  const first = await app.inject({ method: 'GET', url: '/admin/ui' })
  assert.equal(first.statusCode, 200)
  assert.match(first.headers['content-type'] as string, /text\/html/)
  assert.match(first.headers['content-security-policy'] as string, /script-src 'sha256-/)
  assert.match(first.headers['etag'] as string, /^"/)
  const etag = first.headers['etag'] as string
  const cached = await app.inject({ method: 'GET', url: '/admin/ui', headers: { 'if-none-match': etag } })
  assert.equal(cached.statusCode, 304)
  const gz = await app.inject({ method: 'GET', url: '/admin/ui', headers: { 'accept-encoding': 'gzip' } })
  assert.equal(gz.headers['content-encoding'], 'gzip')
  const fallback = await app.inject({ method: 'GET', url: '/admin/ui/scopes/org:test' })
  assert.equal(fallback.statusCode, 200)
  await app.close()
})

test('identity ladder: dev cookie without a portal secret, portal header with one', async () => {
  const dev = build({ adminUi: true })
  const anon = await dev.inject({ method: 'GET', url: '/admin/ui/api/me' })
  assert.equal(anon.statusCode, 401)
  assert.equal(anon.json().error, 'signed_out')
  const me = await dev.inject({ method: 'GET', url: '/admin/ui/api/me', headers: cookie('person:ada') })
  assert.equal(me.statusCode, 200)
  assert.equal(me.json().principal, 'person:ada')
  assert.equal(me.json().isAdmin, true)
  await dev.close()

  const hard = build({ adminUi: true, portalIdentitySecret: PORTAL_SECRET })
  const cookieCaller = await hard.inject({ method: 'GET', url: '/admin/ui/api/me', headers: cookie('person:ada') })
  assert.equal(cookieCaller.statusCode, 401, 'cookies are not trusted once a portal secret exists')
  const identity = await mintSignedPayload({ p: 'person:ada', exp: Date.now() + 60_000 }, PORTAL_SECRET)
  const portalCaller = await hard.inject({
    method: 'GET',
    url: '/admin/ui/api/me',
    headers: { 'x-portal-identity': identity },
  })
  assert.equal(portalCaller.statusCode, 200)
  assert.equal(portalCaller.json().principal, 'person:ada')
  await hard.close()
})

test('proxy maps /api/* onto /v1/admin/* with x-admin-actor and the route ladder', async () => {
  const app = build({ adminUi: true })
  const headers = cookie('person:ada')

  const read = await app.inject({ method: 'GET', url: '/admin/ui/api/metrics?scope=org:test', headers })
  assert.equal(read.statusCode, 200)
  assert.equal(read.json().actor, 'person:ada@test')
  assert.equal(read.json().scope, 'org:test')

  const whoami = await app.inject({ method: 'GET', url: '/admin/ui/api/whoami', headers })
  assert.equal(whoami.statusCode, 200)
  assert.equal(whoami.json().principal, 'person:ada')
  assert.equal(whoami.json().org, ORG)

  const unknown = await app.inject({ method: 'GET', url: '/admin/ui/api/not-a-resource', headers })
  assert.equal(unknown.statusCode, 404)

  const writeDenied = await app.inject({ method: 'DELETE', url: '/admin/ui/api/metrics/x', headers })
  assert.equal(writeDenied.statusCode, 404, 'writes are limited to the WRITES ladder')

  const anon = await app.inject({ method: 'GET', url: '/admin/ui/api/metrics' })
  assert.equal(anon.statusCode, 401)
  await app.close()
})

test('logout clears the cookie; healthz stays open', async () => {
  const app = build({ adminUi: true })
  const health = await app.inject({ method: 'GET', url: '/admin/ui/healthz' })
  assert.equal(health.statusCode, 200)
  const out = await app.inject({ method: 'POST', url: '/admin/ui/api/logout' })
  assert.equal(out.statusCode, 200)
  assert.match(String(out.headers['set-cookie']), /Max-Age=0/)
  await app.close()
})
