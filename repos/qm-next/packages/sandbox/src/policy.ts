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
 *   - Rules run against the *scannable* form of the command (X3b full,
 *     `scannableCommand` qm parity): quoted data is stripped, bare words
 *     are unquoted, and payloads the shell would execute (`sh -c`,
 *     `eval`, pipelines into shells/SQL clients, herestrings, simple
 *     variables, ...) are appended as extra scan lines. Data that merely
 *     looks dangerous (heredoc bodies, quoted literals) does not trip
 *     rules; executed variants cannot hide behind quoting.
 *   - Patterns compile through `compileSafeRegex` (qm parity): length
 *     cap, no backreferences/lookarounds, no nested/ambiguous repetition
 *     (ReDoS surface), and the `i` flag is always applied — operators
 *     must not rely on case sensitivity (`RM -RF /` matches `rm`).
 *     An invalid stored pattern is skipped (qm firstMatch parity) so one
 *     stale rule never locks a scope; valid siblings keep binding.
 *   - The matcher is one-shot (first match wins).
 */
import type { CommandDecisionValue, CommandPolicy, CommandRule } from '@qm/types'
import { CommandDenied, NeedsApproval } from '@qm/types'
import { scannableCommand } from './scannable-command.ts'

/**
 * Phase 7 cutover (KV-005): the verdict is shaped like the typed
 * `CommandDecision` from `@qm/types/command-gate.ts` — `decision` is the
 * canonical `CommandDecisionValue`, and the matching rule's identity
 * travels as `ruleId` so audit can trace the decision. (The Gate layer
 * adds `requestId`/`ts` when it mintes the durable record.)
 */
export interface PolicyVerdict {
  decision: CommandDecisionValue
  /** Identity of the rule that produced the decision (its pattern). */
  ruleId?: string
  /** Substring of the scannable text that tripped the rule (qm parity). */
  matched?: string
  reason?: string
}

/** Pattern length ceiling (qm `util/safe-regex.ts` parity). */
const MAX_PATTERN_CHARS = 256

/**
 * ReDoS-guarded regex compilation (qm `src/util/safe-regex.ts` parity):
 * rejects oversized patterns, backreferences, lookarounds, and
 * nested/ambiguous repetition before handing the pattern to `RegExp`.
 */
export function compileSafeRegex(pattern: string, flags = ''): RegExp {
  if (!pattern || pattern.length > MAX_PATTERN_CHARS) {
    throw new Error(`pattern must be 1-${MAX_PATTERN_CHARS} characters`)
  }
  if (/\\[1-9]|\\k<|\(\?[=!<]/.test(pattern)) {
    throw new Error('backreferences and lookarounds are not supported')
  }
  const groups: Array<{ quantified: boolean; alternation: boolean }> = []
  let escaped = false
  let inClass = false
  let previousQuantifier = false
  let closed: { quantified: boolean; alternation: boolean } | null = null
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (escaped) {
      escaped = false
      previousQuantifier = false
      closed = null
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '[') {
      inClass = true
      previousQuantifier = false
      closed = null
      continue
    }
    if (ch === ']' && inClass) {
      inClass = false
      continue
    }
    if (inClass) continue
    if (ch === '(') {
      groups.push({ quantified: false, alternation: false })
      // `(?:` is group syntax, not a quantifier — qm's analyzer
      // misclassifies it as one (its own rules avoid `(?:`), which
      // would wrongly mark the group as quantified. Lookarounds and
      // named groups are already rejected by the safety prefilter
      // above, so skipping one `?` here is exact.
      if (pattern[i + 1] === '?') i++
      previousQuantifier = false
      closed = null
      continue
    }
    if (ch === '|') {
      if (groups.length) groups[groups.length - 1]!.alternation = true
      previousQuantifier = false
      closed = null
      continue
    }
    if (ch === ')') {
      closed = groups.pop() ?? { quantified: false, alternation: false }
      previousQuantifier = false
      continue
    }
    const quantifier = ch === '*' || ch === '+' || (ch === '?' && pattern[i - 1] !== '(') || ch === '{'
    if (quantifier) {
      if (previousQuantifier || (closed && (closed.quantified || closed.alternation))) {
        throw new Error('nested or ambiguous repetition is not supported')
      }
      if (groups.length) groups[groups.length - 1]!.quantified = true
      previousQuantifier = true
      closed = null
      continue
    }
    previousQuantifier = false
    closed = null
  }
  return new RegExp(pattern, flags)
}

/**
 * Evaluate a command string against the policy. Rules run against the
 * scannable form of the command (see `scannableCommand`); the first
 * matching rule's decision wins. If no rule matches, returns `allow` in
 * `denylist` mode (open by default) and `deny` in `allowlist` mode
 * (closed by default). An invalid stored pattern is skipped so one
 * stale rule never locks a scope — `parseCommandPolicy` is the
 * validate-at-write-time layer, this is runtime defence in depth.
 */
export function evaluateCommandPolicy(command: string, policy: CommandPolicy): PolicyVerdict {
  const match = firstMatchVerdict(scannableCommand(command), policy.rules)
  if (match) return match
  // No rule matched.
  return { decision: policy.mode === 'allowlist' ? 'deny' : 'allow' }
}

/**
 * Compose an organization floor with an optional scope policy (qm
 * `composePolicy` parity): rules concatenate floor-first so the floor
 * is evaluated first and a lower scope can tighten but never widen it —
 * a scope `allow` carve-out cannot resurrect something the floor gates.
 * An org-floor `allowlist` mode is authoritative (cannot be downgraded
 * to a denylist); otherwise the scope's mode applies.
 */
export function composePolicy(orgFloor: CommandPolicy, scope?: CommandPolicy): CommandPolicy {
  if (!scope) return orgFloor
  const mode = orgFloor.mode === 'allowlist' ? 'allowlist' : scope.mode
  return { mode, rules: [...orgFloor.rules, ...scope.rules] }
}

/**
 * Layered evaluation (qm `evaluateCommandWithLayer` parity): the scope
 * policy decides first; in `denylist` mode, deployment-layer rules apply
 * only where the scope policy is silent, and never widen a scope
 * decision. `allowlist` scope mode is final (deny on no match).
 */
export function evaluateCommandWithLayer(
  command: string,
  policy: CommandPolicy,
  layerRules: readonly CommandRule[],
): PolicyVerdict {
  const scannable = scannableCommand(command)
  const scopeMatch = firstMatchVerdict(scannable, policy.rules)
  if (scopeMatch) return scopeMatch
  if (policy.mode === 'allowlist') return { decision: 'deny', reason: 'not in allowlist' }
  const layerMatch = firstMatchVerdict(scannable, layerRules)
  if (layerMatch) return layerMatch
  return { decision: 'allow' }
}

function firstMatchVerdict(scannable: string, rules: readonly CommandRule[]): PolicyVerdict | null {
  for (const rule of rules) {
    let regex: RegExp
    try {
      regex = compileSafeRegex(rule.pattern, 'i')
    } catch {
      console.error(
        `[command-policy] skipping invalid rule pattern ${JSON.stringify(rule.pattern)} (${rule.decision}) — re-save the policy to migrate`,
      )
      continue
    }
    const hit = regex.exec(scannable)
    if (hit) {
      const verdict: PolicyVerdict = { decision: rule.decision, ruleId: rule.pattern, matched: hit[0] }
      if (rule.reason !== undefined) verdict.reason = rule.reason
      return verdict
    }
  }
  return null
}

/**
 * Convenience wrapper: returns `null` when the verdict is `allow`,
 * otherwise throws `CommandDenied` or `NeedsApproval`. Used by
 * `Sandbox.run` when `opts.throwOnPolicy === true`.
 */
export function assertPolicyAllows(command: string, policy: CommandPolicy): PolicyVerdict | null {
  const verdict = evaluateCommandPolicy(command, policy)
  if (verdict.decision === 'allow') return null
  const reason = verdict.reason ?? verdict.ruleId ?? 'policy denied'
  if (verdict.decision === 'deny') throw new CommandDenied(command, reason)
  // qm parity: the rule identity travels as approvalKey, the trigger
  // substring as matched, so the approval card is traceable.
  throw new NeedsApproval(command, reason, 'approval', verdict.matched, verdict.ruleId)
}

/** Escape a string for safe inclusion in a regex pattern (caller still chooses flags). */
export function escapeForRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** qm `parseCommandPolicy` parity: `{ policy }` on success, `{ error }` with a stable message on rejection. */
export type ParseCommandPolicyResult = { policy: CommandPolicy } | { error: string }

/**
 * Validate an operator-supplied command policy (qm
 * `src/policy/command-policy.ts:34-64` parity): object shape, closed
 * mode set, non-empty pattern strings that compile through
 * `compileSafeRegex`, canonical decision values, optional string
 * reasons. Used by the admin simulate surface before evaluation.
 */
export function parseCommandPolicy(input: unknown): ParseCommandPolicyResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { error: 'command policy must be an object' }
  }
  const b = input as { mode?: unknown; rules?: unknown }
  if (b.mode !== 'denylist' && b.mode !== 'allowlist') {
    return { error: 'mode must be "denylist" or "allowlist"' }
  }
  if (!Array.isArray(b.rules)) return { error: 'rules must be an array' }
  const rules: CommandRule[] = []
  for (const [i, raw] of b.rules.entries()) {
    if (typeof raw !== 'object' || raw === null) return { error: `rules[${i}] must be an object` }
    const r = raw as { pattern?: unknown; decision?: unknown; reason?: unknown }
    if (typeof r.pattern !== 'string' || r.pattern.length === 0) {
      return { error: `rules[${i}].pattern must be a non-empty string` }
    }
    try {
      compileSafeRegex(r.pattern, 'i')
    } catch (e) {
      return { error: `rules[${i}].pattern is not a valid regex: ${(e as Error).message}` }
    }
    if (r.decision !== 'allow' && r.decision !== 'deny' && r.decision !== 'require_approval') {
      return { error: `rules[${i}].decision must be "allow", "deny", or "require_approval"` }
    }
    if (r.reason !== undefined && typeof r.reason !== 'string') {
      return { error: `rules[${i}].reason must be a string` }
    }
    rules.push({
      pattern: r.pattern,
      decision: r.decision,
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
    })
  }
  return { policy: { mode: b.mode, rules } }
}