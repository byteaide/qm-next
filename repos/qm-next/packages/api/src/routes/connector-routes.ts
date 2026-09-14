/**
 * /v1/connectors — OAuth flows and token registration (qm connectors.ts).
 * Lane A wires the token store but no OAuth provider registry or consent
 * links: provider-keyed routes answer qm's unknown-provider/not-wired
 * errors, host-keyed token/status/revoke are functional, and the callback
 * rejects unknown states. Full OAuth lands with the control plane (12.0).
 */
import { CONNECTOR_STATUS_ACCOUNT_TYPES, type ConnectorAccountType, type ConnectorTokenStore } from '../services/connector-token-store.ts'
import { isObj, sendJson, type ApiRouteContext, type Route } from './framework.ts'
import { rawSendJson, type RawRoute } from './raw-framework.ts'

export interface ConnectorDeps {
  tokens: ConnectorTokenStore
  consentLinks?: null
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

async function consentMint(ctx: ApiRouteContext, deps: ConnectorDeps): Promise<unknown> {
  if (!deps.consentLinks) return sendJson(ctx, 404, { error: 'not_found' })
  return sendJson(ctx, 404, { error: 'not_found' })
}

async function consentRedeem(ctx: ApiRouteContext, deps: ConnectorDeps): Promise<unknown> {
  void ctx
  if (!deps.consentLinks) return sendJson(ctx, 404, { error: 'not_found' })
  return sendJson(ctx, 404, { error: 'not_found' })
}

async function oauthStart(ctx: ApiRouteContext, deps: ConnectorDeps): Promise<unknown> {
  const provider = ctx.params.provider
  if (!provider) return sendJson(ctx, 404, { error: 'not_found' })
  void deps
  return sendJson(ctx, 404, { error: 'not_found', message: `unknown OAuth provider: ${provider}` })
}

async function oauthStatus(ctx: ApiRouteContext, deps: ConnectorDeps): Promise<unknown> {
  const principalId = ctx.query.principalId ?? ''
  if (!principalId) return sendJson(ctx, 400, { error: 'bad_request', message: 'principalId required' })
  void deps
  return { principalId, providers: {} }
}

async function oauthRevoke(ctx: ApiRouteContext, deps: ConnectorDeps): Promise<unknown> {
  const b = isObj(ctx.body) ? ctx.body : {}
  const principalId = typeof b.principalId === 'string' ? b.principalId : ''
  const providerName = typeof b.provider === 'string' ? b.provider : ''
  const host = typeof b.host === 'string' ? b.host : ''
  if (!principalId || (!providerName && !host)) {
    return sendJson(ctx, 400, { error: 'bad_request', message: 'principalId and provider or host required' })
  }
  if (providerName) {
    return sendJson(ctx, 404, { error: 'not_found', message: `unknown OAuth provider: ${providerName}` })
  }
  for (const at of CONNECTOR_STATUS_ACCOUNT_TYPES) {
    await deps.tokens.deleteConnectorToken(host, principalId, at)
  }
  return { ok: true, principalId, host }
}

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

async function catalog(ctx: ApiRouteContext, _deps: ConnectorDeps): Promise<unknown> {
  void ctx
  void _deps
  return { catalog: [] }
}

async function oauthCallback(ctx: import('./raw-framework.ts').RawRouteContext): Promise<void> {
  const providerError = ctx.url.searchParams.get('error')
  if (providerError) return rawSendJson(ctx, 400, { error: 'oauth_denied', message: providerError })
  const code = ctx.url.searchParams.get('code') ?? ''
  const stateParam = ctx.url.searchParams.get('state') ?? ''
  if (!code || !stateParam) return rawSendJson(ctx, 400, { error: 'bad_request', message: 'code and state required' })
  rawSendJson(ctx, 400, { error: 'oauth_callback_failed', message: 'unknown OAuth state' })
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
      handle: (ctx) => oauthCallback(ctx),
    },
  }
}
