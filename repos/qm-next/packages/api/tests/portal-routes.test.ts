/**
 * Portal SSO suite (12.0 tranche 3): the /auth/* ladder over a stub OIDC
 * provider, the /admin/ui identity-issuing gate, local dev bypass and the
 * admin-login link consumption with durable single-use jti claims.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import Fastify from 'fastify'
import { exportJWK, SignJWT } from 'jose'
import { registerRouteTable } from '../src/routes/framework.ts'
import { registerAdminUi } from '../src/routes/admin-ui-routes.ts'
import { createMemoryAdminService } from '../src/services/admin-service.ts'
import { createMemoryReplayDedupe, mintSignedPayload } from '@qm/auth'
import { deriveKey, openTmp, seal } from '@qm/portal'
import { registerPortal } from '@qm/portal'

const SECRET = 'api-signing-secret-0123456789abcdef'
const SESSION_SECRET = 'portal-test-session-secret-0123456789'
const IDENTITY_SECRET = 'portal-test-identity-secret-0123456789'
const ORG = 'test'
const PUBLIC_URL = 'http://localhost:8097'

const oidc = {
  authEndpoint: 'https://idp.example.test/authorize',
  tokenEndpoint: 'https://idp.example.test/token',
  userinfoEndpoint: 'https://idp.example.test/userinfo',
  clientId: 'client-1',
  clientSecret: 'shh',
  scopes: 'openid email',
  redirectUri: `${PUBLIC_URL}/auth/callback`,
  issuer: 'https://idp.example.test',
  jwksUri: 'https://idp.example.test/jwks.json',
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const jwk = { ...(await exportJWK(publicKey)), kid: 'key-1', use: 'sig', alg: 'EdDSA' }

interface Idp {
  nonce: string
  email: string
}
const idp: Idp = { nonce: '', email: 'ada@example.test' }

async function signIdToken(nonce: string): Promise<string> {
  return new SignJWT({ nonce })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'key-1' })
    .setIssuer(oidc.issuer)
    .setAudience(oidc.clientId)
    .setSubject('subject-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
}

const stubFetch = (async (url: string | URL | Request) => {
  const u = String(url)
  if (u === oidc.tokenEndpoint) {
    return new Response(JSON.stringify({ ok: true, access_token: 'AT', id_token: await signIdToken(idp.nonce) }), { status: 200 })
  }
  if (u === oidc.userinfoEndpoint) {
    return new Response(JSON.stringify({ ok: true, sub: 'subject-1', email: idp.email, email_verified: true }), { status: 200 })
  }
  if (u === oidc.jwksUri) {
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  throw new Error(`unexpected fetch ${u}`)
}) as typeof fetch

function build(opts: { bypass?: boolean } = {}) {
  const app = Fastify({ logger: false })
  const admin = createMemoryAdminService({ orgId: ORG, seedAdmins: ['ada@example.test'] })
  registerRouteTable(
    app,
    { secrets: [SECRET] },
    [
      { method: 'GET', path: '/v1/admin/whoami', auth: 'either', handle: async (ctx) => ({ actor: ctx.actor?.id ?? null }) },
      { method: 'GET', path: '/v1/admin/metrics', auth: 'either', handle: async () => ({ rows: [] }) },
    ],
  )
  registerAdminUi(app, {
    orgId: ORG,
    adminStatus: (principalId) => admin.adminStatusOf(principalId),
    portalIdentitySecret: IDENTITY_SECRET,
  })
  registerPortal(app, {
    orgId: ORG,
    publicUrl: PUBLIC_URL,
    sessionSecret: SESSION_SECRET,
    identitySecret: IDENTITY_SECRET,
    adminStatusOf: async (principalId) => (await admin.adminStatusOf(principalId)).isAdmin,
    replayDedupe: createMemoryReplayDedupe(),
    ...(opts.bypass
      ? { localAuthBypass: true, devPrincipal: 'ada@example.test' }
      : { oidc, principalRule: { claim: 'email' as const }, fetchImpl: stubFetch }),
  })
  return app
}

function takeCookie(res: { headers: Record<string, unknown> }, name: string): string {
  const raw = res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : [String(raw)]
  for (const entry of list) {
    const pair = entry.split(';')[0] ?? ''
    const eq = pair.indexOf('=')
    if (eq > 0 && pair.slice(0, eq) === name) return pair.slice(eq + 1)
  }
  throw new Error(`cookie ${name} not set`)
}

function sessionCookie(sub: string): string {
  const now = Math.floor(Date.now() / 1000)
  const token = seal({ k: 'session', sub, org: ORG, iat: now, exp: now + 3600 }, deriveKey(SESSION_SECRET, 'portal.session.v1'))
  return `portal_session=${encodeURIComponent(token)}`
}

function adminLoginToken(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000)
  return seal(
    { k: 'admin-login', sub: 'ada@example.test', aud: PUBLIC_URL, iat: now, exp: now + 120, jti: 'A'.repeat(24), ...overrides },
    deriveKey(SESSION_SECRET, 'portal.admin-login.v1'),
  )
}

const HTML = { accept: 'text/html' }
const ORIGIN = { origin: PUBLIC_URL }

test('oidc login redirects to the provider with the PKCE tmp cookie', async () => {
  const app = build()
  const login = await app.inject({ method: 'GET', url: '/auth/login?returnTo=/admin/ui/', headers: HTML })
  assert.equal(login.statusCode, 302)
  const location = new URL(String(login.headers.location))
  assert.equal(location.origin + location.pathname, 'https://idp.example.test/authorize')
  assert.equal(location.searchParams.get('response_type'), 'code')
  assert.equal(location.searchParams.get('client_id'), 'client-1')
  assert.equal(location.searchParams.get('redirect_uri'), `${PUBLIC_URL}/auth/callback`)
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(location.searchParams.get('state'))
  assert.ok(location.searchParams.get('nonce'))
  assert.match(String(login.headers['set-cookie']), /portal_oidc_tmp=/)
  await app.close()
})

test('oidc callback seats the session and the console accepts the issued identity', async () => {
  const app = build()
  const login = await app.inject({ method: 'GET', url: '/auth/login?returnTo=/admin/ui/', headers: HTML })
  const tmpValue = decodeURIComponent(takeCookie(login, 'portal_oidc_tmp'))
  const tmp = openTmp(tmpValue, deriveKey(SESSION_SECRET, 'portal.tmp.v1'), Date.now())
  assert.ok(tmp)
  idp.nonce = tmp!.nonce

  const cb = await app.inject({ method: 'GET', url: `/auth/callback?code=CODE&state=${tmp!.state}`, headers: { cookie: `portal_oidc_tmp=${takeCookie(login, 'portal_oidc_tmp')}` } })
  assert.equal(cb.statusCode, 302)
  assert.equal(cb.headers.location, '/admin/ui/')
  const session = takeCookie(cb, 'portal_session')
  assert.ok(session)

  const me = await app.inject({ method: 'GET', url: '/admin/ui/api/me', headers: { cookie: `portal_session=${session}` } })
  assert.equal(me.statusCode, 200)
  assert.equal(me.json().principal, 'ada@example.test')
  assert.equal(me.json().isAdmin, true)

  const shell = await app.inject({ method: 'GET', url: '/admin/ui', headers: { cookie: `portal_session=${session}`, ...HTML } })
  assert.equal(shell.statusCode, 200)
  assert.match(String(shell.headers['content-type']), /text\/html/)
  await app.close()
})

test('callback replay and state mismatches are refused', async () => {
  const app = build()
  const login = await app.inject({ method: 'GET', url: '/auth/login', headers: HTML })
  const cookie = `portal_oidc_tmp=${takeCookie(login, 'portal_oidc_tmp')}`
  const tmpValue = decodeURIComponent(takeCookie(login, 'portal_oidc_tmp'))
  const tmp = openTmp(tmpValue, deriveKey(SESSION_SECRET, 'portal.tmp.v1'), Date.now())
  idp.nonce = tmp!.nonce

  const first = await app.inject({ method: 'GET', url: `/auth/callback?code=CODE&state=${tmp!.state}`, headers: { cookie } })
  assert.equal(first.statusCode, 302)

  const replay = await app.inject({ method: 'GET', url: `/auth/callback?code=CODE&state=${tmp!.state}`, headers: { cookie } })
  assert.equal(replay.statusCode, 400)
  assert.match(replay.body, /login already used/)

  const wrong = await app.inject({ method: 'GET', url: '/auth/callback?code=CODE&state=WRONG', headers: { cookie } })
  assert.equal(wrong.statusCode, 400)
  assert.match(wrong.body, /invalid login state/)

  const providerError = await app.inject({ method: 'GET', url: '/auth/callback?error=access_denied' })
  assert.equal(providerError.statusCode, 400)
  assert.match(providerError.body, /identity provider returned: access_denied/)
  await app.close()
})

test('the gate ladder: shell redirects anonymous callers, api 401s, non-admins 403, healthz stays open', async () => {
  const app = build()

  const anonShell = await app.inject({ method: 'GET', url: '/admin/ui/scopes/org:test', headers: HTML })
  assert.equal(anonShell.statusCode, 302)
  assert.equal(anonShell.headers.location, `/auth/login?returnTo=${encodeURIComponent('/admin/ui/scopes/org:test')}`)

  const anonApi = await app.inject({ method: 'GET', url: '/admin/ui/api/me' })
  assert.equal(anonApi.statusCode, 401)
  assert.equal(anonApi.json().error, 'sign_in')

  const spoofed = await app.inject({
    method: 'GET',
    url: '/admin/ui/api/me',
    headers: { 'x-portal-identity': await mintSignedPayload({ p: 'ada@example.test', exp: Date.now() + 60_000 }, IDENTITY_SECRET) },
  })
  assert.equal(spoofed.statusCode, 401, 'a signed identity without a portal session never reaches the console')

  const nonAdmin = await app.inject({ method: 'GET', url: '/admin/ui/api/me', headers: { cookie: sessionCookie('mallory@example.test') } })
  assert.equal(nonAdmin.statusCode, 403)
  assert.equal(nonAdmin.json().error, 'forbidden')

  const admin = await app.inject({ method: 'GET', url: '/admin/ui/api/metrics', headers: { cookie: sessionCookie('ada@example.test') } })
  assert.equal(admin.statusCode, 200)

  const health = await app.inject({ method: 'GET', url: '/admin/ui/healthz' })
  assert.equal(health.statusCode, 200)
  await app.close()
})

test('local dev bypass mints a loopback session and logout revokes it', async () => {
  const app = build({ bypass: true })
  const login = await app.inject({ method: 'GET', url: '/auth/login?returnTo=/admin/ui/', headers: HTML })
  assert.equal(login.statusCode, 302)
  assert.equal(login.headers.location, '/admin/ui/')
  const session = takeCookie(login, 'portal_session')

  const me = await app.inject({ method: 'GET', url: '/admin/ui/api/me', headers: { cookie: `portal_session=${session}` } })
  assert.equal(me.statusCode, 200)
  assert.equal(me.json().principal, 'ada@example.test')

  const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: `portal_session=${session}`, ...ORIGIN } })
  assert.equal(out.statusCode, 200)
  const logoutCookies = String(out.headers['set-cookie'])
  assert.match(logoutCookies, /portal_session=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0/)
  assert.match(logoutCookies, /portal_oidc_tmp=/, 'the oidc tmp cookie is cleared too')
  assert.match(logoutCookies, /portal_local_logout=1/, 'bypass mode plants the local-logout marker')

  const crossOrigin = await app.inject({ method: 'POST', url: '/auth/logout', headers: { origin: 'https://evil.test' } })
  assert.equal(crossOrigin.statusCode, 403)
  await app.close()
})

test('admin-login links seat an admin session once; replays and strangers are refused', async () => {
  const app = build()

  const page = await app.inject({ method: 'GET', url: '/auth/admin-login' })
  assert.equal(page.statusCode, 200)
  assert.match(String(page.headers['content-security-policy']), /script-src 'sha256-/)

  const token = adminLoginToken()
  const post = await app.inject({
    method: 'POST',
    url: '/auth/admin-login',
    headers: { ...ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    payload: `token=${encodeURIComponent(token)}`,
  })
  assert.equal(post.statusCode, 303)
  assert.equal(post.headers.location, '/admin/ui/')
  const session = takeCookie(post, 'portal_session')
  const me = await app.inject({ method: 'GET', url: '/admin/ui/api/me', headers: { cookie: `portal_session=${session}` } })
  assert.equal(me.statusCode, 200)
  assert.equal(me.json().principal, 'ada@example.test')

  const replay = await app.inject({
    method: 'POST',
    url: '/auth/admin-login',
    headers: { ...ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    payload: `token=${encodeURIComponent(token)}`,
  })
  assert.equal(replay.statusCode, 400)
  assert.match(replay.body, /already used/)

  const stranger = await app.inject({
    method: 'POST',
    url: '/auth/admin-login',
    headers: { ...ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    payload: `token=${encodeURIComponent(adminLoginToken({ sub: 'mallory@example.test', jti: 'B'.repeat(24) }))}`,
  })
  assert.equal(stranger.statusCode, 403)
  assert.match(stranger.body, /does not have admin access/)

  const crossOrigin = await app.inject({
    method: 'POST',
    url: '/auth/admin-login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `token=${encodeURIComponent(adminLoginToken({ jti: 'C'.repeat(24) }))}`,
  })
  assert.equal(crossOrigin.statusCode, 403)
  await app.close()
})
