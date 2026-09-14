/**
 * /v1/deployments — qm deployment management lane. Shapes and error
 * ladders mirror repos/qm/src/api/routes/deployments.ts; the public proxy
 * lane (/d/<slug>, admin proxy, git http backend) and live fetch/logs
 * need the deployment runtime, which lands with the 13.0 im-bridge.
 */
import type { DeploymentStore } from '../services/deployment-store.ts'
import { badRequest, isObj, notFound, sendJson, type ApiRouteContext, type Route } from './framework.ts'

export interface DeploymentDeps {
  deployments: DeploymentStore
  deployAppsDomain?: string
}

const LOGS_DEFAULT_TAIL_LINES = 200
const LOGS_MAX_TAIL_LINES = 2000
const AGENT_FETCH_DEFAULT_MAX_BYTES = 256 * 1024
const AGENT_FETCH_MAX_BYTES = 1024 * 1024

function isDeployInput(b: unknown): b is { ownerScopeId: string; createdBy: string; entrypoint: string; files: unknown[] } {
  return isObj(b) && typeof b.ownerScopeId === 'string' && typeof b.createdBy === 'string' && typeof b.entrypoint === 'string' && Array.isArray(b.files)
}

function callerId(ctx: ApiRouteContext): string | null {
  return ctx.actor?.id ?? ctx.query.principalId ?? null
}

async function resolveId(deps: DeploymentDeps, idOrName: string): Promise<string | null> {
  const d = await deps.deployments.getByIdOrName(idOrName)
  return d?.id ?? null
}

async function callerMayManage(ctx: ApiRouteContext, deps: DeploymentDeps, id: string): Promise<boolean> {
  const principalId = ctx.actor?.id
  if (!principalId) return true
  return deps.deployments.canManage(id, principalId)
}

async function createDeployment(ctx: ApiRouteContext, deps: DeploymentDeps): Promise<unknown> {
  if (!isDeployInput(ctx.body)) return badRequest(ctx, 'expected a DeployInput')
  const principalId = ctx.actor?.id ?? null
  if (principalId && ctx.body.createdBy !== principalId) return sendJson(ctx, 403, { error: 'forbidden' })
  try {
    return { deployment: await deps.deployments.deploy(ctx.body) }
  } catch (error) {
    return sendJson(ctx, 400, { error: 'deploy_failed', message: error instanceof Error ? error.message : String(error) })
  }
}

async function listDeployments(ctx: ApiRouteContext, deps: DeploymentDeps): Promise<unknown> {
  const principalId = callerId(ctx)
  if (!principalId) return { deployments: (await deps.deployments.list()) }
  return { deployments: await deps.deployments.listForViewer(principalId) }
}

async function getDeployment(ctx: ApiRouteContext, deps: DeploymentDeps): Promise<unknown> {
  const id = ctx.params.id
  if (!id) return notFound(ctx)
  const principalId = callerId(ctx)
  if (principalId) {
    const deployment = (await deps.deployments.listForViewer(principalId)).find((d) => d.id === id || d.name === id)
    if (!deployment) return sendJson(ctx, 404, { error: 'not_found' })
    return { deployment }
  }
  const stored = await deps.deployments.getByIdOrName(id)
  if (!stored) return sendJson(ctx, 404, { error: 'not_found' })
  return { deployment: stored }
}

function normalizedDeploymentFetchPath(raw: string | null): string | null {
  const path = raw ?? '/'
  if (!path.startsWith('/') || path.includes('\\') || path.includes('\0')) return null
  try {
    let decodedPath = path.split('?')[0]!
    for (let depth = 0; depth < 8; depth++) {
      const next = decodeURIComponent(decodedPath)
      if (next.includes('\\') || next.includes('\0') || next.split('/').some((segment) => segment === '.' || segment === '..')) {
        return null
      }
      if (next === decodedPath) break
      if (depth === 7) return null
      decodedPath = next
    }
    const normalized = new URL(path, 'http://deployment.invalid')
    if (normalized.origin !== 'http://deployment.invalid') return null
    return normalized.pathname + normalized.search
  } catch {
    return null
  }
}

async function fetchDeployment(ctx: ApiRouteContext, _deps: DeploymentDeps): Promise<unknown> {
  const viewer = ctx.actor?.id ?? null
  if (!viewer) return sendJson(ctx, 401, { error: 'capability_required' })
  const path = normalizedDeploymentFetchPath(ctx.query.path ?? null)
  if (!path) return badRequest(ctx, 'path must be a safe absolute path')
  const rawMaxBytes = ctx.query.maxBytes
  const maxBytes = rawMaxBytes === undefined ? AGENT_FETCH_DEFAULT_MAX_BYTES : Number(rawMaxBytes)
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > AGENT_FETCH_MAX_BYTES) {
    return badRequest(ctx, `maxBytes must be an integer from 1 to ${AGENT_FETCH_MAX_BYTES}`)
  }
  void _deps
  return sendJson(ctx, 502, { error: 'upstream_unreachable' })
}

async function deploymentLogs(ctx: ApiRouteContext, deps: DeploymentDeps): Promise<unknown> {
  const viewer = ctx.actor?.id ?? null
  if (!viewer) return sendJson(ctx, 401, { error: 'capability_required' })
  const id = ctx.params.id
  if (!id) return notFound(ctx)
  const rawTail = ctx.query.tailLines
  const tailLines = rawTail === undefined ? LOGS_DEFAULT_TAIL_LINES : Number(rawTail)
  if (!Number.isInteger(tailLines) || tailLines < 1 || tailLines > LOGS_MAX_TAIL_LINES) {
    return badRequest(ctx, `tailLines must be an integer from 1 to ${LOGS_MAX_TAIL_LINES}`)
  }
  const result = await deps.deployments.logsFor(id, viewer, { tailLines })
  if (result.status !== 'ok') return sendJson(ctx, 404, { error: 'not_found' })
  if (result.logs === null) return { logs: null, message: 'no logs available for this deployment' }
  return { logs: result.logs }
}

async function deploymentGitUrl(ctx: ApiRouteContext): Promise<unknown> {
  return sendJson(ctx, 403, { error: 'forbidden', message: 'a git URL requires an agent capability token' })
}

async function deploymentOwnerUrl(ctx: ApiRouteContext, deps: DeploymentDeps): Promise<unknown> {
  const sub = ctx.actor?.id ?? ctx.query.principalId
  if (!sub) return sendJson(ctx, 403, { error: 'forbidden', message: 'an identified caller is required' })
  const id = ctx.params.id
  if (!id) return notFound(ctx)
  const deployment = await deps.deployments.getByIdOrName(id)
  if (!deployment) return sendJson(ctx, 404, { error: 'not_found' })
  const slug = deployment.name ?? deployment.id
  if (!deps.deployAppsDomain) {
    return sendJson(ctx, 503, {
      error: 'unavailable',
      message: `app subdomains are not configured — this app is reachable signed-in at /d/${slug}/; set DEPLOY_APPS_DOMAIN (with AWS_DEPLOY_GATE_SECRET) to enable per-app subdomains and live editing`,
    })
  }
  return sendJson(ctx, 503, { error: 'unavailable', message: 'deploy gate secret not configured' })
}

async function shareDeployment(ctx: ApiRouteContext): Promise<unknown> {
  void ctx
  return sendJson(ctx, 403, { error: 'forbidden', message: 'sharing requires an agent capability token' })
}

async function rollbackDeployment(ctx: ApiRouteContext, deps: DeploymentDeps): Promise<unknown> {
  const idParam = ctx.params.id
  if (!idParam) return notFound(ctx)
  const id = await resolveId(deps, idParam)
  if (!id) return sendJson(ctx, 404, { error: 'not_found' })
  if (!(await callerMayManage(ctx, deps, id))) return sendJson(ctx, 403, { error: 'forbidden' })
  const b = (ctx.body ?? {}) as { version?: unknown }
  if (typeof b.version !== 'number') return badRequest(ctx, 'version (number) required')
  try {
    await deps.deployments.rollback(id, b.version)
    return { ok: true }
  } catch (error) {
    return sendJson(ctx, 400, { error: 'rollback_failed', message: error instanceof Error ? error.message : String(error) })
  }
}

async function redeployDeployment(ctx: ApiRouteContext, deps: DeploymentDeps): Promise<unknown> {
  const idParam = ctx.params.id
  if (!idParam) return notFound(ctx)
  const id = await resolveId(deps, idParam)
  if (!id) return sendJson(ctx, 404, { error: 'not_found' })
  if (!(await callerMayManage(ctx, deps, id))) return sendJson(ctx, 403, { error: 'forbidden' })
  const b = (ctx.body ?? {}) as { entrypoint?: unknown; files?: unknown }
  if (typeof b.entrypoint !== 'string' || !Array.isArray(b.files)) {
    return badRequest(ctx, 'entrypoint (string) and files (array) required')
  }
  try {
    return { deployment: await deps.deployments.redeploy(id, { entrypoint: b.entrypoint, files: b.files }) }
  } catch (error) {
    return sendJson(ctx, 400, { error: 'deploy_failed', message: error instanceof Error ? error.message : String(error) })
  }
}

async function archiveDeployment(ctx: ApiRouteContext, deps: DeploymentDeps): Promise<unknown> {
  const idParam = ctx.params.id
  if (!idParam) return notFound(ctx)
  const id = await resolveId(deps, idParam)
  if (!id) return sendJson(ctx, 404, { error: 'not_found' })
  if (!(await callerMayManage(ctx, deps, id))) {
    return sendJson(ctx, 403, { error: 'forbidden', message: 'only someone who manages this app can archive it' })
  }
  try {
    await deps.deployments.archive(id)
    return { ok: true }
  } catch (error) {
    return sendJson(ctx, 400, { error: 'archive_failed', message: error instanceof Error ? error.message : String(error) })
  }
}

async function restoreDeployment(ctx: ApiRouteContext, deps: DeploymentDeps): Promise<unknown> {
  const idParam = ctx.params.id
  if (!idParam) return notFound(ctx)
  const id = await resolveId(deps, idParam)
  if (!id) return sendJson(ctx, 404, { error: 'not_found' })
  if (!(await callerMayManage(ctx, deps, id))) {
    return sendJson(ctx, 403, { error: 'forbidden', message: 'only someone who manages this app can restore it' })
  }
  try {
    return { deployment: { ...(await deps.deployments.restore(id)), permission: 'write' } }
  } catch (error) {
    return sendJson(ctx, 400, { error: 'restore_failed', message: error instanceof Error ? error.message : String(error) })
  }
}

async function renameDeployment(ctx: ApiRouteContext, deps: DeploymentDeps): Promise<unknown> {
  const idParam = ctx.params.id
  if (!idParam) return notFound(ctx)
  const id = await resolveId(deps, idParam)
  if (!id) return sendJson(ctx, 404, { error: 'not_found' })
  if (!(await callerMayManage(ctx, deps, id))) {
    return sendJson(ctx, 403, { error: 'forbidden', message: 'only someone who manages this app can rename it' })
  }
  const b = (ctx.body ?? {}) as { name?: unknown }
  if (typeof b.name !== 'string') return badRequest(ctx, 'name (string) required')
  try {
    return { deployment: await deps.deployments.rename(id, b.name) }
  } catch (error) {
    return sendJson(ctx, 400, { error: 'rename_failed', message: error instanceof Error ? error.message : String(error) })
  }
}

async function setDeploymentDisplayName(ctx: ApiRouteContext, deps: DeploymentDeps): Promise<unknown> {
  const idParam = ctx.params.id
  if (!idParam) return notFound(ctx)
  const id = await resolveId(deps, idParam)
  if (!id) return sendJson(ctx, 404, { error: 'not_found' })
  if (!(await callerMayManage(ctx, deps, id))) {
    return sendJson(ctx, 403, { error: 'forbidden', message: 'only someone who manages this app can rename it' })
  }
  const b = (ctx.body ?? {}) as { displayName?: unknown }
  if (typeof b.displayName !== 'string') return badRequest(ctx, 'displayName (string) required')
  try {
    return { deployment: await deps.deployments.setDisplayName(id, b.displayName) }
  } catch (error) {
    return sendJson(ctx, 400, { error: 'display_name_failed', message: error instanceof Error ? error.message : String(error) })
  }
}

export function deploymentRoutes(deps: DeploymentDeps): ReadonlyArray<Route> {
  return [
    { method: 'POST', path: '/v1/deployments', auth: 'source', handle: (ctx) => createDeployment(ctx, deps) },
    { method: 'GET', path: '/v1/deployments', auth: 'either', handle: (ctx) => listDeployments(ctx, deps) },
    { method: 'GET', path: '/v1/deployments/:id', auth: 'either', handle: (ctx) => getDeployment(ctx, deps) },
    { method: 'GET', path: '/v1/deployments/:id/fetch', auth: 'either', handle: (ctx) => fetchDeployment(ctx, deps) },
    { method: 'GET', path: '/v1/deployments/:id/logs', auth: 'either', handle: (ctx) => deploymentLogs(ctx, deps) },
    { method: 'GET', path: '/v1/deployments/:id/git-url', auth: 'either', handle: (ctx) => deploymentGitUrl(ctx) },
    { method: 'GET', path: '/v1/deployments/:id/owner-url', auth: 'source', handle: (ctx) => deploymentOwnerUrl(ctx, deps) },
    { method: 'POST', path: '/v1/deployments/:id/share', auth: 'either', handle: (ctx) => shareDeployment(ctx) },
    { method: 'POST', path: '/v1/deployments/:id/rollback', auth: 'source', handle: (ctx) => rollbackDeployment(ctx, deps) },
    { method: 'POST', path: '/v1/deployments/:id/redeploy', auth: 'source', handle: (ctx) => redeployDeployment(ctx, deps) },
    { method: 'POST', path: '/v1/deployments/:id/archive', auth: 'either', handle: (ctx) => archiveDeployment(ctx, deps) },
    { method: 'POST', path: '/v1/deployments/:id/restore', auth: 'either', handle: (ctx) => restoreDeployment(ctx, deps) },
    { method: 'POST', path: '/v1/deployments/:id/name', auth: 'either', handle: (ctx) => renameDeployment(ctx, deps) },
    { method: 'POST', path: '/v1/deployments/:id/display-name', auth: 'either', handle: (ctx) => setDeploymentDisplayName(ctx, deps) },
  ]
}
