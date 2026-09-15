/**
 * Portal SSO routes (qm `plugins/portal/src/index.ts` on the qm-next
 * single-process topology, deviation #49): OIDC sign-in with PKCE + sealed
 * tmp cookie, admin-login links with durable single-use jti claims, logout,
 * the local dev bypass lane and an onRequest gate that admits valid admin
 * sessions onto /admin/ui by minting the short-TTL x-portal-identity header
 * the admin console verifies.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { LRUCache } from 'lru-cache'
import { PORTAL_IDENTITY_HEADER, mintPortalIdentity, type ReplayDedupe } from '@qm/auth'
import { ADMIN_LOGIN_SCRIPT, ADMIN_LOGIN_SCRIPT_HASH, openAdminLogin } from './admin-login.ts'
import {
  clearCookie,
  deriveKey,
  openSession,
  randomToken,
  readCookie,
  safeEqual,
  sanitizeReturnTo,
  seal,
  setCookie,
  openTmp,
  type SessionClaims,
  type TmpClaims,
} from './session.ts'
import { buildAuthorizeUrl, exchangeCode, fetchUserinfo, pkcePair, resolvePrincipal, verifyIdToken, type OidcConfig, type PrincipalRule } from './oidc.ts'

const IDENTITY_TTL_MS = 60_000
const TMP_TTL_S = 600
const LOCAL_LOGOUT_COOKIE = 'portal_local_logout'
const CONSUMED_STATES_MAX = 10_000
const DEFAULT_SESSION_TTL_S = 28_800
const DEV_FALLBACK_SECRET = 'qm-next-dev-portal-secret-change-me!!'

export interface PortalDeps {
  orgId: string
  publicUrl: string
  sessionSecret: string
  identitySecret?: string
  sessionTtlS?: number
  sessionMaxTtlS?: number
  cookieDomain?: string
  appsDomain?: string
  adminStatusOf?: (principalId: string) => Promise<boolean>
  replayDedupe?: ReplayDedupe
  oidc?: OidcConfig
  principalRule?: PrincipalRule
  invited?: (email: string) => Promise<boolean>
  localAuthBypass?: boolean
  /** Principal for the local dev bypass lane (default dev-admin). */
  devPrincipal?: string
  fetchImpl?: typeof fetch
  now?: () => number
}

export interface PortalState {
  deps: PortalDeps
  origin: string
  secureCookies: boolean
  sessionTtlS: number
  sessionMaxTtlS: number
  sessionKey: Buffer
  tmpKey: Buffer
  identitySecret: string
  cookieDomain: string | undefined
  consumedStates: LRUCache<string, number>
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function originOf(raw: string): string {
  try {
    return new URL(raw).origin
  } catch {
    return ''
  }
}

export function isLocalPortalUrl(raw: string): boolean {
  try {
    const hostname = new URL(raw).hostname.toLowerCase()
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    )
  } catch {
    return false
  }
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false
  const normalized = address.toLowerCase()
  return (
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('127.')
  )
}

export function derivedCookieDomain(portalHost: string, appsDomain: string): string | undefined {
  const host = portalHost.toLowerCase()
  return host.includes('.') && appsDomain.toLowerCase().endsWith(`.${host}`) ? host : undefined
}

export function portalBootProblems(deps: PortalDeps): string[] {
  const problems: string[] = []
  if (!deps.sessionSecret || !deps.sessionSecret.trim()) problems.push('portalSessionSecret is required')
  if (deps.localAuthBypass && !isLocalPortalUrl(deps.publicUrl)) {
    problems.push('localAuthBypass requires a localhost, 127.0.0.1, or ::1 publicUrl')
  }
  if (deps.oidc && !deps.localAuthBypass && originOf(deps.oidc.authEndpoint) && originOf(deps.oidc.authEndpoint) === originOf(deps.publicUrl)) {
    problems.push('the OIDC auth endpoint is on the portal own origin — every sign-in would redirect back into the portal forever')
  }
  const ttl = deps.sessionTtlS ?? DEFAULT_SESSION_TTL_S
  const maxTtl = deps.sessionMaxTtlS ?? Math.max(86_400, ttl)
  if (!Number.isFinite(ttl) || ttl <= 0 || !Number.isFinite(maxTtl) || maxTtl < ttl) {
    problems.push('sessionMaxTtlS must be a finite number at least as large as sessionTtlS')
  }
  return problems
}

export function createPortalState(deps: PortalDeps): PortalState {
  const problems = portalBootProblems(deps)
  if (problems.length) throw new Error(`portal refusing to start: ${problems.join('; ')}`)
  if (deps.sessionSecret.trim().length < 32) {
    console.warn('[portal] sessionSecret shorter than 32 chars — dev/test only')
  }
  const sessionTtlS = deps.sessionTtlS ?? DEFAULT_SESSION_TTL_S
  const secret = deps.sessionSecret || DEV_FALLBACK_SECRET
  return {
    deps,
    origin: originOf(deps.publicUrl),
    secureCookies: deps.publicUrl.startsWith('https://'),
    sessionTtlS,
    sessionMaxTtlS: deps.sessionMaxTtlS ?? Math.max(86_400, sessionTtlS),
    sessionKey: deriveKey(secret, 'portal.session.v1'),
    tmpKey: deriveKey(secret, 'portal.tmp.v1'),
    identitySecret: deps.identitySecret ?? secret,
    cookieDomain: deps.cookieDomain ?? (deps.appsDomain ? derivedCookieDomain(hostOf(deps.publicUrl), deps.appsDomain) : undefined),
    consumedStates: new LRUCache<string, number>({ max: CONSUMED_STATES_MAX, ttl: 2 * TMP_TTL_S * 1000 }),
  }
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

const CARD_STYLE = `<style>
  :root{
    --bg:#ffffff; --surface:#ffffff; --text:#0a0a0a; --muted:#737373;
    --border:#e5e5e5; --secondary:#f5f5f5; --warn:#b42318; --warn-bg:#fdeceb;
    --shadow:0 1px 3px rgba(0,0,0,.05), 0 4px 12px rgba(0,0,0,.05);
    --radius-md:10px; --radius-lg:16px;
  }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#0a0a0a; --surface:#171717; --text:#fafafa; --muted:#a3a3a3;
      --border:#2a2a2a; --secondary:#262626; --warn:#ff8a80; --warn-bg:#2a1a1a;
      --shadow:0 1px 3px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.4); }
  }
  *{ box-sizing:border-box; }
  html,body{ height:100%; }
  body{
    margin:0; background:var(--bg); color:var(--text); display:flex; min-height:100%;
    font:14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  main{ margin:auto; padding:32px 20px; width:100%; display:grid; place-items:center; }
  .card{
    width:100%; max-width:420px; background:var(--surface); border:1px solid var(--border);
    border-radius:var(--radius-lg); box-shadow:var(--shadow); padding:34px 32px 30px; text-align:center;
  }
  .card.wide{ max-width:440px; }
  .icon{ width:52px; height:52px; margin:0 auto 18px; border-radius:var(--radius-md); background:var(--secondary);
    display:grid; place-items:center; }
  .icon svg{ width:26px; height:26px; stroke:var(--text); fill:none; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  .icon.warn{ background:var(--warn-bg); }
  .icon.warn svg{ stroke:var(--warn); stroke-width:2; }
  h1{ font-size:20px; font-weight:600; letter-spacing:0; margin:0 0 8px; }
  .msg{ color:var(--muted); margin:0 auto 8px; max-width:40ch; font-size:14px; }
  .reason{ margin:16px auto 26px; font-size:13px; color:var(--text);
    background:var(--warn-bg); border:1px solid var(--border); border-radius:var(--radius-md); padding:11px 14px;
    text-align:left; word-break:break-word; }
  .reason strong{ display:block; color:var(--warn); font-size:11px; text-transform:uppercase; letter-spacing:.04em; margin-bottom:3px; }
  .note{ margin:18px auto 26px; font-size:13px; color:var(--text); background:var(--secondary);
    border:1px solid var(--border); border-radius:var(--radius-md); padding:12px 14px; text-align:left; }
  .note .who{ display:flex; align-items:center; gap:8px; color:var(--muted); }
  .note .who b{ color:var(--text); }
  .note p{ margin:8px 0 0; color:var(--muted); }
  .actions{ display:grid; gap:10px; }
  .btn{ display:flex; align-items:center; justify-content:center; min-height:44px; padding:0 18px;
    text-decoration:none; font-weight:600; font-size:14px; border-radius:var(--radius-md); cursor:pointer;
    transition:opacity .12s ease, background .12s ease, color .12s ease; }
  .btn.primary{ background:var(--text); color:var(--bg); border:1px solid var(--text); }
  .btn.primary:hover{ opacity:.9; }
  .btn.ghost{ background:none; color:var(--muted); border:1px solid var(--border); }
  .btn.ghost:hover{ background:var(--secondary); color:var(--text); }
  .btn:focus-visible{ outline:2px solid color-mix(in srgb, var(--text) 35%, transparent); outline-offset:2px; }
  .help{ color:var(--muted); font-size:12.5px; margin:20px 0 0; }
  @media (prefers-reduced-motion:reduce){ *{ transition:none !important; } }
</style>`

const ALERT_ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/></svg>`
const LOCK_ICON = `<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`

function cardPage(o: { title: string; heading: string; msg: string; icon: string; warn?: boolean; wide?: boolean; extra?: string; actions: string; help: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.title)} · Portal</title>
${CARD_STYLE}
</head>
<body>
  <main>
    <section class="card${o.wide ? ' wide' : ''}" aria-labelledby="t">
      <div class="icon${o.warn ? ' warn' : ''}" aria-hidden="true">
        ${o.icon}
      </div>
      <h1 id="t">${escapeHtml(o.heading)}</h1>
      <p class="msg">${escapeHtml(o.msg)}</p>
      ${o.extra ?? ''}
      <div class="actions">
        ${o.actions}
      </div>
      <p class="help">${escapeHtml(o.help)}</p>
    </section>
  </main>
</body>
</html>`
}

export function signInErrorHtml(detail: string): string {
  return cardPage({
    title: 'Sign-in failed',
    heading: "We couldn't sign you in",
    msg: "Your sign-in didn't complete. This is usually temporary — trying again resolves most cases.",
    icon: ALERT_ICON,
    warn: true,
    extra: `<p class="reason"><strong>Details</strong>${escapeHtml(detail)}</p>`,
    actions: `<a class="btn primary" href="/auth/login">Try signing in again</a>
        <a class="btn ghost" href="/">Back to start</a>`,
    help: "Still stuck? Make sure you're a member of the approved workspace, then contact your admin.",
  })
}

export function nonAdminDeniedHtml(o: { sub: string; org: string }): string {
  return cardPage({
    title: 'No admin access',
    heading: "You don't have admin access",
    msg: "The Admin area is limited to governance admins. Your account is signed in and verified — it just isn't granted admin rights.",
    icon: LOCK_ICON,
    wide: true,
    extra: `<div class="note">
        <span class="who">Signed in as <b>${escapeHtml(o.sub)}</b> &middot; ${escapeHtml(o.org)}</span>
        <p>Admin rights come from your organization's admin grants. If you need access, ask an existing admin to grant it.</p>
      </div>`,
    actions: `<a class="btn primary" href="/">Back to your surfaces</a>
        <a class="btn ghost" href="/admin/ui/">Try again</a>`,
    help: 'You can keep using every surface available to your account.',
  })
}

function wantsHtml(req: FastifyRequest): boolean {
  const accept = req.headers.accept
  return typeof accept === 'string' && accept.includes('text/html')
}

function sameOriginRequest(req: FastifyRequest, origin: string): boolean {
  const header = req.headers.origin
  const originMatches =
    typeof header === 'string' &&
    (() => {
      try {
        return new URL(header).origin === origin
      } catch {
        return false
      }
    })()
  const site = req.headers['sec-fetch-site']
  if (typeof site !== 'string') return originMatches
  return site === 'same-origin' && (originMatches || header === undefined || header === 'null')
}

function consumeState(state: PortalState, value: string): boolean {
  const now = state.deps.now?.() ?? Date.now()
  const existing = state.consumedStates.get(value)
  if (existing !== undefined && existing > now) return false
  state.consumedStates.set(value, now + TMP_TTL_S * 1000)
  return true
}

function sessionCookieSet(state: PortalState, value: string): string[] {
  const set = setCookie('portal_session', value, {
    path: '/',
    maxAge: state.sessionTtlS,
    secure: state.secureCookies,
    ...(state.cookieDomain ? { domain: state.cookieDomain } : {}),
  })
  return state.cookieDomain ? [set, clearCookie('portal_session', '/', state.secureCookies)] : [set]
}

function setSessionCookies(reply: FastifyReply, headers: string[]): void {
  reply.header('set-cookie', headers)
}

function localDevSession(state: PortalState, req: FastifyRequest, nowMs = Date.now(), ignoreLogout = false): SessionClaims | null {
  if (!state.deps.localAuthBypass) return null
  if (!isLoopbackAddress(req.ip)) return null
  if (!ignoreLogout && readCookie(req.headers.cookie, LOCAL_LOGOUT_COOKIE) === '1') return null
  const now = Math.floor(nowMs / 1000)
  return { k: 'session', sub: state.deps.devPrincipal ?? 'dev-admin', org: state.deps.orgId, iat: now, exp: now + state.sessionTtlS }
}

/** The request's portal session (sealed cookie or the local dev bypass lane). */
export function currentSession(state: PortalState, req: FastifyRequest): SessionClaims | null {
  return (
    openSession(readCookie(req.headers.cookie, 'portal_session'), state.sessionKey, state.deps.now?.() ?? Date.now(), state.deps.orgId, state.sessionMaxTtlS) ??
    localDevSession(state, req)
  )
}

/** Re-seal the session cookie when it passed half its TTL; null when fresh/absent. */
export function renewSessionCookies(state: PortalState, req: FastifyRequest): string[] | null {
  const session = openSession(
    readCookie(req.headers.cookie, 'portal_session'),
    state.sessionKey,
    state.deps.now?.() ?? Date.now(),
    state.deps.orgId,
    state.sessionMaxTtlS,
  )
  if (!session) return null
  const now = Math.floor((state.deps.now?.() ?? Date.now()) / 1000)
  if (now - session.iat < Math.floor(state.sessionTtlS / 2)) return null
  const authenticatedAt = session.auth ?? session.iat
  const renewed: SessionClaims = {
    ...session,
    auth: authenticatedAt,
    iat: now,
    exp: Math.min(now + state.sessionTtlS, authenticatedAt + state.sessionMaxTtlS),
  }
  return sessionCookieSet(state, seal(renewed, state.sessionKey))
}

function setAuthenticatedSession(state: PortalState, reply: FastifyReply, sub: string, name = ''): void {
  const now = Math.floor((state.deps.now?.() ?? Date.now()) / 1000)
  const session: SessionClaims = {
    k: 'session',
    sub,
    org: state.deps.orgId,
    auth: now,
    iat: now,
    exp: now + state.sessionTtlS,
    ...(name ? { name } : {}),
  }
  setSessionCookies(reply, [
    ...sessionCookieSet(state, seal(session, state.sessionKey)),
    clearCookie('portal_oidc_tmp', '/auth', state.secureCookies),
    clearCookie('portal_impersonate', '/', state.secureCookies),
  ])
}

export function registerPortal(app: FastifyInstance, deps: PortalDeps): void {
  const state = createPortalState(deps)
  const fetchImpl = deps.fetchImpl ?? fetch
  const nowMs = (): number => deps.now?.() ?? Date.now()

  const gateAdminUi = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const url = (req.raw.url ?? '').split('?')[0] ?? ''
    if (url !== '/admin/ui' && !url.startsWith('/admin/ui/')) return
    if (url === '/admin/ui/healthz') return
    const session = currentSession(state, req)
    if (!session) {
      if (req.method === 'GET' && wantsHtml(req)) {
        return reply
          .code(302)
          .header('location', `/auth/login?returnTo=${encodeURIComponent(req.raw.url ?? '/admin/ui')}`)
          .header('cache-control', 'no-store')
          .send()
      }
      return reply.code(401).send({ error: 'sign_in' })
    }
    const renewed = renewSessionCookies(state, req)
    if (renewed) setSessionCookies(reply, renewed)
    if (session.anon) return reply.code(403).send({ error: 'forbidden', message: 'admin access required' })
    if (!deps.adminStatusOf) return reply.code(404).send({ error: 'not_found' })
    if (!(await deps.adminStatusOf(session.sub))) {
      if (wantsHtml(req)) {
        return reply.code(403).header('content-type', 'text/html; charset=utf-8').send(nonAdminDeniedHtml({ sub: session.sub, org: session.org }))
      }
      return reply.code(403).send({ error: 'forbidden', message: 'admin access required' })
    }
    req.headers[PORTAL_IDENTITY_HEADER] = mintPortalIdentity(
      {
        p: session.sub,
        ...(session.name ? { n: session.name } : {}),
        exp: nowMs() + IDENTITY_TTL_MS,
      },
      state.identitySecret,
    )
  }
  app.addHook('onRequest', gateAdminUi)

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body)
  })

  app.get('/auth/login', (req, reply) => {
    const returnTo = sanitizeReturnTo((req.query as Record<string, string | undefined>).returnTo ?? null, deps.publicUrl, deps.appsDomain)
    const localSession = localDevSession(state, req, nowMs(), true)
    if (localSession) {
      setSessionCookies(reply, [
        ...sessionCookieSet(state, seal(localSession, state.sessionKey)),
        clearCookie('portal_oidc_tmp', '/auth', state.secureCookies),
        clearCookie(LOCAL_LOGOUT_COOKIE, '/', state.secureCookies),
      ])
      return reply.code(302).header('location', returnTo).header('cache-control', 'no-store').send()
    }
    if (!deps.oidc) return reply.code(503).send({ error: 'not_configured' })
    const stateToken = randomToken()
    const nonce = randomToken()
    const { verifier, challenge } = pkcePair()
    const now = Math.floor(nowMs() / 1000)
    const tmp: TmpClaims = { k: 'tmp', state: stateToken, nonce, pkceVerifier: verifier, returnTo, iat: now, exp: now + TMP_TTL_S }
    setSessionCookies(reply, [
      setCookie('portal_oidc_tmp', seal(tmp, state.tmpKey), { path: '/auth', maxAge: TMP_TTL_S, secure: state.secureCookies }),
    ])
    return reply.code(302).header('location', buildAuthorizeUrl(deps.oidc, { state: stateToken, nonce, challenge })).header('cache-control', 'no-store').send()
  })

  app.get('/auth/callback', async (req, reply) => {
    if (!deps.oidc) return reply.code(503).send({ error: 'not_configured' })
    const url = new URL(req.raw.url ?? '/', 'http://portal.local')
    const fail = (detail: string): FastifyReply => {
      setSessionCookies(reply, [clearCookie('portal_oidc_tmp', '/auth', state.secureCookies)])
      return reply.code(400).header('content-type', 'text/html; charset=utf-8').send(signInErrorHtml(detail))
    }
    if (url.searchParams.get('error')) return fail(`identity provider returned: ${url.searchParams.get('error') ?? ''}`)
    const code = url.searchParams.get('code') ?? ''
    const stateParam = url.searchParams.get('state') ?? ''

    const tmp = openTmp(readCookie(req.headers.cookie, 'portal_oidc_tmp'), state.tmpKey, nowMs())
    if (!tmp) return fail('login session expired — please try again')
    if (!code || !stateParam || !safeEqual(stateParam, tmp.state)) return fail('invalid login state')
    if (!consumeState(state, tmp.state)) return fail('login already used — please try again')

    let sub: string
    let name = ''
    try {
      const { accessToken, idToken } = await exchangeCode(deps.oidc, { code, codeVerifier: tmp.pkceVerifier }, fetchImpl)
      const claims = await verifyIdToken(deps.oidc, idToken, tmp.nonce, fetchImpl)
      if (deps.oidc.expectedTeamId) {
        const team = claims['https://slack.com/team_id']
        if (team !== deps.oidc.expectedTeamId) throw new Error('workspace not permitted')
      }
      const info = await fetchUserinfo(deps.oidc, accessToken, fetchImpl)
      const infoSub = typeof info.sub === 'string' ? info.sub : ''
      if (!infoSub) throw new Error('userinfo missing sub')
      if (typeof claims.sub === 'string' && claims.sub !== infoSub) throw new Error('subject mismatch')
      sub = await resolvePrincipal(deps.principalRule ?? { claim: 'email' }, { sub: infoSub, claims, userinfo: info }, deps.invited)
      const rawName = info.name ?? claims.name
      if (typeof rawName === 'string') name = rawName.trim().slice(0, 200)
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'sign-in failed')
    }

    setAuthenticatedSession(state, reply, sub, name)
    return reply.code(302).header('location', sanitizeReturnTo(tmp.returnTo, deps.publicUrl, deps.appsDomain)).header('cache-control', 'no-store').send()
  })

  app.route({
    method: ['GET', 'POST'],
    url: '/auth/admin-login',
    bodyLimit: 8192,
    handler: async (req, reply) => {
      if (deps.sessionSecret.trim().length < 32) return reply.code(503).send({ error: 'not_configured' })
      if (req.method === 'GET') {
        return reply
          .code(200)
          .header('content-type', 'text/html; charset=utf-8')
          .header('content-security-policy', `${PAGE_CSP}; script-src '${ADMIN_LOGIN_SCRIPT_HASH}'`)
          .header('x-content-type-options', 'nosniff')
          .header('cache-control', 'no-store')
          .send(
            cardPage({
              title: 'Admin sign-in',
              heading: 'Sign in as an administrator',
              msg: 'Only continue if you generated this link for your own admin account.',
              icon: LOCK_ICON,
              extra: '<p id="admin-email"></p><noscript>JavaScript is required to open this login link.</noscript>',
              actions: `<form method="post" action="/auth/admin-login"><input id="admin-token" name="token" type="hidden"><button id="admin-confirm" class="btn primary" style="width:100%" type="submit" disabled>Sign in</button></form><script>${ADMIN_LOGIN_SCRIPT}</script>`,
              help: 'This link expires after five minutes and can be used once. Generate another with qm admin-login.',
            }),
          )
      }
      if (!sameOriginRequest(req, state.origin)) return reply.code(403).send({ error: 'forbidden' })
      const token = typeof req.body === 'string' ? (new URLSearchParams(req.body).get('token') ?? '') : ''
      const failPage = (): FastifyReply =>
        reply.code(400).header('content-type', 'text/html; charset=utf-8').send(signInErrorHtml('This admin link is invalid, expired, or already used. Generate a new link with qm admin-login.'))
      const claims = openAdminLogin(token, deps.sessionSecret, state.origin, nowMs())
      if (!claims) return failPage()
      const allowed = deps.adminStatusOf ? await deps.adminStatusOf(claims.email) : null
      if (allowed === null || allowed === undefined) {
        return reply.code(503).header('content-type', 'text/html; charset=utf-8').send(signInErrorHtml('Admin access could not be checked. Please try again.'))
      }
      if (!allowed) return reply.code(403).header('content-type', 'text/html; charset=utf-8').send(signInErrorHtml('This account does not have admin access.'))
      if (deps.replayDedupe && !(await deps.replayDedupe.claim(`portal-admin-login:${claims.jti}`, claims.expiresAtMs))) return failPage()
      setAuthenticatedSession(state, reply, claims.email)
      return reply.code(303).header('location', '/admin/ui/').header('cache-control', 'no-store').send()
    },
  })

  app.post('/auth/logout', (req, reply) => {
    if (!sameOriginRequest(req, state.origin)) return reply.code(403).send({ error: 'forbidden' })
    setSessionCookies(reply, [
      clearCookie('portal_session', '/', state.secureCookies, state.cookieDomain),
      ...(state.cookieDomain ? [clearCookie('portal_session', '/', state.secureCookies)] : []),
      clearCookie('portal_oidc_tmp', '/auth', state.secureCookies),
      ...(state.deps.localAuthBypass && isLoopbackAddress(req.ip)
        ? [setCookie(LOCAL_LOGOUT_COOKIE, '1', { path: '/', maxAge: state.sessionTtlS, secure: state.secureCookies })]
        : []),
    ])
    if (wantsHtml(req)) return reply.code(303).header('location', '/').header('cache-control', 'no-store').send()
    return reply.code(200).send({ ok: true })
  })
}
