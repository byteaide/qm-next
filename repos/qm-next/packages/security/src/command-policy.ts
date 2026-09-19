/**
 * Slice 2.1 — CommandPolicy: the rules engine behind `CommandGate`.
 *
 * ADR-0002: a production deployment MUST explicitly select its policy at
 * startup; the built-in `default-denylist` is the minimum Baseline
 * Policy and may be tightened to an allowlist. The registry is the
 * only authoritative source — `CommandGate` resolves `policyId` here.
 *
 * A CommandPolicy NEVER raises on a deny decision. Deny is one of
 * three explicit outcomes (`allow` / `deny` / `require_approval`).
 * Collapsing a deny into an exit code is a Phase 0 architecture
 * boundary violation.
 *
 * Linked ADRs: 0002 (Command Policy is a production invariant).
 */
import type {
  CommandDecision,
  CommandPolicyId,
  CommandRequest,
} from '@qm/types'

/** Hook for policies that need the wall-clock; injected so tests stay
 *  deterministic. */
export interface CommandPolicyContext {
  /** Optional wall-clock now-ms; default `Date.now()`. */
  now?: number
}

/**
 * Pure rules engine. Implementation MAY be sync or async (some policies
 * consult an external service); `CommandGate` always awaits.
 *
 * Policies MUST NOT mutate the request; the `requestId` is allocated by
 * `CommandGate` and survives the approval round-trip (slice 2.3).
 */
export interface CommandPolicy {
  readonly id: CommandPolicyId
  /** Stable display name for audit logs. */
  readonly displayName: string
  /**
   * Evaluate the request. Returning `deny` MUST be done by emitting a
   * structured decision; throwing here is reserved for malformed
   * inputs (missing fields, unknown command class).
   */
  evaluate(request: CommandRequest, ctx?: CommandPolicyContext): CommandDecision | Promise<CommandDecision>
}

/**
 * In-process CommandPolicy registry. The construction site registers
 * exactly one production policy via `register()`; `assertProductionConfigured`
 * throws when the registry is empty at startup (ADR-0002 §2.2).
 */
export interface CommandPolicyRegistry {
  /** Register a policy. Throws on duplicate `id`. */
  register(policy: CommandPolicy): CommandPolicy
  /** Resolve a policy by id; null when missing. */
  get(id: CommandPolicyId): CommandPolicy | null
  /** Enumerate registered policies (used by the architecture gate). */
  list(): readonly CommandPolicy[]
  /** Read the policy id selected at startup. */
  activeId(): CommandPolicyId | null
  /** Set the active policy id; throws when the policy is not registered. */
  setActive(id: CommandPolicyId): void
  /**
   * Slice 2.2 — assert that a policy is registered. Production startup
   * MUST call this; the runtime must NOT silently fall back to a
   * default when configuration is absent.
   */
  assertProductionConfigured(): CommandPolicy
}

/** Sentinel error for missing / unconfigured production policy. */
export class CommandPolicyNotConfigured extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommandPolicyNotConfigured'
  }
}

export function createCommandPolicyRegistry(): CommandPolicyRegistry {
  const policies = new Map<CommandPolicyId, CommandPolicy>()
  let active: CommandPolicyId | null = null

  return {
    register(policy) {
      if (policies.has(policy.id)) {
        throw new Error(`CommandPolicy '${policy.id}' already registered`)
      }
      policies.set(policy.id, policy)
      return policy
    },
    get(id) {
      return policies.get(id) ?? null
    },
    list() {
      return [...policies.values()]
    },
    activeId() {
      return active
    },
    setActive(id) {
      const policy = policies.get(id)
      if (!policy) throw new CommandPolicyNotConfigured(`unknown CommandPolicy '${id}'`)
      active = id
    },
    assertProductionConfigured() {
      if (policies.size === 0) {
        throw new CommandPolicyNotConfigured(
          'CommandPolicy registry is empty — production startup must explicitly register a policy',
        )
      }
      const id = active ?? policies.keys().next().value
      if (id === undefined) {
        throw new CommandPolicyNotConfigured(
          'CommandPolicy registry has no resolvable id — call setActive(id) at startup',
        )
      }
      const policy = policies.get(id)
      if (!policy) throw new CommandPolicyNotConfigured(`active CommandPolicy '${id}' not registered`)
      return policy
    },
  }
}