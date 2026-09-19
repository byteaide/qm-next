/**
 * Phase 3J — sandbox command-policy evaluator (qm `src/tools/policy.ts`
 * parity, lane-opening freeze). Resolves a `CommandPolicy` (mode + rules)
 * against a candidate command string and returns the first matching
 * decision. The contract is consumed by `LocalSandbox.run` to refuse
 * catastrophic shell / SQL primitives before the docker exec call.
 *
 * Why this lives in `@qm/sandbox` and not `@qm/types`: `CommandPolicy`
 * is the type, but the *evaluator* depends on `RegExp` which is a
 * runtime concern. `@qm/types` stays a pure-types package; the runtime
 * sits next to the `Sandbox` interface that uses it.
 *
 * Phase 3J caveats:
 *   - Pattern matching is regex against the *literal* command string;
 *     it does NOT parse shell grammar. `rm -rf /tmp/foo` does not match
 *     the `rm -rf\s+/` denylist pattern because the slash is followed by
 *     `tmp`. This is intentional — false positives on legitimate work
 *     are worse than misses on adversarial inputs.
 *   - The matcher is one-shot (first match wins) and case-sensitive by
 *     default. Callers who need case-insensitive matching should write
 *     the pattern with the `i` flag explicitly.
 */
import type { CommandDecision, CommandPolicy, CommandRule } from '@qm/types'
import { CommandDenied, NeedsApproval } from '@qm/types'

export interface PolicyVerdict {
  decision: CommandDecision
  reason?: string
  matched?: string
}

interface CompiledRule {
  rule: CommandRule
  regex: RegExp
}

function compileRules(rules: readonly CommandRule[]): CompiledRule[] {
  return rules.map((rule) => ({ rule, regex: new RegExp(rule.pattern) }))
}

/**
 * Evaluate a command string against the policy. Returns the first rule's
 * decision; if no rule matches, returns `allow` in `denylist` mode (open
 * by default) and `deny` in `allowlist` mode (closed by default). The
 * caller decides what to do with `require_approval` — the harness-pi
 * thread catches `NeedsApproval` and produces an approval card; the
 * sandbox layer typically lets it through so the harness can intercept.
 */
export function evaluateCommandPolicy(command: string, policy: CommandPolicy): PolicyVerdict {
  const compiled = compileRules(policy.rules)
  for (const { rule, regex } of compiled) {
    if (regex.test(command)) {
      const verdict: PolicyVerdict = { decision: rule.decision }
      if (rule.reason !== undefined) verdict.reason = rule.reason
      verdict.matched = rule.pattern
      return verdict
    }
  }
  // No rule matched.
  return { decision: policy.mode === 'allowlist' ? 'deny' : 'allow' }
}

/**
 * Convenience wrapper: returns `null` when the verdict is `allow`,
 * otherwise throws `CommandDenied` or `NeedsApproval`. Used by
 * `Sandbox.run` when `opts.throwOnPolicy === true`.
 */
export function assertPolicyAllows(command: string, policy: CommandPolicy): PolicyVerdict | null {
  const verdict = evaluateCommandPolicy(command, policy)
  if (verdict.decision === 'allow') return null
  const reason = verdict.reason ?? verdict.matched ?? 'policy denied'
  if (verdict.decision === 'deny') throw new CommandDenied(command, reason)
  throw new NeedsApproval(command, reason)
}

/** Escape a string for safe inclusion in a regex pattern (caller still chooses flags). */
export function escapeForRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}