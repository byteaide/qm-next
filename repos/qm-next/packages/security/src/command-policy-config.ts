/**
 * Slice 2.2 — Production Command Policy configuration.
 *
 * ADR-0002: a production deployment MUST explicitly select its policy
 * at startup; a missing production policy is a startup error, not a
 * silent allow. The built-in `default-denylist` is the minimum
 * Baseline Policy and may be tightened to an allowlist.
 *
 * The `QM_COMMAND_POLICY` env var names the active policy id. When
 * absent in production, startup fails. When present but not
 * registered, startup fails. Operator tightening is achieved by
 * registering additional policies at startup before calling
 * `setActive`.
 *
 * Linked ADRs: 0002 (Command Policy is a production invariant).
 */
import {
  BASELINE_DENY_POLICY_ID,
} from './policies/default-denylist.ts'
import {
  CommandPolicyNotConfigured,
  type CommandPolicyRegistry,
} from './command-policy.ts'
import {
  registerDefaultPolicies,
  type CreateCommandGateOptions,
} from './command-gate.ts'
import {
  createCommandGate,
} from './command-gate.ts'
import type { CommandGate, CommandPolicyId } from '@qm/types'

/** Env var that names the active production policy. */
export const QM_COMMAND_POLICY_ENV = 'QM_COMMAND_POLICY'

/** Convenience: the canonical default policy id for production. */
export const PRODUCTION_DEFAULT_POLICY_ID: CommandPolicyId = BASELINE_DENY_POLICY_ID

export interface ConfigureProductionCommandPolicyOptions {
  /** Override env values keyed by `QM_COMMAND_POLICY`. Used in tests. */
  env?: Record<string, string | undefined>
  /**
   * Whether the call is for production startup. When `true` (default),
   * a missing `QM_COMMAND_POLICY` is an error. When `false`, the helper
   * falls back to the production default without throwing — used in
   * dev / local-only profiles where the policy is implicit.
   */
  production?: boolean
  /**
   * Limit which built-in policies are registered (operator tightening:
   * e.g. `['baseline-deny']` leaves the allowlist unregistered so a
   * direct evaluate against it fails closed).
   */
  policies?: ReadonlyArray<'baseline-deny' | 'default-denylist' | 'allowlist'>
  /** Optional gate options (e.g. `requestIdAllocator`). */
  gateOptions?: CreateCommandGateOptions
}

/**
 * Configure a `CommandPolicyRegistry` for production and return a
 * `CommandGate` ready to evaluate requests.
 *
 * Behavior:
 *   - Registers the built-in policies via `registerDefaultPolicies`.
 *   - Reads `QM_COMMAND_POLICY` from `env` (or `process.env`).
 *   - When the env var is unset:
 *       - production=true  → throws `CommandPolicyNotConfigured`.
 *       - production=false → uses `PRODUCTION_DEFAULT_POLICY_ID`.
 *   - When the env var names an unknown policy id → throws.
 *   - When the env var names a known policy id → calls `setActive`.
 *   - Always calls `assertProductionConfigured()` so the runtime
 *     cannot silently fall back to a no-policy state.
 */
export function configureProductionCommandPolicy(
  registry: CommandPolicyRegistry,
  opts: ConfigureProductionCommandPolicyOptions = {},
): CommandGate {
  const production = opts.production ?? true
  registerDefaultPolicies(registry, { ...(opts.policies ? { policies: opts.policies } : {}) })
  const env = opts.env ?? (typeof process !== 'undefined' && process.env ? (process.env as Record<string, string | undefined>) : {})
  const policyIdRaw = env[QM_COMMAND_POLICY_ENV]
  const policyId = policyIdRaw && policyIdRaw.length > 0 ? policyIdRaw : null
  if (policyId === null) {
    if (production) {
      throw new CommandPolicyNotConfigured(
        `${QM_COMMAND_POLICY_ENV} is not set — production startup must explicitly select a Command Policy (e.g. '${PRODUCTION_DEFAULT_POLICY_ID}')`,
      )
    }
    registry.setActive(PRODUCTION_DEFAULT_POLICY_ID)
  } else {
    registry.setActive(policyId as CommandPolicyId)
  }
  registry.assertProductionConfigured()
  return createCommandGate(registry, opts.gateOptions ?? {})
}