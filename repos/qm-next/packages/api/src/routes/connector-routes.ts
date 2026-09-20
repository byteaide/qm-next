/**
 * /v1/connectors — HTTP adapters over the Connector-owned OAuth
 * lifecycle (plan §Phase 6 slices 2–3, ADR-0009). Routes validate
 * input, normalize the provider payload, invoke a Connector operation,
 * and return/redact the result. No route-local OAuth state: the
 * pending-link Map and provider registry defaults of the Phase 3C
 * mock are deleted; flow state, consent links, exchange, and token
 * persistence live in @qm/connectors behind durable stores, and
 * tokens are sealed by the vault (ADR-0017) before any response.
 */
import type { ConnectorAccountType, ConnectorTokenStore } from '../services/connector-token-store.ts'
import type { ConnectorOAuthService } from '@qm/connectors'
import { isObj, sendJson, type ApiRouteContext, type Route } from './framework.ts'
import { rawSendJson, type RawRoute } from './raw-framework.ts'

export interface ConnectorDeps {
  tokens: ConnectorTokenStore
  /** Connector-owned OAuth lifecycle (Phase 6, ADR-0009). */
  oauth: ConnectorOAuthService
}

const SECONDS_VS_MS_CUTOFF = 1_000_000_000_000
const MIN_REASONABLE_EPOCH_MS = Date.UTC(2000, 0, 1)
const MAX_REASONABLE_EPOCH_MS = Date.UTC(3000, 0, 1)

function normalizeInboundExpiresAt(value: unknown, field = 'expiresAt'): { ok: true; value?: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true }
  let ms: number
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return bad(field)
    ms = value < SECONDS_VS_MS_CUTOFF ? value * 1000 : value
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return bad(field)
    ms = Date.parse(trimmed)
  } else {
    return bad(field)
  }
  if (!Number.isFinite(ms) || ms < MIN_REASONABLE_EPOCH_MS || ms > MAX_REASONABLE_EPOCH_MS) return bad(field)
  return { ok: true, value: Math.trunc(ms) }
}

function bad(field: string): { ok: false; message: string } {
  return { ok: false, message: `${field} must be an epoch timestamp in seconds or milliseconds, or an ISO date string` }
}

// --- adapters: consent link ------------------------------------------------

async function consentMint(ctx: ApiRouteContext, deps: ConnectorDeps): Promise<unknown> {
  const b = isObj(ctx.body) ? ctx.body : {}
  const provider = typeof b.provider === 'string' ? b.provider.trim() : ''
  const principalId = typeof b.principalId === 'string' ? b.principalId.trim() : ''
  const redirectUri = typeof b.redirectUri === 'string' ? b.redirectUri.trim() : ''
  if (!provider || !principalId || !redirectUri) {
    return sendJson(ctx, 400, {
      error: 'bad_request',
      message: 'provider, principalId, redirectUri are required',
    })
  }
  const minted = await deps.oauth.mintConsent({ provider, principalId, redirectUri })
  if (!minted.ok) {
    return sendJson(ctx, 404, { error: 'not_found', message: `unknown OAuth provider: ${provider}` })
  }
  return sendJson(ctx, 201, {
    linkId: minted.linkId,
    state: minted.state,
    provider: minted.provider,
    host: minted.host,
    oauthUrl: minted.oauthUrl,
    scopes: minted.scopes,
  })
}

async function consentRedeem(ctx: ApiRouteContext, deps: ConnectorDeps): Promise<unknown> {
  const linkId = String(ctx.params.linkId ?? '').trim()
  if (!linkId) return sendJson(ctx, 400, { error: 'bad_request', message: 'linkId required' })
  const redeemed = await deps.oauth.redeemConsent(linkId)
  if (!redeemed.ok) {
    if (redeemed.error === 'expired') return sendJson(ctx, 410, { error: 'gone', message: 'consent link expired' })
    return sendJson(ctx, 404, { error: 'not_found', message: 'consent link not found' })
  }
  return sendJson(ctx, 200, {
    ok: true,
    linkId: redeemed.linkId,
    provider: redeemed.provider,
    host: redeemed.host,
    principalId: redeemed.principalId,
    code: redeemed.code,
    state: redeemed.state,
    redirectUri: redeemed.redirectUri,
  })
}

// --- adapters: provider-keyed OAuth ---------------------------------------

async function oauthStart(ctx: ApiRouteContext, deps: ConnectorDeps): Promise<unknown> {
  const provider = String(ctx.params.provider ?? '').trim()
  if (!provider) return sendJson(ctx, 404, { error: 'not_found' })
  const started = await deps.oauth.startOAuth({
    provider,
    ...(typeof ctx.query.state === 'string' && ctx.query.state ? { state: ctx.query.state } : {}),
  })
  if (!started.ok) {
    if (started.error === 'unknown_provider') {
      return sendJson(ctx, 404, { error: 'not_found', message: `unknown OAuth provider: ${provider}` })
    }
    return sendJson(ctx, 400, { error: 'bad_request', message: 'state required' })
  }
  return sendJson(ctx, 200, {
    provider: started.provider,
    state: started.state,
    authorizeUrl: started.authorizeUrl,
    scopes: started.scopes,
    redirectUri: started.redirectUri,
  })
}

async function oauthStatus(ctx: ApiRouteContext, deps: ConnectorDeps): Promise<unknown> {
  const principalId = ctx.query.principalId ?? ''
  if (!principalId) return sendJson(ctx, 400, { error: 'bad_request', message: 'principalId required' })
  // Connector-owned: only providers with a connected token appear; the
  // response carries presence metadata, never token material (ADR-0016).
  return deps.oauth.status(principalId)
}

async function oauthRevoke(ctx: ApiRouteContext, deps: ConnectorDeps): Promise<unknown> {
  const b = isObj(ctx.body) ? ctx.body : {}
  const principalId = typeof b.principalId === 'string' ? b.principalId : ''
  const providerName = typeof b.provider === 'string' ? b.provider : ''
  const host = typeof b.host === 'string' ? b.host : ''
  if (!principalId || (!providerName && !host)) {
    return sendJson(ctx, 400, { error: 'bad_request', message: 'principalId and provider or host required' })
  }
  const revoked = await deps.oauth.revoke({ principalId, ...(providerName ? { provider: providerName } : { host }) })
  if (!revoked.ok) {
    return sendJson(ctx, 404, { error: 'not_found', message: `unknown OAuth provider: ${providerName}` })
  }
  return { ok: true, principalId: revoked.principalId, host: revoked.host }
}

// --- adapters: host-keyed token registration -------------------------------

async function setToken(ctx: ApiRouteContext, deps: ConnectorDeps): Promise<unknown> {
  const b = isObj(ctx.body) ? ctx.body : {}
  const host = typeof b.host === 'string' ? b.host : ''
  const principalId = typeof b.principalId === 'string' ? b.principalId : ''
  const accessToken = typeof b.accessToken === 'string' ? b.accessToken : ''
  const expiresAt = normalizeInboundExpiresAt(b.expiresAt)
  if (!expiresAt.ok) return sendJson(ctx, 400, { error: 'bad_request', message: expiresAt.message })
  if (!host || !principalId || !accessToken) {
    return sendJson(ctx, 400, { error: 'bad_request', message: 'host, principalId, accessToken required' })
  }
  await deps.tokens.setConnectorToken(
    host,
    principalId,
    {
      accessToken,
      ...(typeof b.refreshToken === 'string' ? { refreshToken: b.refreshToken } : {}),
      ...(expiresAt.value !== undefined ? { expiresAt: expiresAt.value } : {}),
    },
    (typeof b.accountType === 'string' && ['default', 'personal', 'org'].includes(b.accountType) ? b.accountType : 'default') as ConnectorAccountType,
  )
  return { ok: true }
}

async function catalog(ctx: ApiRouteContext, deps: ConnectorDeps): Promise<unknown> {
  void ctx
  return deps.oauth.catalog()
}

// --- adapters: raw provider callback ---------------------------------------

async function oauthCallback(ctx: import('./raw-framework.ts').RawRouteContext, deps: ConnectorDeps): Promise<void> {
  const providerError = ctx.url.searchParams.get('error')
  const code = ctx.url.searchParams.get('code') ?? ''
  const state = ctx.url.searchParams.get('state') ?? ''
  const outcome = await deps.oauth.handleCallback({
    ...(providerError !== null ? { error: providerError } : {}),
    ...(providerError === null ? { code, state } : {}),
  })
  if (outcome.ok) {
    rawSendJson(ctx, 200, {
      ok: true,
      provider: outcome.provider,
      host: outcome.host,
      principalId: outcome.principalId,
      code,
      state: outcome.state,
      connected: true,
    })
    return
  }
  if (outcome.error === 'denied') {
    rawSendJson(ctx, 400, { error: 'oauth_denied', message: outcome.message ?? 'provider denied the flow' })
    return
  }
  if (outcome.error === 'bad_request') {
    rawSendJson(ctx, 400, { error: 'bad_request', message: outcome.message ?? 'code and state required' })
    return
  }
  if (outcome.error === 'exchange_failed') {
    rawSendJson(ctx, 502, { error: 'oauth_exchange_failed', message: outcome.message ?? 'token exchange failed' })
    return
  }
  // unknown_state / code_mismatch — same public signal, no detail leak.
  rawSendJson(ctx, 400, { error: 'oauth_callback_failed', message: 'unknown OAuth state or code' })
}

export function connectorRoutes(deps: ConnectorDeps): ReadonlyArray<Route> {
  return [
    { method: 'POST', path: '/v1/connectors/oauth/consent/mint', auth: { aud: 'oauth-consent' }, handle: (ctx) => consentMint(ctx, deps) },
    { method: 'GET', path: '/v1/connectors/oauth/consent/redeem/:linkId', auth: 'source', handle: (ctx) => consentRedeem(ctx, deps) },
    { method: 'GET', path: '/v1/connectors/oauth/status', auth: 'source', handle: (ctx) => oauthStatus(ctx, deps) },
    { method: 'POST', path: '/v1/connectors/oauth/revoke', auth: 'either', handle: (ctx) => oauthRevoke(ctx, deps) },
    { method: 'POST', path: '/v1/connectors/token', auth: 'source', handle: (ctx) => setToken(ctx, deps) },
    { method: 'GET', path: '/v1/connectors/catalog', auth: 'source', handle: (ctx) => catalog(ctx, deps) },
  ]
}

export function connectorMatchRoutes(deps: ConnectorDeps): { api: Route; raw: RawRoute } {
  return {
    api: {
      method: 'GET',
      path: '/v1/connectors/oauth/:provider/start',
      auth: 'source',
      handle: (ctx) => oauthStart(ctx, deps),
    },
    raw: {
      method: 'GET',
      path: '/v1/connectors/oauth/:provider/callback',
      auth: 'public',
      handle: (ctx) => oauthCallback(ctx, deps),
    },
  }
}
