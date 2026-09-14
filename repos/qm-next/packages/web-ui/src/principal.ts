/**
 * Web session identity: a signed portal-identity header when the portal SSO
 * fronts the web runtime (production mode), otherwise the `webuiuser` dev
 * cookie on the loopback bind. An explicit principal allow-list narrows both
 * lanes (qm WEB_UI_PRINCIPALS). Verification is async, so the server loads
 * the identity once per request (`identifyRequest`) and the route handlers
 * read the stashed outcome synchronously (`identityOf`).
 */
import { verifyPortalIdentity, PORTAL_IDENTITY_HEADER } from '@qm/auth'
import type { FastifyRequest } from 'fastify'

export const COOKIE_NAME = 'webuiuser'

export interface WebIdentity {
  user: string
  name: string | null
  impersonator: string | null
}

export type AuthDenial = 'unauthenticated' | 'not_allowed'

export type AuthOutcome = WebIdentity | AuthDenial

export interface AuthOptions {
  /** Portal identity verification secret; the header lane activates only with it. */
  portalIdentitySecret?: string
  /** Allowed principals; empty means every identified principal passes. */
  principals?: readonly string[]
}

const IDENTITY_STASH = Symbol('webui-identity')

function firstHeader(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && raw ? raw : null
}

function cookieValue(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    const value = decodeURIComponent(part.slice(eq + 1).trim())
    return value || null
  }
  return null
}

/** Resolve and stash the request identity (server onRequest hook). */
export async function identifyRequest(req: FastifyRequest, opts: AuthOptions): Promise<AuthOutcome> {
  const outcome = await resolveIdentityOutcome(req, opts)
  ;(req as unknown as Record<symbol, AuthOutcome>)[IDENTITY_STASH] = outcome
  return outcome
}

/** The stashed outcome (identifyRequest must have run for this request). */
export function identityOf(req: FastifyRequest): AuthOutcome | undefined {
  return (req as unknown as Record<symbol, AuthOutcome | undefined>)[IDENTITY_STASH]
}

async function resolveIdentityOutcome(req: FastifyRequest, opts: AuthOptions): Promise<AuthOutcome> {
  let identity: WebIdentity | null = null
  const token = firstHeader(req.headers[PORTAL_IDENTITY_HEADER])
  const claims = token && opts.portalIdentitySecret ? await verifyPortalIdentity(token, opts.portalIdentitySecret, Date.now()) : null
  if (claims) {
    identity = { user: claims.p, name: claims.n ?? null, impersonator: claims.imp ?? null }
  } else {
    const user = cookieValue(req, COOKIE_NAME)
    if (user) identity = { user, name: cookieValue(req, 'webuiuser_name'), impersonator: cookieValue(req, 'webui_impersonator') }
  }
  if (!identity) return 'unauthenticated'
  if (opts.principals?.length && !opts.principals.includes(identity.user)) return 'not_allowed'
  return identity
}

export function sessionCookie(user: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(user)}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Lax`
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
}
