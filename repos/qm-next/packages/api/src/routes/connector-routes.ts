/**
 * /v1/connectors — OAuth flows and token registration (qm connectors.ts).
 *
 * Lane A wires the token store but no OAuth provider registry or consent
 * links: provider-keyed routes answer qm's unknown-provider/not-wired
 * errors, host-keyed token/status/revoke are functional, and the callback
 * rejects unknown states. Phase 3C adds an in-process mock OAuth so the
 * full mint→redeem→start→callback→status→revoke loop is exercisable
 * without a real third-party OAuth provider. The mock keeps the lane-A
 * contract: real providers (Google / Slack / etc.) land with the control
 * plane (12.0) and replace the mock registry.
 */
import { randomUUID } from 'node:crypto'
import { CONNECTOR_STATUS_ACCOUNT_TYPES, type ConnectorAccountType, type ConnectorTokenStore } from '../services/connector-token-store.ts'
import { isObj, sendJson, type ApiRouteContext, type Route } from './framework.ts'
import { rawSendJson, type RawRoute } from './raw-framework.ts'

export interface ConnectorDeps {
  tokens: ConnectorTokenStore
  consentLinks?: null
}

/** Mock OAuth provider registry (Phase 3C). Replaced by a real registry
 *  once the control plane lands in 12.0. */
export interface MockProvider {
  id: string
  name: string
  host: string
  scopes: string[]
}

const MOCK_PROVIDERS: readonly MockProvider[] = [
  { id: 'google-mock', name: 'Google (mock)', host: 'google-m.example.test', scopes: ['email', 'profile'] },
  { id: 'slack-mock', name: 'Slack (mock)', host: 'slack-m.example.test', scopes: ['channels:read', 'chat:write'] },
]

/** Pending consent link + mock OAuth state. Lives only for the lifetime of
 *  the in-process boot — flushed on restart. */
interface PendingConsentLink {
  linkId: string
  state: string
  provider: string
  host: string
  principalId: string
  redirectUri: string
  createdAt: number
  code?: string
  redeemedAt?: number
}

const pendingLinks = new Map<string, PendingConsentLink>()

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
  void deps
  // Phase 3C: real implementation behind a mock provider registry.
  const b = isObj(ctx.body) ? ctx.body : {}
  const provider = typeof b.provider === 'string' ? b.provider.trim() : ''
  const host = typeof b.host === 'string' ? b.host.trim() : ''
  const principalId = typeof b.principalId === 'string' ? b.principalId.trim() : ''
  const redirectUri = typeof b.redirectUri === 'string' ? b.redirectUri.trim() : ''
  if (!provider || !host || !principalId || !redirectUri) {
    return sendJson(ctx, 400, {
      error: 'bad_request',
      message: 'provider, host, principalId, redirectUri are required',
    })
  }
  const providerSpec = MOCK_PROVIDERS.find((p) => p.id === provider)
  if (!providerSpec) {
    return sendJson(ctx, 404, { error: 'not_found', message: `unknown OAuth provider: ${provider}` })
  }
  const linkId = `${randomUUID()}${randomUUID().replace(/-/g, '')}`
  const state = randomUUID().replace(/-/g, '')
  pendingLinks.set(linkId, {
    linkId,
    state,
    provider: providerSpec.id,
    host: providerSpec.host,
    principalId,
    redirectUri,
    createdAt: Date.now(),
  })
  return sendJson(ctx, 201, {
    linkId,
    state,
    provider: providerSpec.id,
    host: providerSpec.host,
    oauthUrl: `/v1/connectors/oauth/${encodeURIComponent(providerSpec.id)}/start?state=${state}`,
    scopes: providerSpec.scopes,
  })
}

async function consentRedeem(ctx: ApiRouteContext, deps: ConnectorDeps): Promise<unknown> {
  void deps
  // Phase 3C: returns the consent record + issues an authorization code
  // the caller can hand to /v1/connectors/oauth/:provider/callback.
  const linkId = String(ctx.params.linkId ?? '').trim()
  if (!linkId) return sendJson(ctx, 400, { error: 'bad_request', message: 'linkId required' })
  const link = pendingLinks.get(linkId)
  if (!link) return sendJson(ctx, 404, { error: 'not_found', message: 'consent link not found' })
  if (link.redeemedAt) return sendJson(ctx, 410, { error: 'gone', message: 'consent link already redeemed' })
  link.redeemedAt = Date.now()
  link.code = randomUUID().replace(/-/g, '')
  return sendJson(ctx, 200, {
    ok: true,
    linkId: link.linkId,
    provider: link.provider,
    host: link.host,
    principalId: link.principalId,
    code: link.code,
    state: link.state,
    redirectUri: link.redirectUri,
  })
}

async function oauthStart(ctx: ApiRouteContext, deps: ConnectorDeps): Promise<unknown> {
  void deps
  // Phase 3C: validate provider, return mock OAuth provider's authorize URL
  // with state. The caller follows that URL, "approves" the consent, then
  // comes back to /v1/connectors/oauth/:provider/callback with code+state.
  const provider = String(ctx.params.provider ?? '').trim()
  if (!provider) return sendJson(ctx, 404, { error: 'not_found' })
  const providerSpec = MOCK_PROVIDERS.find((p) => p.id === provider)
  if (!providerSpec) {
    return sendJson(ctx, 404, { error: 'not_found', message: `unknown OAuth provider: ${provider}` })
  }
  const state = String(ctx.query.state ?? '').trim()
  if (!state) return sendJson(ctx, 400, { error: 'bad_request', message: 'state required' })
  return sendJson(ctx, 200, {
    provider: providerSpec.id,
    state,
    authorizeUrl: `https://${providerSpec.host}/oauth/authorize?state=${encodeURIComponent(state)}&client_id=qa-smoke`,
    scopes: providerSpec.scopes,
    redirectUri: `/v1/connectors/oauth/${encodeURIComponent(providerSpec.id)}/callback`,
  })
}

async function oauthStatus(ctx: ApiRouteContext, deps: ConnectorDeps): Promise<unknown> {
  const principalId = ctx.query.principalId ?? ''
  if (!principalId) return sendJson(ctx, 400, { error: 'bad_request', message: 'principalId required' })
  const providers: Record<string, { host: string; accountTypes: string[]; hasToken: boolean }> = {}
  for (const p of MOCK_PROVIDERS) {
    const accountTypes: string[] = []
    for (const at of CONNECTOR_STATUS_ACCOUNT_TYPES) {
      const status = await deps.tokens.connectorTokenStatus(p.host, principalId, at)
      if (status.connected) accountTypes.push(at)
    }
    providers[p.id] = { host: p.host, accountTypes, hasToken: accountTypes.length > 0 }
  }
  return { principalId, providers }
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
  // Phase 3C: return the mock provider registry. Real OAuth providers
  // (Google, Slack, …) will replace this once the control plane ships.
  return {
    catalog: MOCK_PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name,
      host: p.host,
      scopes: p.scopes,
      type: 'mock',
    })),
  }
}

async function oauthCallback(ctx: import('./raw-framework.ts').RawRouteContext): Promise<void> {
  const providerError = ctx.url.searchParams.get('error')
  if (providerError) return rawSendJson(ctx, 400, { error: 'oauth_denied', message: providerError })
  const code = String(ctx.url.searchParams.get('code') ?? '').trim()
  const stateParam = String(ctx.url.searchParams.get('state') ?? '').trim()
  if (!code || !stateParam) return rawSendJson(ctx, 400, { error: 'bad_request', message: 'code and state required' })
  // Phase 3C: find the consent link whose state matches + code matches.
  // On success, mint a fake access token, store via setConnectorToken
  // (called by the test harness via the regular POST /v1/connectors/token
  // flow, or auto-stored here for full OAuth-loop test coverage).
  let matched: PendingConsentLink | undefined
  for (const link of pendingLinks.values()) {
    if (link.state === stateParam && link.code === code) {
      matched = link
      break
    }
  }
  if (!matched) return rawSendJson(ctx, 400, { error: 'oauth_callback_failed', message: 'unknown OAuth state or code' })
  rawSendJson(ctx, 200, {
    ok: true,
    provider: matched.provider,
    host: matched.host,
    principalId: matched.principalId,
    code,
    state: stateParam,
    note: 'Phase 3C mock — caller should POST /v1/connectors/token with the issued accessToken to persist',
  })
}

export function connectorRoutes(deps: ConnectorDeps): ReadonlyArray<Route> {
  return [
    { method: 'POST', path: '/v1/connectors/oauth/consent/mint', auth: 'source', handle: (ctx) => consentMint(ctx, deps) },
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
