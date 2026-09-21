/**
 * /v1/surface-config, /v1/runtime-config, /v1/channel-header-pin — qm's
 * web model/harness selection surface. The body composition mirrors
 * repos/qm/src/api/routes/surface.ts (runtimeConfigBody and friends) over
 * the lane-A runtime-config store; provider-key availability is
 * all-available until model credentials land with the control plane.
 */
import { parseScopeId } from '@qm/types'
import {
  builtInModelCatalog,
  defaultModelForHarness,
  FAST_MODE_MODEL_IDS,
  isHarnessId,
  modelSupportedByHarness,
  selectableCatalogForHarness,
  THINKING_LEVELS,
} from '../services/model-catalog.ts'
import type { RuntimeConfigStore } from '../services/runtime-config-store.ts'
import { badRequest, isObj, sendJson, type ApiRouteContext, type Route } from './framework.ts'

export interface SurfaceConfigValue {
  webuiModels?: string[]
  baseModel?: string
  harnessId?: string
  externalSlackParticipants?: string[]
  branding?: { accent?: string; mark?: string; selfLabel?: string; orgName?: string }
}

export interface ConfigDeps {
  config: RuntimeConfigStore
  surfaceConfig?: SurfaceConfigValue
}

function runtimeTarget(ctx: ApiRouteContext): { actorId: string; scope: string } | null {
  const b = isObj(ctx.body) ? ctx.body : {}
  const actorId = typeof b.principalId === 'string' && b.principalId ? b.principalId : (ctx.query.principalId ?? '')
  const scopeRaw = typeof b.scopeId === 'string' && b.scopeId ? b.scopeId : (ctx.query.scopeId ?? ctx.query.scope ?? '')
  if (!actorId || !scopeRaw) return null
  const parsed = parseScopeId(scopeRaw)
  if (parsed.kind === 'personal' && parsed.ref === actorId) return { actorId, scope: scopeRaw }
  if (parsed.kind !== null && parsed.kind !== 'org') return { actorId, scope: scopeRaw }
  return null
}

async function getSurfaceConfig(ctx: ApiRouteContext, deps: ConfigDeps): Promise<unknown> {
  void ctx
  if (!deps.surfaceConfig) return sendJson(ctx, 404, { error: 'not_found' })
  const cfg = deps.surfaceConfig
  const harnessId = cfg.harnessId ?? 'pi'
  const catalog = builtInModelCatalog()
  const allowed = selectableCatalogForHarness(catalog, harnessId).map((model) => model.id)
  const configuredPicker = cfg.webuiModels?.filter((id) => modelSupportedByHarness(id, harnessId)) ?? []
  const resolvedBase = modelSupportedByHarness(cfg.baseModel, harnessId) ? cfg.baseModel! : defaultModelForHarness(harnessId)
  const branding = cfg.branding ?? {}
  const resolvedBranding = {
    ...(branding.accent ? { accent: branding.accent } : {}),
    ...(branding.mark ? { mark: branding.mark } : {}),
    ...(branding.selfLabel ? { selfLabel: branding.selfLabel } : {}),
    ...(branding.orgName ? { orgName: branding.orgName } : {}),
  }
  return {
    webuiModels: configuredPicker.length ? configuredPicker : allowed,
    baseModel: resolvedBase,
    harnessId,
    externalSlackParticipants: cfg.externalSlackParticipants ?? [],
    ...(Object.keys(resolvedBranding).length ? { branding: resolvedBranding } : {}),
  }
}

async function runtimeConfigBody(ctx: ApiRouteContext, deps: ConfigDeps, scope: string): Promise<Record<string, unknown>> {
  void ctx
  const config = deps.config
  const fallbackHarness = isHarnessId(deps.surfaceConfig?.harnessId) ? deps.surfaceConfig!.harnessId! : 'pi'
  const fallback = { harnessId: fallbackHarness, modelId: defaultModelForHarness(fallbackHarness, deps.surfaceConfig?.baseModel) }
  const approvedHarnesses = ((await config.getApprovedHarnesses()) ?? [fallback.harnessId]).filter(isHarnessId)
  const firstApproved = approvedHarnesses[0] ?? fallback.harnessId
  const safeFallback =
    approvedHarnesses.includes(fallback.harnessId) && modelSupportedByHarness(fallback.modelId, fallback.harnessId)
      ? fallback
      : { harnessId: firstApproved, modelId: defaultModelForHarness(firstApproved, fallback.modelId) }
  const catalog = builtInModelCatalog()
  const org = 'org:default'
  const orgStored = await config.getRuntimeSelection(org)
  const orgDefault: { harnessId: string; modelId: string; effortLevel?: string; fastMode?: boolean; revision: number } =
    orgStored &&
    isHarnessId(orgStored.harnessId) &&
    approvedHarnesses.includes(orgStored.harnessId) &&
    modelSupportedByHarness(orgStored.modelId, orgStored.harnessId)
      ? {
          harnessId: orgStored.harnessId,
          modelId: orgStored.modelId,
          ...(orgStored.effortLevel ? { effortLevel: orgStored.effortLevel } : {}),
          ...(typeof orgStored.fastMode === 'boolean' ? { fastMode: orgStored.fastMode } : {}),
          revision: orgStored.revision ?? 0,
        }
      : { ...safeFallback, revision: 0 }
  const stored = scope === org ? orgStored : await config.getRuntimeSelection(scope)
  const scopeOverride: { harnessId: string; modelId: string; effortLevel?: string; fastMode?: boolean; orgRevision?: number } | null =
    stored && scope !== org
      ? isHarnessId(stored.harnessId) &&
        approvedHarnesses.includes(stored.harnessId) &&
        modelSupportedByHarness(stored.modelId, stored.harnessId)
        ? {
            harnessId: stored.harnessId,
            modelId: stored.modelId,
            ...(stored.effortLevel ? { effortLevel: stored.effortLevel } : {}),
            ...(typeof stored.fastMode === 'boolean' ? { fastMode: stored.fastMode } : {}),
            ...(stored.orgRevision !== undefined ? { orgRevision: stored.orgRevision } : {}),
          }
        : null
      : null
  const effective = scopeOverride ?? orgDefault
  const selected = [orgDefault, scopeOverride, effective].filter((choice) => choice !== null)
  const allowlist = await config.getWebuiModels(scope)
  const modelsByHarness = Object.fromEntries(
    approvedHarnesses.map((harnessId) => {
      const ids = allowlist?.length
        ? allowlist.filter((id) => modelSupportedByHarness(id, harnessId))
        : selectableCatalogForHarness(catalog, harnessId).map((model) => model.id)
      for (const choice of selected) {
        if (choice.harnessId === harnessId && modelSupportedByHarness(choice.modelId, harnessId) && !ids.includes(choice.modelId)) {
          ids.push(choice.modelId)
        }
      }
      return [harnessId, ids]
    }),
  )
  const advertisedModelIds = new Set(Object.values(modelsByHarness).flat())
  const modelCatalog = Object.fromEntries(
    [...advertisedModelIds].map((id) => {
      const model = catalog.find((candidate) => candidate.id === id)
      return [id, { name: model?.name ?? id, provider: model?.provider ?? 'anthropic' }]
    }),
  )
  return {
    scopeId: scope,
    approvedHarnesses,
    modelsByHarness,
    modelCatalog,
    orgDefault,
    scopeOverride,
    effective: {
      harnessId: effective.harnessId,
      modelId: effective.modelId,
      ...(effective.effortLevel ? { effortLevel: effective.effortLevel } : {}),
      ...(typeof effective.fastMode === 'boolean' ? { fastMode: effective.fastMode } : {}),
    },
    upgradeAvailable: Boolean(scopeOverride && scopeOverride.orgRevision !== orgDefault.revision),
    fastModeModelIds: FAST_MODE_MODEL_IDS,
    interactiveFastMode: await config.getInteractiveFastMode(),
  }
}

async function getRuntimeConfig(ctx: ApiRouteContext, deps: ConfigDeps): Promise<unknown> {
  const target = runtimeTarget(ctx)
  if (!target) return sendJson(ctx, 403, { error: 'forbidden' })
  return runtimeConfigBody(ctx, deps, target.scope)
}

async function putRuntimeConfig(ctx: ApiRouteContext, deps: ConfigDeps): Promise<unknown> {
  if (!isObj(ctx.body)) return sendJson(ctx, 400, { error: 'bad_request' })
  const target = runtimeTarget(ctx)
  if (!target) return sendJson(ctx, 403, { error: 'forbidden' })
  const config = deps.config
  const b = ctx.body as Record<string, unknown>
  const fallbackHarness = isHarnessId(deps.surfaceConfig?.harnessId) ? deps.surfaceConfig!.harnessId! : 'pi'
  const fallback = { harnessId: fallbackHarness, modelId: defaultModelForHarness(fallbackHarness, deps.surfaceConfig?.baseModel) }
  if (b.inherit === true) {
    await config.setRuntimeSelection(target.scope, null)
  } else if (b.keep === true) {
    await config.acknowledgeRuntimeSelection(target.scope)
  } else {
    const approved = (await config.getApprovedHarnesses()) ?? [fallback.harnessId]
    const harnessId = b.harnessId
    if (!isHarnessId(harnessId) || !approved.includes(harnessId)) {
      return sendJson(ctx, 400, { error: 'harness_not_approved' })
    }
    const modelId = b.modelId
    if (typeof modelId !== 'string' || !modelSupportedByHarness(modelId, harnessId)) {
      return sendJson(ctx, 400, { error: 'model_not_supported' })
    }
    const allowlist = await config.getWebuiModels(target.scope)
    if (allowlist?.length && !allowlist.includes(modelId)) {
      return sendJson(ctx, 400, { error: 'model_not_enabled' })
    }
    const effortLevel = b.effortLevel ?? 'auto'
    if (typeof effortLevel !== 'string' || !(THINKING_LEVELS as readonly string[]).includes(effortLevel)) {
      return sendJson(ctx, 400, { error: 'effort_not_supported' })
    }
    const fastMode = b.fastMode ?? false
    if (typeof fastMode !== 'boolean') return sendJson(ctx, 400, { error: 'fast_mode_invalid' })
    await config.setRuntimeSelection(target.scope, {
      harnessId,
      modelId,
      effortLevel,
      fastMode: fastMode && FAST_MODE_MODEL_IDS.includes(modelId),
    })
  }
  return runtimeConfigBody(ctx, deps, target.scope)
}

async function getChannelHeaderPin(ctx: ApiRouteContext, deps: ConfigDeps): Promise<unknown> {
  const target = runtimeTarget(ctx)
  if (!target) return sendJson(ctx, 403, { error: 'forbidden' })
  const [on, configured, def] = await Promise.all([
    deps.config.getChannelHeaderPin(target.scope),
    deps.config.getChannelHeaderPinOverride(target.scope),
    deps.config.getChannelHeaderPinDefault(),
  ])
  return { scopeId: target.scope, on, configured, default: def }
}

async function putChannelHeaderPin(ctx: ApiRouteContext, deps: ConfigDeps): Promise<unknown> {
  if (!isObj(ctx.body)) return sendJson(ctx, 400, { error: 'bad_request' })
  const target = runtimeTarget(ctx)
  if (!target) return sendJson(ctx, 403, { error: 'forbidden' })
  const on = (ctx.body as Record<string, unknown>).on
  if (typeof on !== 'boolean' && on !== null) {
    return badRequest(ctx, 'expected { on: boolean | null } (null reverts to the org default)')
  }
  await deps.config.setChannelHeaderPin(target.scope, on)
  return {
    scopeId: target.scope,
    on: on ?? (await deps.config.getChannelHeaderPinDefault()),
    configured: on,
  }
}

export function surfaceConfigRoutes(deps: ConfigDeps): ReadonlyArray<Route> {
  return [
    { method: 'GET', path: '/v1/surface-config', auth: 'source', handle: (ctx) => getSurfaceConfig(ctx, deps) },
    { method: 'GET', path: '/v1/runtime-config', auth: 'either', handle: (ctx) => getRuntimeConfig(ctx, deps) },
    { method: 'PUT', path: '/v1/runtime-config', auth: 'either', handle: (ctx) => putRuntimeConfig(ctx, deps) },
    { method: 'GET', path: '/v1/channel-header-pin', auth: 'either', handle: (ctx) => getChannelHeaderPin(ctx, deps) },
    { method: 'PUT', path: '/v1/channel-header-pin', auth: 'either', handle: (ctx) => putChannelHeaderPin(ctx, deps) },
  ]
}
