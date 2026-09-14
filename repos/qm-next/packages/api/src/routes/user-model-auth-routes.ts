/**
 * /v1/user-model-auth — per-principal model credentials (qm
 * user-model-auth.ts): identity is the bearer principal; OAuth device
 * flows surface qm's 502 gates until the subscription-OAuth integration
 * lands (deviation #46).
 */
import type { UserModelCredentialsStore, UserModelProvider } from '../services/user-model-auth-store.ts'
import { badRequest, isObj, sendJson, type ApiRouteContext, type Route } from './framework.ts'

export interface UserModelAuthDeps {
  credentials?: UserModelCredentialsStore
}

function caller(ctx: ApiRouteContext): string | null {
  return ctx.actor?.id ?? null
}

function connectProvider(raw: unknown): UserModelProvider | null {
  if (raw === 'anthropic' || raw === 'claude') return 'anthropic'
  if (raw === 'openai' || raw === 'chatgpt' || raw === 'codex') return 'openai'
  return null
}

async function getStatus(ctx: ApiRouteContext, deps: UserModelAuthDeps): Promise<unknown> {
  const principal = caller(ctx)
  if (!principal) return sendJson(ctx, 401, { error: 'unauthorized' })
  return { individualModelAuth: false, connections: (await deps.credentials?.connections(principal)) ?? [] }
}

async function putApiKey(ctx: ApiRouteContext, deps: UserModelAuthDeps): Promise<unknown> {
  const principal = caller(ctx)
  if (!principal) return sendJson(ctx, 401, { error: 'unauthorized' })
  if (!deps.credentials) return sendJson(ctx, 404, { error: 'not_found' })
  const body = isObj(ctx.body) ? ctx.body : {}
  const provider = connectProvider(body.provider)
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (!provider) return badRequest(ctx, 'provider must be claude or chatgpt')
  if (!apiKey) return badRequest(ctx, 'API key is required')
  await deps.credentials.setApiKey(principal, provider, apiKey)
  return { ok: true }
}

async function disconnect(ctx: ApiRouteContext, deps: UserModelAuthDeps): Promise<unknown> {
  const principal = caller(ctx)
  if (!principal) return sendJson(ctx, 401, { error: 'unauthorized' })
  if (!deps.credentials) return sendJson(ctx, 404, { error: 'not_found' })
  const provider = connectProvider((isObj(ctx.body) ? ctx.body : {}).provider)
  if (!provider) return badRequest(ctx, 'provider must be claude or chatgpt')
  await deps.credentials.delete(principal, provider)
  return { ok: true }
}

async function chatgptStart(ctx: ApiRouteContext): Promise<unknown> {
  if (!caller(ctx)) return sendJson(ctx, 401, { error: 'unauthorized' })
  return sendJson(ctx, 502, { error: 'oauth_start_failed', message: 'the codex device-login binary is not available in this deployment' })
}

async function chatgptPoll(ctx: ApiRouteContext, deps: UserModelAuthDeps): Promise<unknown> {
  const principal = caller(ctx)
  if (!principal) return sendJson(ctx, 401, { error: 'unauthorized' })
  if (!deps.credentials) return sendJson(ctx, 404, { error: 'not_found' })
  const deviceAuthId = isObj(ctx.body) && typeof ctx.body.deviceAuthId === 'string' ? ctx.body.deviceAuthId : ''
  if (!deviceAuthId) return sendJson(ctx, 400, { error: 'bad_request' })
  return sendJson(ctx, 502, { error: 'oauth_poll_failed', message: 'the codex device-login binary is not available in this deployment' })
}

async function claudeStart(ctx: ApiRouteContext): Promise<unknown> {
  if (!caller(ctx)) return sendJson(ctx, 401, { error: 'unauthorized' })
  return {
    url: 'https://claude.ai/oauth/authorize',
    message: 'subscription OAuth lands with the control plane; use an API key for now',
  }
}

async function claudeComplete(ctx: ApiRouteContext, deps: UserModelAuthDeps): Promise<unknown> {
  const principal = caller(ctx)
  if (!principal) return sendJson(ctx, 401, { error: 'unauthorized' })
  if (!deps.credentials) return sendJson(ctx, 404, { error: 'not_found' })
  const body = isObj(ctx.body) ? ctx.body : {}
  const code = typeof body.code === 'string' ? body.code : ''
  const verifier = typeof body.verifier === 'string' ? body.verifier : ''
  if (!code || !verifier) return sendJson(ctx, 400, { error: 'bad_request' })
  return sendJson(ctx, 502, { error: 'oauth_complete_failed', message: 'subscription OAuth is not available in this deployment' })
}

export function userModelAuthRoutes(deps: UserModelAuthDeps): ReadonlyArray<Route> {
  return [
    { method: 'GET', path: '/v1/user-model-auth/status', auth: 'source', handle: (ctx) => getStatus(ctx, deps) },
    { method: 'POST', path: '/v1/user-model-auth/api-key', auth: 'source', handle: (ctx) => putApiKey(ctx, deps) },
    { method: 'POST', path: '/v1/user-model-auth/disconnect', auth: 'source', handle: (ctx) => disconnect(ctx, deps) },
    { method: 'POST', path: '/v1/user-model-auth/chatgpt/start', auth: 'source', handle: (ctx) => chatgptStart(ctx) },
    { method: 'POST', path: '/v1/user-model-auth/chatgpt/poll', auth: 'source', handle: (ctx) => chatgptPoll(ctx, deps) },
    { method: 'POST', path: '/v1/user-model-auth/claude/start', auth: 'source', handle: (ctx) => claudeStart(ctx) },
    { method: 'POST', path: '/v1/user-model-auth/claude/complete', auth: 'source', handle: (ctx) => claudeComplete(ctx, deps) },
  ]
}
