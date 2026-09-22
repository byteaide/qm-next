/**
 * Slice 2.1 / X3b G6 — the rule-engine CommandPolicy: the ONE convergence
 * point between the dormant CommandGate port and the live sandbox rule
 * engine (ADR-0019). Command text comes from `args.argv` (joined) or
 * `rawText`; evaluation is the same `evaluateCommandPolicy` the sandbox
 * gate runs — scannableCommand normalization, safe-regex compilation,
 * first-match-wins — so a verdict through the Gate equals a verdict
 * through the sandbox. Structured operations (publish/webhook/mcp/…)
 * stay with the category policies; this policy targets text-bearing
 * `shell`/`file_write` requests.
 *
 * Linked ADRs: 0002 (Command Policy is a production invariant),
 * 0019 (dual-engine convergence onto the rule engine).
 */
import type {
  CommandDecision,
  CommandDecisionValue,
  CommandPolicyId,
  CommandPolicy as RuleSet,
  CommandRequest,
} from '@qm/types'
import type { CommandPolicy, CommandPolicyContext } from '../command-policy.ts'
import { evaluateCommandPolicy } from '@qm/sandbox'

export const RULE_ENGINE_POLICY_ID: CommandPolicyId = 'rule-engine'

export interface CreateRuleEnginePolicyOptions {
  id?: CommandPolicyId
  displayName?: string
  /**
   * Resolve the rule set for a request: close over a static rule set, or
   * resolve per-scope storage (the X3b CommandPolicyStore). Returning
   * undefined falls back to `fallback` (an open denylist: rules that do
   * not match allow).
   */
  resolvePolicy: (request: CommandRequest) => RuleSet | undefined | Promise<RuleSet | undefined>
  fallback?: RuleSet
}

/** Command text for gate evaluation: argv wins, raw text is the fallback. */
export function commandTextOf(request: CommandRequest): string {
  if (request.args.argv && request.args.argv.length > 0) return request.args.argv.join(' ')
  return request.rawText ?? ''
}

export function createRuleEnginePolicy(opts: CreateRuleEnginePolicyOptions): CommandPolicy {
  const resolve = opts.resolvePolicy
  const fallback = opts.fallback ?? { mode: 'denylist' as const, rules: [] }
  return {
    id: opts.id ?? RULE_ENGINE_POLICY_ID,
    displayName: opts.displayName ?? 'Rule Engine (scannableCommand parity)',
    async evaluate(request: CommandRequest, ctx: CommandPolicyContext = {}): Promise<CommandDecision> {
      const text = commandTextOf(request)
      const ruleSet = (await resolve(request)) ?? fallback
      const verdict = evaluateCommandPolicy(text, ruleSet)
      const decision: CommandDecision = {
        requestId: request.id,
        decision: verdict.decision as CommandDecisionValue,
        ts: ctx.now ?? Date.now(),
      }
      if (verdict.ruleId !== undefined) decision.ruleId = verdict.ruleId
      if (verdict.reason !== undefined) decision.reason = verdict.reason
      return decision
    },
  }
}
