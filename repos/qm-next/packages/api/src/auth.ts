/**
 * Bearer-token authentication for the HTTP surface: verifies a signed token
 * and maps its claims onto the Principal the orchestrator admits turns with.
 * The token is the actor; the API accepts no actor fields in the body.
 */
import type { Principal } from '@qm/types'
import { verifySignedPayload } from './signed-token.ts'

export interface TurnTokenClaims {
  /** Principal id of the caller. */
  p: string
  /** Display name. */
  name?: string
  /** Principal type; defaults to 'internal'. */
  typ?: 'internal' | 'guest'
  /** Expiry as epoch milliseconds; expired tokens are rejected. */
  exp?: number
}

function isClaims(value: unknown): value is TurnTokenClaims {
  return typeof value === 'object' && value !== null && typeof (value as { p?: unknown }).p === 'string'
}

export async function authenticateBearer(header: string | undefined, secrets: string[]): Promise<Principal | null> {
  const auth = await authenticateBearerWithClaims(header, secrets)
  return auth?.principal ?? null
}

export interface AuthenticatedRequest {
  principal: Principal
  /** Raw verified claims (aud, exp, …) for audience-scoped routes. */
  claims: Record<string, unknown>
}

/** Bearer authentication that also exposes the raw claims (route framework). */
export async function authenticateBearerWithClaims(
  header: string | undefined,
  secrets: string[],
): Promise<AuthenticatedRequest | null> {
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  if (!token) return null
  const claims = (await verifySignedPayload(token, secrets)) as TurnTokenClaims | null
  if (!isClaims(claims)) return null
  if (claims.exp !== undefined && (!Number.isFinite(claims.exp) || claims.exp <= Date.now())) return null
  const principal: Principal = { id: claims.p, type: claims.typ ?? 'internal' }
  if (claims.name !== undefined) principal.displayName = claims.name
  return { principal, claims: claims as unknown as Record<string, unknown> }
}
