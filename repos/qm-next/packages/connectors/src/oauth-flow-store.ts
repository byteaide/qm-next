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
  /** Phase 6 (ADR-0009): consent link this flow was minted for. */
  linkId?: string
  /** Phase 6: mock/consent-issued authorization code (redeemConsent). */
  code?: string
  /** Phase 6: provider host cached on the flow for exchange + sealing. */
  host?: string
  issuedAt: number
  nonce: string
}

export interface OAuthFlowStore {
  start(state: Omit<OAuthFlow, 'issuedAt' | 'nonce'>, now?: number): Promise<string>
  finish(flowId: string, now?: number): Promise<OAuthFlow | null>
  /** Phase 6: non-destructive read (TTL-aware) for restart-safe checks. */
  peek(flowId: string, now?: number): Promise<OAuthFlow | null>
  /** Phase 6: attach the issued authorization code to a pending flow. */
  attachCode(flowId: string, code: string): Promise<boolean>
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
    async peek(flowId, now) {
      const rec = await backing.get(flowId).catch(() => null)
      if (!rec) return null
      if ((now ?? clock()) - rec.issuedAt > ttl) return null
      return rec
    },
    async attachCode(flowId, code) {
      if (!backing.update) return false
      const next = await backing.update(flowId, (rec) => ({ ...rec, code }))
      return next != null
    },
  }
}