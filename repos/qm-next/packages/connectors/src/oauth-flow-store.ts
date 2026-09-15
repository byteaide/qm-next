/**
 * OAuth flow store (qm `src/connectors/oauth-flow-store.ts`): the
 * `state` parameter has to fit under the provider cap (X rejects
 * anything > 500 chars), so the round-trip context lives here under
 * a 43-char opaque id and the PKCE verifier never travels through
 * the browser.
 */
import { randomBytes } from 'node:crypto'
import type { DurableMap } from '@qm/store'

export interface OAuthFlow {
  provider: string
  clientId: string
  principalId: string
  scopeId: string
  redirectUri: string
  pkceVerifier: string
  redirectAllowlist?: readonly string[]
  hostedDomain?: string
  consentMode?: 'none' | 'consent'
  scopes?: readonly string[]
  audienceScopeId?: string
  returnTo?: string
  issuedAt: number
  nonce: string
}

export interface OAuthFlowStore {
  start(state: Omit<OAuthFlow, 'issuedAt' | 'nonce'>, now?: number): Promise<string>
  finish(flowId: string, now?: number): Promise<OAuthFlow | null>
}

const OAUTH_FLOW_TTL_MS = 10 * 60_000

export function createOAuthFlowStore(
  backing: DurableMap<OAuthFlow>,
  opts: { ttlMs?: number; now?: () => number } = {},
): OAuthFlowStore {
  const ttl = opts.ttlMs ?? OAUTH_FLOW_TTL_MS
  const clock = opts.now ?? (() => Date.now())
  return {
    async start(state, now) {
      const flowId = randomBytes(32).toString('base64url')
      await backing.put(flowId, { ...state, issuedAt: now ?? clock(), nonce: flowId })
      return flowId
    },
    async finish(flowId, now) {
      const rec = await backing.take(flowId).catch(() => null)
      if (!rec) return null
      if ((now ?? clock()) - rec.issuedAt > ttl) return null
      return rec
    },
  }
}