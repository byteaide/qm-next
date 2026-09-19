/**
 * Slice 2.1 — CommandGate runtime implementation.
 *
 * The `CommandGate` port is defined in
 * `@qm/types/command-gate.ts`; this module is the in-process twin that
 * resolves a `policyId` against the `CommandPolicyRegistry` and
 * delegates the actual decision to the registered policy.
 *
 * Production startup wiring:
 *
 * ```ts
 * const registry = createCommandPolicyRegistry()
 * registerDefaultPolicies(registry)
 * registry.setActive('baseline-deny')
 * registry.assertProductionConfigured()
 * const gate = createCommandGate(registry)
 * ```
 *
 * ADR-0002: a missing production policy is a startup error, not a
 * silent allow. `createCommandGate` does NOT verify configuration —
 * the caller wires `assertProductionConfigured()` into startup.
 *
 * Linked ADRs: 0002 (Command Policy is a production invariant).
 */
import type {
  CommandDecision,
  CommandGate,
  CommandPolicyId,
  CommandRequest,
} from '@qm/types'
import { randomUUID } from 'node:crypto'
import { CommandPolicyNotConfigured, type CommandPolicyRegistry } from './command-policy.ts'
import { createAllowlistPolicy } from './policies/allowlist.ts'
import { createDefaultDenylistPolicy, createDefaultDenylistPolicyAlias } from './policies/default-denylist.ts'
import { bumpCommandGateDecision } from '@qm/runs'

export interface CreateCommandGateOptions {
  /** Optional allocator for `requestId` (test injection). Default
   *  `randomUUID`. The id must be stable across the approval
   *  round-trip — slice 2.3 ties `ApprovalRequest` to it. */
  requestIdAllocator?: () => string
}

/**
 * Allocate a stable `requestId`. The id must survive the gate →
 * approval round-trip so the approval consumer can resume the same
 * command. `randomUUID` is sufficient in production; tests inject a
 * deterministic allocator.
 */
function defaultRequestIdAllocator(): string {
  return randomUUID()
}

/**
 * Resolve a `CommandDecision` for a `CommandRequest`. The returned
 * decision has `requestId === request.id` — the gate does not
 * override the producer-supplied id.
 *
 * Throws `CommandPolicyNotConfigured` when the policy is not
 * registered; production startup must catch this and surface as a
 * startup error.
 */
export function createCommandGate(
  registry: CommandPolicyRegistry,
  opts: CreateCommandGateOptions = {},
): CommandGate {
  const allocateRequestId = opts.requestIdAllocator ?? defaultRequestIdAllocator
  return {
    async evaluate(request: CommandRequest, policyId: CommandPolicyId): Promise<CommandDecision> {
      // Defensive: when the producer did not allocate a requestId, do
      // it here. The request is treated as immutable downstream.
      const effectiveRequest: CommandRequest = request.id
        ? request
        : { ...request, id: allocateRequestId() }
      const policy = registry.get(policyId)
      if (!policy) {
        throw new CommandPolicyNotConfigured(
          `CommandGate: no policy registered for id '${policyId}'`,
        )
      }
      const decision = await policy.evaluate(effectiveRequest)
      // Slice 2.7 — tick `command_gate_decision_total{decision}` so
      // the runbook §10 alert has a backing signal.
      bumpCommandGateDecision(decision.decision)
      // Stamp the canonical requestId back onto the decision so
      // producers can correlate without re-reading the request.
      return { ...decision, requestId: effectiveRequest.id }
    },
  }
}

/**
 * Slice 2.2 — register the built-in baseline + allowlist policies in
 * one call. Production startup wires this; tests can call
 * `registerDefaultPolicies(registry, { policies: ['baseline-deny'] })`
 * to limit the surface.
 */
export function registerDefaultPolicies(
  registry: CommandPolicyRegistry,
  opts: { policies?: ReadonlyArray<'baseline-deny' | 'default-denylist' | 'allowlist'> } = {},
): readonly CommandPolicyId[] {
  const wanted = new Set(opts.policies ?? ['baseline-deny', 'default-denylist', 'allowlist'])
  const ids: CommandPolicyId[] = []
  if (wanted.has('baseline-deny')) {
    const policy = createDefaultDenylistPolicy()
    registry.register(policy)
    ids.push(policy.id)
  }
  if (wanted.has('default-denylist')) {
    const policy = createDefaultDenylistPolicyAlias()
    registry.register(policy)
    ids.push(policy.id)
  }
  if (wanted.has('allowlist')) {
    const policy = createAllowlistPolicy()
    registry.register(policy)
    ids.push(policy.id)
  }
  return ids
}