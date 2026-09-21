/**
 * Portal identity (qm `src/auth/portal-identity.ts`): the signed identity
 * header the portal SSO proxy forwards to downstream surfaces. Minting uses
 * qm chassis' legacy `payload.hmac` format; verification accepts it through
 * the signed-token legacy lane so qm-era issuers keep working.
 */
import { createHmac } from 'node:crypto'
import { verifySignedPayload } from './signed-token.ts'

export interface PortalIdentity {
  p: string
  n?: string
  imp?: string
  exp: number
}

export const PORTAL_IDENTITY_HEADER = 'x-portal-identity'

export function mintPortalIdentity(claims: PortalIdentity, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  const digest = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${digest}`
}

export async function verifyPortalIdentity(token: string, secret: string, nowMs: number): Promise<PortalIdentity | null> {
  const claims = (await verifySignedPayload(token, secret)) as PortalIdentity | null
  if (!claims || typeof claims.p !== 'string' || !claims.p || typeof claims.exp !== 'number') return null
  if (nowMs > claims.exp) return null
  return claims
}

/**
 * Dev-only unsigned-identity lane marker (qm `ALLOW_UNSIGNED_TEST_IDENTITY`).
 * When the portal identity secret is unset outside production, the admin gate
 * falls back to the unsigned `admin`/`webuiuser` cookie with a console warning
 * — mirroring qm's local-dev lane. Production must never reach this path.
 */
export const ALLOW_UNSIGNED_TEST_IDENTITY = 'qm:allow-unsigned-test-identity'

/**
 * Thrown when a portal identity secret is required but not configured in
 * production (parity #47b). Callers translate this into a 503 so a
 * misconfigured deployment refuses the admin gate instead of trusting the
 * unsigned dev cookie.
 */
export class MissingPortalSecretError extends Error {
  constructor() {
    super('portalIdentitySecret is required in production mode (parity #47b)')
    this.name = 'MissingPortalSecretError'
  }
}

/**
 * Enforce that a portal identity secret is configured in production. Returns
 * true when the caller may proceed. In production without a secret it throws
 * MissingPortalSecretError (fail-closed). In dev without a secret it emits a
 * console warning and returns true so the unsigned-cookie dev lane stays
 * usable (qm ALLOW_UNSIGNED_TEST_IDENTITY).
 */
export function requirePortalIdentitySecret(secret: string | undefined, env: string | undefined): boolean {
  if (secret) return true
  const nodeEnv = env || process.env.NODE_ENV || 'development'
  if (nodeEnv === 'production') throw new MissingPortalSecretError()
  console.warn(`[portal-identity] ${ALLOW_UNSIGNED_TEST_IDENTITY} lane active — portalIdentitySecret unset in ${nodeEnv}; set it before production.`)
  return true
}
