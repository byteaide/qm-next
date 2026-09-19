/**
 * Slice 2.1 — AllowlistPolicy: operator-tightened policy that only
 * allows explicitly enumerated operations.
 *
 * ADR-0002: an operator policy may tighten the baseline (including
 * allowlist mode). When the allowlist is empty, every side-effecting
 * operation is denied; sensitive reads are still require_approval by
 * default because they are observation-sensitive, not mutation-
 * sensitive.
 *
 * `allow` rules are matched on `(class, optional resourcePrefix)` so
 * operators can scope a rule to a specific path / id. `deny` rules
 * take precedence over `allow` rules to let operators explicitly
 * carve out exceptions.
 *
 * Linked ADRs: 0002 (Command Policy is a production invariant).
 */
import type { CommandDecision, CommandPolicyId, CommandRequest } from '@qm/types'
import type { CommandPolicy, CommandPolicyContext } from '../command-policy.ts'

export const ALLOWLIST_POLICY_ID: CommandPolicyId = 'allowlist'

export interface AllowlistRule {
  class: CommandRequest['class']
  /** Optional resource prefix match. `resource` must start with this. */
  resourcePrefix?: string
  /** Stable rule id for audit; required. */
  ruleId: string
}

export interface AllowlistPolicyOptions {
  /** Rules that produce `allow`. Order is irrelevant; later `deny`
   *  rules take precedence. */
  allow?: readonly AllowlistRule[]
  /** Rules that produce `deny`. Take precedence over `allow`. */
  deny?: readonly AllowlistRule[]
  /** Stable policy id override (defaults to `allowlist`). */
  id?: CommandPolicyId
  /** Display name for audit; defaults to `'Operator Allowlist'`. */
  displayName?: string
}

function ruleMatches(rule: AllowlistRule, request: CommandRequest): boolean {
  if (rule.class !== request.class) return false
  if (rule.resourcePrefix === undefined) return true
  const resource = request.context.resource ?? ''
  return resource.startsWith(rule.resourcePrefix)
}

function findMatchingRule(rules: readonly AllowlistRule[] | undefined, request: CommandRequest): AllowlistRule | null {
  if (!rules) return null
  for (const rule of rules) {
    if (ruleMatches(rule, request)) return rule
  }
  return null
}

export function createAllowlistPolicy(opts: AllowlistPolicyOptions = {}): CommandPolicy {
  const id = opts.id ?? ALLOWLIST_POLICY_ID
  const displayName = opts.displayName ?? 'Operator Allowlist'
  return {
    id,
    displayName,
    evaluate(request: CommandRequest, ctx: CommandPolicyContext = {}): CommandDecision {
      const ts = ctx.now ?? Date.now()
      const denyRule = findMatchingRule(opts.deny, request)
      if (denyRule) {
        return {
          requestId: request.id,
          decision: 'deny',
          ruleId: denyRule.ruleId,
          reason: `denied by allowlist rule '${denyRule.ruleId}'`,
          ts,
        }
      }
      const allowRule = findMatchingRule(opts.allow, request)
      if (allowRule) {
        return {
          requestId: request.id,
          decision: 'allow',
          ruleId: allowRule.ruleId,
          reason: `allowed by allowlist rule '${allowRule.ruleId}'`,
          ts,
        }
      }
      // Sensitive reads still require approval even when not on the
      // allowlist — they are observation-sensitive, not mutation-
      // sensitive. The operator must explicitly allow them via the
      // `allow` rules if a `require_approval` is not desired.
      if (request.class === 'sensitive_read') {
        return {
          requestId: request.id,
          decision: 'require_approval',
          ruleId: 'allowlist:sensitive-read-default',
          reason: 'sensitive read requires approval',
          ts,
        }
      }
      return {
        requestId: request.id,
        decision: 'deny',
        ruleId: 'allowlist:default-deny',
        reason: 'no allow rule matched',
        ts,
      }
    },
  }
}

/** Re-export the type for ergonomic imports from `@qm/security`. */
export type { CommandDecision }