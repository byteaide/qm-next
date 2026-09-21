/**
 * /d/<slug>/** — public reverse-proxy lane (cluster 1 MVP, parity #45b).
 * Resolves the deployment by name/id, asks the live provider for its
 * endpoint, and forwards the inbound request via node:http. No path
 * rewriting: the upstream container sees the raw `/...` path it was
 * called with. `either` auth means a signed-in user is preferred; an
 * anonymous request still hits the container (mount may 403 internally).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import type { DeployProvider } from '@qm/types'
import type { DeploymentStore } from '../services/deployment-store.ts'
import { notFound, sendJson, type ApiRouteContext, type Route } from './framework.ts'

export interface DeploymentProxyDeps {
  deployments: DeploymentStore
  provider: DeployProvider
}

function pickForwardHeaders(req: IncomingMessage | { headers: Record<string, unknown> }): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (lower === 'host' || lower === 'connection' || lower === 'content-length') continue
    out[key] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return out
}

async function proxyToDeployment(ctx: ApiRouteContext, deps: DeploymentProxyDeps): Promise<unknown> {
  const slug = ctx.params.slug
  if (!slug) return notFound(ctx)
  const deployment = await deps.deployments.getByIdOrName(slug)
  if (!deployment) return notFound(ctx)
  const version = deployment.appliedVersion ?? deployment.currentVersion
  const endpoint = await deps.provider.resolveEndpoint(deployment.id, version)
  if (!endpoint) return sendJson(ctx, 502, { error: 'container_not_running' })

  const upstreamPath = ctx.req.url ?? '/'
  const upstreamHeaders = pickForwardHeaders(ctx.req)

  return await new Promise<void>((resolve) => {
    const upstreamReq = httpRequest(
      {
        host: endpoint.host,
        port: endpoint.port,
        method: ctx.req.method,
        path: upstreamPath,
        headers: upstreamHeaders,
      },
      (upstreamRes: IncomingMessage) => {
        ctx.reply.code(upstreamRes.statusCode ?? 502)
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined) continue
          ctx.reply.header(key, value)
        }
        upstreamRes.pipe(ctx.reply.raw as ServerResponse)
        upstreamRes.on('end', () => resolve())
        upstreamRes.on('error', () => resolve())
      },
    )
    upstreamReq.on('error', () => {
      sendJson(ctx, 502, { error: 'upstream_unreachable' })
      resolve()
    })
    ctx.req.raw.pipe(upstreamReq)
  })
}

export function deploymentProxyRoutes(deps: DeploymentProxyDeps): ReadonlyArray<Route> {
  return [
    { method: 'GET', path: '/d/:slug', auth: 'either', handle: (ctx) => proxyToDeployment(ctx, deps) },
    { method: 'GET', path: '/d/:slug/*', auth: 'either', handle: (ctx) => proxyToDeployment(ctx, deps) },
    { method: 'POST', path: '/d/:slug/*', auth: 'either', handle: (ctx) => proxyToDeployment(ctx, deps) },
    { method: 'PUT', path: '/d/:slug/*', auth: 'either', handle: (ctx) => proxyToDeployment(ctx, deps) },
    { method: 'PATCH', path: '/d/:slug/*', auth: 'either', handle: (ctx) => proxyToDeployment(ctx, deps) },
    { method: 'DELETE', path: '/d/:slug/*', auth: 'either', handle: (ctx) => proxyToDeployment(ctx, deps) },
  ]
}