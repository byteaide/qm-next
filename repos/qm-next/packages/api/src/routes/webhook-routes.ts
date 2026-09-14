/**
 * /v1/webhooks — webhook CRUD (qm webhooks.ts) plus the raw incoming
 * delivery lane. Signatures verify per scheme with constant-time compares;
 * secret redaction uses qm's "***". Deliveries reach an agent with the
 * 13.0 IM bridge — until then accepted deliveries answer 202.
 */
import { redactWebhook, WEBHOOK_SCHEMES, type Webhook, type WebhookStore } from '../services/webhook-store.ts'
import { badRequest, isObj, notFound, sendJson, type ApiRouteContext, type Route } from './framework.ts'
import { rawSendJson, rawSendText, type RawRoute } from './raw-framework.ts'

export interface WebhookDeps {
  webhooks: WebhookStore
  publicUrl?: string
}

function isWebhookVerification(value: Record<string, unknown>): boolean {
  return (
    typeof value.scheme === 'string' &&
    (WEBHOOK_SCHEMES as readonly string[]).includes(value.scheme) &&
    typeof value.secret === 'string' &&
    value.secret.length > 0
  )
}

function isWebhookFilters(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (filter) =>
        isObj(filter) &&
        typeof filter.path === 'string' &&
        filter.path.trim().length > 0 &&
        Array.isArray(filter.in) &&
        filter.in.length > 0 &&
        filter.in.every((candidate) => typeof candidate === 'string' && candidate.trim().length > 0),
    )
  )
}

function isCreateWebhook(b: unknown): b is {
  ownerScopeId: string
  owner: string
  createdBy: string
  action: string
  verification: Webhook['verification']
} {
  return (
    isObj(b) &&
    typeof b.ownerScopeId === 'string' &&
    typeof b.owner === 'string' &&
    typeof b.createdBy === 'string' &&
    typeof b.action === 'string' &&
    isObj(b.verification) &&
    isWebhookVerification(b.verification) &&
    (b.filters === undefined || isWebhookFilters(b.filters))
  )
}

function inboundUrl(publicBase: string | undefined, id: string): string {
  const incomingPath = `/v1/webhooks/incoming/${id}`
  return publicBase ? `${publicBase.replace(/\/$/, '')}${incomingPath}` : incomingPath
}

async function createWebhook(ctx: ApiRouteContext, deps: WebhookDeps): Promise<unknown> {
  if (!isCreateWebhook(ctx.body)) return badRequest(ctx, 'expected a CreateWebhookInput')
  try {
    const webhook = await deps.webhooks.create(ctx.body)
    return { webhook, url: inboundUrl(deps.publicUrl, webhook.id) }
  } catch (error) {
    return sendJson(ctx, 400, { error: 'webhook_create_failed', message: error instanceof Error ? error.message : String(error) })
  }
}

function canAdministerWebhook(webhook: Webhook, viewer: string): boolean {
  return webhook.owner === viewer
}

async function listWebhooks(ctx: ApiRouteContext, deps: WebhookDeps): Promise<unknown> {
  const all = await deps.webhooks.list()
  const viewer = ctx.actor?.id ?? ctx.query.viewer
  const visible = viewer ? all.filter((w) => canAdministerWebhook(w, viewer)) : all
  return {
    webhooks: visible.map((webhook) => ({ ...redactWebhook(webhook), url: inboundUrl(deps.publicUrl, webhook.id) })),
  }
}

async function setWebhookEnabled(ctx: ApiRouteContext, deps: WebhookDeps, enabled: boolean): Promise<unknown> {
  const id = ctx.params.id
  if (!id) return notFound(ctx)
  const webhook = await deps.webhooks.get(id)
  if (!webhook) return sendJson(ctx, 404, { error: 'not_found' })
  const principalId = ctx.actor?.id ?? ctx.query.principalId
  if (principalId && !canAdministerWebhook(webhook, principalId)) {
    const portalCaller = Boolean(ctx.actor)
    return sendJson(ctx, portalCaller ? 403 : 404, {
      error: portalCaller ? 'forbidden' : 'not_found',
      ...(portalCaller ? { message: 'not your webhook' } : {}),
    })
  }
  await deps.webhooks.setEnabled(id, enabled)
  return { ok: true }
}

async function incomingWebhook(ctx: import('./raw-framework.ts').RawRouteContext, deps: WebhookDeps): Promise<void> {
  const id = ctx.params.id
  if (!id) return rawSendJson(ctx, 404, { error: 'not_found' })
  const out = await deps.webhooks.deliver(id, { headers: ctx.req.headers, rawBody: ctx.rawBody.toString('utf8') })
  if (out.status === 200) return rawSendText(ctx, 200, out.body ?? 'ok')
  if (out.status === 202) return rawSendJson(ctx, 202, { ok: true })
  if (out.status === 401) return rawSendJson(ctx, 401, { error: 'unauthorized', message: 'signature verification failed' })
  return rawSendJson(ctx, 404, { error: 'not_found' })
}

export function webhookRoutes(deps: WebhookDeps): ReadonlyArray<Route> {
  return [
    { method: 'POST', path: '/v1/webhooks', auth: 'either', handle: (ctx) => createWebhook(ctx, deps) },
    { method: 'GET', path: '/v1/webhooks', auth: 'either', handle: (ctx) => listWebhooks(ctx, deps) },
    { method: 'POST', path: '/v1/webhooks/:id/disable', auth: 'either', handle: (ctx) => setWebhookEnabled(ctx, deps, false) },
    { method: 'POST', path: '/v1/webhooks/:id/enable', auth: 'either', handle: (ctx) => setWebhookEnabled(ctx, deps, true) },
  ]
}

export function webhookRawRoutes(deps: WebhookDeps): ReadonlyArray<RawRoute> {
  return [
    {
      method: 'POST',
      path: '/v1/webhooks/incoming/:id',
      auth: 'public',
      readBody: true,
      bodyLimitBytes: 1_000_000,
      handle: (ctx) => incomingWebhook(ctx, deps),
    },
  ]
}
