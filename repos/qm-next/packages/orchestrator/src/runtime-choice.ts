/**
 * Config-driven runtime choice: which engine and model a turn uses, resolved
 * from the deployment's routing config (approved harnesses, per-scope
 * overrides, per-turn requests) against the model support matrix. Ported
 * from qm's harness-router resolution ladder onto a plain config object; the
 * config itself arrives through the cordis profile (composition root).
 */
import { defaultModelForHarness, isHarnessId, modelSupportedByHarness } from '@qm/model'
import { NonRetryableTurnError } from '@qm/types'

export interface RuntimeRouteTarget {
  harness?: string
  model?: string
}

export interface RuntimeRouteConfig {
  /** Harness ids a turn may resolve to; unlisted ids are refused. */
  approved?: string[]
  /** Deployment-wide default engine/model. */
  default?: RuntimeRouteTarget
  /** Per-scope overrides keyed by ScopeId. */
  scopes?: Record<string, RuntimeRouteTarget>
}

export interface RuntimeChoice {
  harnessId: string
  modelId: string
}

export interface ResolveRuntimeChoiceOptions {
  registered: readonly string[]
  scope: string
  orgScope?: string
  fallback: RuntimeChoice
  requested?: RuntimeRouteTarget
}

export function resolveRuntimeChoice(config: RuntimeRouteConfig, opts: ResolveRuntimeChoiceOptions): RuntimeChoice {
  const { registered, scope, orgScope, fallback, requested } = opts
  const known = (id: string | undefined): id is string =>
    typeof id === 'string' && (isHarnessId(id) as boolean) && registered.includes(id)
  const approved = (config.approved ?? [fallback.harnessId]).filter((id) => known(id) || registered.includes(id))
  const firstApproved = approved.find((id) => known(id)) ?? fallback.harnessId
  const safeFallback: RuntimeChoice =
    approved.includes(fallback.harnessId) && modelSupportedByHarness(fallback.modelId, fallback.harnessId)
      ? fallback
      : { harnessId: firstApproved, modelId: defaultModelForHarness(firstApproved, fallback.modelId) }
  const configuredDefault = config.default
  const configuredOrg: RuntimeChoice =
    configuredDefault && known(configuredDefault.harness)
      ? { harnessId: configuredDefault.harness!, modelId: configuredDefault.model ?? fallback.modelId }
      : { harnessId: fallback.harnessId, modelId: configuredDefault?.model ?? fallback.modelId }
  const org =
    approved.includes(configuredOrg.harnessId) && modelSupportedByHarness(configuredOrg.modelId, configuredOrg.harnessId)
      ? configuredOrg
      : safeFallback
  const scoped = scope !== orgScope && opts.scope !== undefined ? config.scopes?.[scope] : undefined
  let inherited = org
  if (scoped && known(scoped.harness)) {
    inherited = { harnessId: scoped.harness!, modelId: scoped.model ?? org.modelId }
  } else if (scoped?.model) {
    inherited = { harnessId: fallback.harnessId, modelId: scoped.model }
  }
  const choice: RuntimeChoice =
    requested?.harness || requested?.model
      ? { harnessId: requested.harness ?? inherited.harnessId, modelId: requested.model ?? inherited.modelId }
      : inherited
  if (!approved.includes(choice.harnessId) || !modelSupportedByHarness(choice.modelId, choice.harnessId)) {
    if (requested?.harness || requested?.model)
      throw new NonRetryableTurnError(`runtime ${choice.harnessId}/${choice.modelId} is not approved`)
    return org
  }
  return choice
}
