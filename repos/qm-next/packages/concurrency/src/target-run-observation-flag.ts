/**
 * Phase 1 slice 1.5 — `target.run-observation` RolloutFlag.
 *
 * The flag is the only authoritative source of whether a Run is
 * written through the legacy write path (`runSource='legacy'`) or the
 * target write path (`runSource='target'`). The architecture gate
 * rejects new `target` rows that still carry the legacy `'done'`
 * literal; `assertTargetRunInvariant` enforces the same rule at
 * runtime.
 *
 * Linked ADRs: ADR-0001 (Run owns terminal events), ADR-0014
 * (observation redacts secrets in depth).
 */
import type { RolloutFlag, RolloutFlagRegistry, RunSource } from '@qm/types'

export const TARGET_RUN_OBSERVATION_FLAG_KEY = 'target.run-observation'
export const TARGET_RUN_OBSERVATION_ENV = 'QM_ROLLOUT_TARGET_RUN_OBSERVATION'

/**
 * Idempotent registration of the `target.run-observation` flag. The
 * default is `false`; the env override is
 * `QM_ROLLOUT_TARGET_RUN_OBSERVATION`. The owner and removal task are
 * recorded so the architecture gate can later detect when the flag
 * outlives its purpose (§Phase 7 cleanup).
 */
export function registerTargetRunObservationFlag(
  registry: RolloutFlagRegistry,
  opts: {
    /** Code owner (GitHub handle). Defaults to `@qm/core`. */
    owner?: string
    /** Default value when no env override is present. */
    default?: boolean
    /** Override env values keyed by `meta.envOverride`. Tests use this. */
    env?: Record<string, string | undefined>
  } = {},
): RolloutFlag {
  void opts.env // reserved for the registry implementation; nothing to do here.
  return registry.register({
    key: TARGET_RUN_OBSERVATION_FLAG_KEY,
    owner: opts.owner ?? '@qm/core',
    default: opts.default ?? false,
    envOverride: TARGET_RUN_OBSERVATION_ENV,
    removalTask: 'https://github.com/byteaide/qm-next/issues/new?template=rollout-flag-removal.md',
    introducedIn: 'phase-1-slice-1.5',
  })
}

/**
 * Map a flag read to the `runSource` literal the Run store must
 * stamp on freshly enqueued rows. The flag is read at write time —
 * no caching — so the architecture gate can flip the flag in
 * production by changing the env override.
 */
export function effectiveRunSource(flag: RolloutFlag | null | undefined): RunSource {
  return flag && flag.read() ? 'target' : 'legacy'
}

/**
 * Read the effective run source from a registry without forcing the
 * caller to know the flag key. Returns `'legacy'` when the registry
 * has not registered the flag yet — this is the conservative default
 * and matches the Phase 0 freeze.
 */
export function resolveRunSource(registry: RolloutFlagRegistry): RunSource {
  const flag = registry.get(TARGET_RUN_OBSERVATION_FLAG_KEY)
  return effectiveRunSource(flag)
}