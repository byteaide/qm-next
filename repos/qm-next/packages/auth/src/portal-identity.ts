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
