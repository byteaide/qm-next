/**
 * HarnessRegistry implementation: named harnesses registered explicitly; an
 * optional deployment-configured default id resolves bare requests. With
 * `routes` present, resolve() gains qm's config-driven runtime choice
 * (approved harnesses, per-scope/per-model overrides, per-turn requests)
 * including session-keyed engine-switch resets. No platform-derived default
 * exists anywhere.
 */
import type { Harness, HarnessRegistry, ScopeId } from '@qm/types'
import { isHarnessId, modelSupportedByHarness } from '@qm/model'
import {
  resolveRuntimeChoice,
  type ResolveRuntimeChoiceOptions,
  type RuntimeChoice,
  type RuntimeRouteConfig,
  type RuntimeRouteTarget,
} from './runtime-choice.ts'

export interface HarnessRouterOptions {
  defaultId?: string
  /** Deployment routing config; per-scope/per-model engine choice. */
  routes?: RuntimeRouteConfig
  /** Org scope used to distinguish deployment defaults from scope overrides. */
  orgScope?: ScopeId
  /** Model id used when no routing config names one. */
  fallbackModelId?: string
}

export interface ConfiguredHarnessRegistry extends HarnessRegistry {
  resolveChoice(
    sessionKey: string,
    scope: ScopeId,
    requested?: RuntimeRouteTarget,
  ): RuntimeChoice
}

export function createHarnessRouter(opts: HarnessRouterOptions = {}): ConfiguredHarnessRegistry {
  const byId = new Map<string, Harness>()
  const lastHarness = new Map<string, string>()
  const fallbackChoice = (): RuntimeChoice => {
    const defaultId = opts.defaultId ?? [...byId.keys()][0]
    if (!defaultId) throw new Error('no harness registered')
    return {
      harnessId: defaultId,
      modelId: opts.fallbackModelId ?? defaultId,
    }
  }
  return {
    register(harness) {
      byId.set(harness.profile.id, harness)
    },
    get(id) {
      return byId.get(id)
    },
    ids() {
      return [...byId.keys()]
    },
    resolve(id) {
      const effective = id ?? opts.defaultId
      if (!effective) throw new Error('no harness id requested and no default harness configured')
      const harness = byId.get(effective)
      if (!harness) throw new Error(`unknown harness: ${effective}`)
      return harness
    },
    resolveChoice(sessionKey, scope, requested) {
      const fallback = fallbackChoice()
      if (!opts.routes) {
        const harnessId = requested?.harness ?? opts.defaultId ?? fallback.harnessId
        return { harnessId, modelId: requested?.model ?? fallback.modelId }
      }
      const choice = resolveRuntimeChoice(opts.routes, {
        registered: [...byId.keys()],
        scope,
        ...(opts.orgScope ? { orgScope: opts.orgScope } : {}),
        fallback,
        ...(requested?.harness || requested?.model ? { requested } : {}),
      } satisfies ResolveRuntimeChoiceOptions)
      const prior = lastHarness.get(sessionKey)
      if (prior && prior !== choice.harnessId && isHarnessId(prior)) {
        void byId.get(prior)?.turns.resetSession?.(sessionKey)
        void byId.get(choice.harnessId)?.turns.resetSession?.(sessionKey)
      }
      if (modelSupportedByHarness(choice.modelId, choice.harnessId)) lastHarness.set(sessionKey, choice.harnessId)
      return choice
    },
  }
}
