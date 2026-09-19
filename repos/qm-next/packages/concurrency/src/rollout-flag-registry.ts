/**
 * RolloutFlagRegistry: the only authoritative source of rollout flags.
 *
 * Reading a rollout flag from anywhere other than this port is an
 * architecture violation (§Phase 0 boundary checks). The registry is
 * constructed at startup; tests construct their own registry with
 * deterministic defaults so the contract suite can assert flag
 * behavior bit-identically.
 *
 * Linked ADRs: ADR-0001 (RolloutFlag as a typed port).
 */
import type { RolloutFlag, RolloutFlagMeta, RolloutFlagRegistry } from '@qm/types'

export function createRolloutFlagRegistry(opts?: {
  /** Override env values keyed by `meta.envOverride`. Used in tests. */
  env?: Record<string, string | undefined>
}): RolloutFlagRegistry {
  const flags = new Map<string, RolloutFlag>()
  const env = opts?.env ?? {}

  function effective(meta: RolloutFlagMeta): boolean {
    if (meta.envOverride && meta.envOverride in env) {
      const raw = env[meta.envOverride]
      return raw === '1' || raw === 'true'
    }
    return meta.default
  }

  return {
    register(meta) {
      if (flags.has(meta.key)) {
        throw new Error(`RolloutFlag '${meta.key}' already registered`)
      }
      const flag: RolloutFlag = {
        key: meta.key,
        read: () => effective(meta),
        meta: () => ({ ...meta }),
      }
      flags.set(meta.key, flag)
      return flag
    },
    get(key) {
      return flags.get(key) ?? null
    },
    list() {
      return [...flags.values()]
    },
  }
}
