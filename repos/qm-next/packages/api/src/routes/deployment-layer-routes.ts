/**
 * /v1/deployment-layer — the deployment CLI's tools/skills bundle lane
 * (qm deployment-layer.ts, verbatim status ladder: 200 applied, 202
 * degraded on persistence failure, 400 invalid_deployment_layer).
 */
import type { DeploymentLayerBundle, DeploymentLayerStore } from '../services/deployment-layer-store.ts'
import { isObj, sendJson, type ApiRouteContext, type Route } from './framework.ts'

export interface DeploymentLayerDeps {
  deploymentLayer: DeploymentLayerStore
}

function bundleFrom(body: unknown): DeploymentLayerBundle | null {
  if (!isObj(body) || body.contract !== 1 || !Array.isArray(body.tools) || !Array.isArray(body.skills)) return null
  return body as unknown as DeploymentLayerBundle
}

async function getDeploymentLayer(ctx: ApiRouteContext, deps: DeploymentLayerDeps): Promise<unknown> {
  void ctx
  const record = await deps.deploymentLayer.get()
  if (!record) {
    const live = deps.deploymentLayer.live()
    return { contract: 1, version: 0, contentHash: null, source: live.source, resolved: live.resolved }
  }
  const live = deps.deploymentLayer.live()
  return {
    contract: 1,
    version: record.version,
    contentHash: record.contentHash,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
    status: (await deps.deploymentLayer.isApplied(record.contentHash)) ? 'applied' : 'degraded',
    runtimeContentHash: live.contentHash,
    source: live.source,
    bundle: record.bundle,
    resolved: live.resolved,
  }
}

async function putDeploymentLayer(ctx: ApiRouteContext, deps: DeploymentLayerDeps): Promise<unknown> {
  const bundle = bundleFrom(ctx.body)
  if (!bundle) return sendJson(ctx, 400, { error: 'bad_request', message: 'contract: 1, tools[], and skills[] required' })
  const updatedBy = 'source-authenticated deployment CLI'
  try {
    const record = await deps.deploymentLayer.put(bundle, updatedBy)
    return {
      ok: true,
      version: record.version,
      contentHash: record.contentHash,
      durable: deps.deploymentLayer.durable,
      resolved: record.resolved,
    }
  } catch (error) {
    return sendJson(ctx, 400, {
      error: 'invalid_deployment_layer',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

export function deploymentLayerRoutes(deps: DeploymentLayerDeps): ReadonlyArray<Route> {
  return [
    { method: 'GET', path: '/v1/deployment-layer', auth: 'source', handle: (ctx) => getDeploymentLayer(ctx, deps) },
    { method: 'PUT', path: '/v1/deployment-layer', auth: 'source', handle: (ctx) => putDeploymentLayer(ctx, deps) },
  ]
}
