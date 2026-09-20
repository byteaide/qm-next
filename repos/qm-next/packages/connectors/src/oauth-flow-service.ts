/**
 * Connector-owned OAuth lifecycle (plan §Phase 6 slices 1–4, ADR-0009,
 * ADR-0016, ADR-0017): flow state, consent links, provider exchange,
 * and token persistence live here — behind durable stores, so flows
 * are restart-safe and multi-instance-safe. HTTP routes shrink to
 * adapters: validate callback input, normalize the provider payload,
 * invoke a Connector operation, return/redact the result. Token
 * plaintext exists only inside `handleCallback`'s exchange window and
 * is sealed into the vault before the operation returns.
 */
import { randomUUID } from 'node:crypto'
import { bumpOAuthFlow, bumpOAuthRedactionHit, redactSecrets, type RunMetricsRegistry } from '@qm/runs'
import type { OAuthFlow, OAuthFlowStore } from './oauth-flow-store.ts'
import type { AccountType, ConsentLinkStore } from './consent-link.ts'
import { CONNECTOR_ACCOUNT_TYPES, type ConnectorAccountType, type ConnectorTokenVault } from './token-vault.ts'

/** Deployment-configured provider registry entry (Phase 6 moves the
 *  registry out of route defaults — an empty list ships a deployment
 *  with no OAuth providers). */
export interface OAuthProviderSpec {
  id: string
  name: string
  host: string
  scopes: readonly string[]
  clientId?: string
  clientSecret?: string
  /** Absolute authorize endpoint; defaults to `https://host/oauth/authorize`. */
  authorizeUrl?: string
  /** Absolute token endpoint; defaults to `https://host/oauth/token`. */
  tokenUrl?: string
  /** Redirect URI registered with the provider; defaults to the
   *  connector callback route for the provider id. */
  redirectUri?: string
  type?: 'mock' | 'oauth'
}

export interface TokenExchangeResult {
  accessToken: string
  refreshToken?: string
  expiresInSeconds?: number
}

/** Provider token exchange. The default posts the authorization code
 *  grant to the provider's token endpoint; tests and mock providers
 *  inject a deterministic exchanger. */
export type TokenExchanger = (input: {
  provider: OAuthProviderSpec
  flow: OAuthFlow
  code: string
  redirectUri: string
  now: number
}) => Promise<TokenExchangeResult>

export function defaultTokenExchanger(): TokenExchanger {
  return async ({ provider, flow, code, redirectUri }) => {
    const tokenUrl = provider.tokenUrl ?? `https://${provider.host}/oauth/token`
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: provider.clientId ?? flow.clientId,
      code_verifier: flow.pkceVerifier,
      redirect_uri: redirectUri,
    })
    if (provider.clientSecret !== undefined) body.set('client_secret', provider.clientSecret)
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`)
    const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (typeof json.access_token !== 'string' || !json.access_token) throw new Error('token exchange response missing access_token')
    return {
      accessToken: json.access_token,
      ...(json.refresh_token !== undefined ? { refreshToken: json.refresh_token } : {}),
      ...(json.expires_in !== undefined ? { expiresInSeconds: json.expires_in } : {}),
    }
  }
}

export type CallbackOutcome =
  | { ok: true; provider: string; host: string; principalId: string; state: string }
  | { ok: false; error: 'denied' | 'bad_request' | 'unknown_state' | 'code_mismatch' | 'exchange_failed'; message?: string }

export interface ConnectorOAuthService {
  catalog(): { catalog: Array<{ id: string; name: string; host: string; scopes: readonly string[]; type: string }> }
  mintConsent(input: {
    provider: string
    principalId: string
    redirectUri: string
    orgId?: string
    accountType?: AccountType
    returnTo?: string
  }): Promise<{ ok: true; linkId: string; state: string; provider: string; host: string; oauthUrl: string; scopes: readonly string[] } | { ok: false; error: 'unknown_provider' }>
  redeemConsent(linkId: string): Promise<
    | { ok: true; linkId: string; provider: string; host: string; principalId: string; code: string; state: string; redirectUri: string }
    | { ok: false; error: 'not_found' | 'expired' }
  >
  startOAuth(input: { provider: string; state?: string }): Promise<
    | { ok: true; provider: string; state: string; authorizeUrl: string; scopes: readonly string[]; redirectUri: string }
    | { ok: false; error: 'unknown_provider' | 'missing_state' }
  >
  handleCallback(input: { provider?: string; code?: string; state?: string; error?: string }): Promise<CallbackOutcome>
  status(principalId: string): Promise<{ principalId: string; providers: Record<string, { host: string; accountTypes: string[]; hasToken: true }> }>
  revoke(input: { principalId: string; provider?: string; host?: string }): Promise<{ ok: true; principalId: string; host: string } | { ok: false; error: 'unknown_provider' | 'bad_request' }>
}

export interface ConnectorOAuthServiceOptions {
  flows: OAuthFlowStore
  consentLinks: ConsentLinkStore
  vault: ConnectorTokenVault
  providers: readonly OAuthProviderSpec[]
  /** Deterministic mock exchange for consent-loop providers without a
   *  real token endpoint (type: 'mock'). */
  mockExchanger?: TokenExchanger
  exchanger?: TokenExchanger
  now?: () => number
  metrics?: RunMetricsRegistry
}

function redactMessage(text: string, metrics: RunMetricsRegistry | undefined): string {
  const redacted = redactSecrets(text, 'log')
  if (redacted !== text) bumpOAuthRedactionHit(metrics, 'log')
  return redacted
}

export function createConnectorOAuthService(opts: ConnectorOAuthServiceOptions): ConnectorOAuthService {
  const now = opts.now ?? Date.now
  const providerFor = (id: string) => opts.providers.find((p) => p.id === id)
  const exchangerFor = (spec: OAuthProviderSpec): TokenExchanger => {
    if (opts.exchanger) return opts.exchanger
    if (spec.type === 'mock') return opts.mockExchanger ?? defaultMockExchanger()
    return defaultTokenExchanger()
  }

  return {
    catalog() {
      return {
        catalog: opts.providers.map((p) => ({ id: p.id, name: p.name, host: p.host, scopes: p.scopes, type: p.type ?? 'oauth' })),
      }
    },

    async mintConsent(input) {
      const spec = providerFor(input.provider)
      if (!spec) return { ok: false, error: 'unknown_provider' }
      const { linkId } = await opts.consentLinks.mint({
        principalId: input.principalId,
        ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
        provider: spec.id,
        accountType: input.accountType ?? 'user',
        redirectUri: input.redirectUri,
        ...(input.returnTo !== undefined ? { returnTo: input.returnTo } : {}),
        host: spec.host,
      })
      const state = await opts.flows.start({
        provider: spec.id,
        clientId: spec.clientId ?? 'qa-smoke',
        principalId: input.principalId,
        scopeId: input.orgId ?? `personal:${input.principalId}`,
        redirectUri: input.redirectUri,
        pkceVerifier: randomUUID().replace(/-/g, ''),
        consentMode: 'consent',
        scopes: [...spec.scopes],
        linkId,
        host: spec.host,
      })
      // The consent record carries the state so redeem (possibly on
      // another instance) can attach the code to the durable flow.
      await opts.consentLinks.attachState(linkId, state)
      return {
        ok: true,
        linkId,
        state,
        provider: spec.id,
        host: spec.host,
        oauthUrl: `/v1/connectors/oauth/${encodeURIComponent(spec.id)}/start?state=${encodeURIComponent(state)}`,
        scopes: spec.scopes,
      }
    },

    async redeemConsent(linkId) {
      const redeemed = await opts.consentLinks.redeem(linkId)
      if (!redeemed.ok) return { ok: false, error: redeemed.reason }
      const rec = redeemed.rec
      if (!rec.state) return { ok: false, error: 'expired' }
      const code = randomUUID().replace(/-/g, '')
      const attached = await opts.flows.attachCode(rec.state, code)
      if (!attached) return { ok: false, error: 'expired' }
      return {
        ok: true,
        linkId,
        provider: rec.provider,
        host: rec.host ?? rec.provider,
        principalId: rec.principalId,
        code,
        state: rec.state,
        redirectUri: rec.redirectUri,
      }
    },

    async startOAuth(input) {
      const spec = providerFor(input.provider)
      if (!spec) {
        bumpOAuthFlow(opts.metrics, 'start', 'fail')
        return { ok: false, error: 'unknown_provider' }
      }
      const state = (input.state ?? '').trim()
      if (!state) {
        bumpOAuthFlow(opts.metrics, 'start', 'fail')
        return { ok: false, error: 'missing_state' }
      }
      const authorizeUrl = spec.authorizeUrl ?? `https://${spec.host}/oauth/authorize`
      const params = new URLSearchParams({ state, client_id: spec.clientId ?? 'qa-smoke' })
      if (spec.scopes.length > 0) params.set('scope', spec.scopes.join(' '))
      const redirectUri = spec.redirectUri ?? `/v1/connectors/oauth/${encodeURIComponent(spec.id)}/callback`
      bumpOAuthFlow(opts.metrics, 'start', 'ok')
      return { ok: true, provider: spec.id, state, authorizeUrl: `${authorizeUrl}?${params.toString()}`, scopes: spec.scopes, redirectUri }
    },

    async handleCallback(input) {
      if (input.error) {
        bumpOAuthFlow(opts.metrics, 'callback', 'fail')
        return { ok: false, error: 'denied', message: redactMessage(input.error, opts.metrics) }
      }
      const code = (input.code ?? '').trim()
      const state = (input.state ?? '').trim()
      if (!code || !state) {
        bumpOAuthFlow(opts.metrics, 'callback', 'fail')
        return { ok: false, error: 'bad_request', message: 'code and state required' }
      }
      // Single-use, TTL-checked, durable: a restart or another
      // instance sees the same flow; a duplicate callback finds the
      // flow already consumed (finish took it) and fails here.
      const flow = await opts.flows.finish(state)
      if (!flow) {
        bumpOAuthFlow(opts.metrics, 'callback', 'fail')
        return { ok: false, error: 'unknown_state' }
      }
      if (flow.code !== undefined && flow.code !== code) {
        bumpOAuthFlow(opts.metrics, 'callback', 'fail')
        return { ok: false, error: 'code_mismatch' }
      }
      const spec = providerFor(flow.provider)
      if (!spec) {
        bumpOAuthFlow(opts.metrics, 'callback', 'fail')
        return { ok: false, error: 'unknown_state' }
      }
      bumpOAuthFlow(opts.metrics, 'callback', 'ok')
      try {
        const tokens = await exchangerFor(spec)({
          provider: spec,
          flow,
          code,
          redirectUri: spec.redirectUri ?? `/v1/connectors/oauth/${encodeURIComponent(spec.id)}/callback`,
          now: now(),
        })
        await opts.vault.seal({
          host: spec.host,
          principalId: flow.principalId,
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
          ...(tokens.expiresInSeconds !== undefined ? { expiresAt: now() + tokens.expiresInSeconds * 1000 } : {}),
          accountType: 'default' satisfies ConnectorAccountType,
          provider: spec.id,
        })
        bumpOAuthFlow(opts.metrics, 'complete', 'ok')
        return { ok: true, provider: spec.id, host: spec.host, principalId: flow.principalId, state }
      } catch (e) {
        bumpOAuthFlow(opts.metrics, 'complete', 'fail')
        return { ok: false, error: 'exchange_failed', message: redactMessage(e instanceof Error ? e.message : String(e), opts.metrics) }
      }
    },

    async status(principalId) {
      const providers: Record<string, { host: string; accountTypes: string[]; hasToken: true }> = {}
      for (const spec of opts.providers) {
        const accountTypes: string[] = []
        for (const at of CONNECTOR_ACCOUNT_TYPES) {
          const s = await opts.vault.status(spec.host, principalId, at)
          if (s.connected) accountTypes.push(at)
        }
        if (accountTypes.length > 0) providers[spec.id] = { host: spec.host, accountTypes, hasToken: true }
      }
      return { principalId, providers }
    },

    async revoke(input) {
      const principalId = input.principalId
      if (!principalId || (!input.provider && !input.host)) return { ok: false, error: 'bad_request' }
      if (input.provider) {
        const spec = providerFor(input.provider)
        if (!spec) return { ok: false, error: 'unknown_provider' }
        for (const at of CONNECTOR_ACCOUNT_TYPES) await opts.vault.delete(spec.host, principalId, at)
        return { ok: true, principalId, host: spec.host }
      }
      const host = input.host!
      for (const at of CONNECTOR_ACCOUNT_TYPES) await opts.vault.delete(host, principalId, at)
      return { ok: true, principalId, host }
    },
  }
}

/** Deterministic consent-loop exchange (Phase 3C parity): the mock
 *  provider "issues" a token derived from the code so the full loop is
 *  exercisable without a real third party. */
export function defaultMockExchanger(): TokenExchanger {
  return async ({ code, provider }) => ({
    accessToken: `mock-${provider.id}-${code}`,
    expiresInSeconds: 3600,
  })
}
