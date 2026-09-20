/**
 * Phase 5 slice 5.4 wiring — `target.im-intake` RolloutFlag.
 *
 * The flag is the only authoritative source of whether IM intake flows
 * through the durable Intake Inbox + fan-out (target path) or the legacy
 * direct bridge sink. Reading a rollout flag from anywhere other than
 * the registered RolloutFlag port is an architecture violation (§Phase 0
 * boundary checks); this module registers the flag through the port and
 * exposes a resolver, mirroring the Phase 1 `target.run-observation`
 * pattern.
 *
 * Linked ADRs: ADR-0008 (IM intake is durable fan-out), ADR-0015
 * (IM subscribers have independent cursors).
 */
import type { RolloutFlag, RolloutFlagRegistry } from '@qm/types'

export const TARGET_IM_INTAKE_FLAG_KEY = 'target.im-intake'
export const TARGET_IM_INTAKE_ENV = 'QM_ROLLOUT_TARGET_IM_INTAKE'

/**
 * Idempotent registration of the `target.im-intake` flag. The default
 * is `false` (legacy direct-sink path stays authoritative until cutover);
 * the env override is `QM_ROLLOUT_TARGET_IM_INTAKE`. Owner and removal
 * task are recorded so the architecture gate can detect when the flag
 * outlives its purpose (§Phase 7 cleanup: "Remove temporary rollout
 * flags after their cutover gate passes").
 */
export function registerTargetImIntakeFlag(
  registry: RolloutFlagRegistry,
  opts: {
    /** Code owner (GitHub handle). Defaults to `@qm/core`. */
    owner?: string
    /** Default value when no env override is present. */
    default?: boolean
  } = {},
): RolloutFlag {
  return registry.register({
    key: TARGET_IM_INTAKE_FLAG_KEY,
    owner: opts.owner ?? '@qm/core',
    default: opts.default ?? false,
    envOverride: TARGET_IM_INTAKE_ENV,
    removalTask: 'https://github.com/byteaide/qm-next/issues/new?template=rollout-flag-removal.md',
    introducedIn: 'phase-5-slice-5.4',
  })
}

/**
 * Read the effective target-im-intake switch from a registry without
 * forcing the caller to know the flag key. Returns `false` when the
 * registry has not registered the flag yet — the conservative default
 * that keeps the legacy path authoritative.
 */
export function resolveTargetImIntake(registry: RolloutFlagRegistry): boolean {
  return registry.get(TARGET_IM_INTAKE_FLAG_KEY)?.read() ?? false
}
