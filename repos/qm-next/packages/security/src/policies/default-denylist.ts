/**
 * Slice 2.1 — `default-denylist` Baseline Policy.
 *
 * ADR-0002: the built-in `default-denylist` is the minimum Baseline
 * Policy and may be tightened to an allowlist. The policy name is
 * `baseline-deny`; `default-denylist` is its historical alias kept for
 * migration windows.
 *
 * Decisions:
 *   - `shell` / `file_write` / `publish` / `background_job` /
 *     `cron_mutation` / `webhook_mutation` / `mcp_mutation` /
 *     `memory_mutation` — `require_approval` (operators may tighten
 *     to allowlist mode by composing with their own policy).
 *   - `sensitive_read` — `require_approval` (sensitive reads may leak;
 *     ADR-0002 §"Gating Sensitive Reads").
 *   - everything else (pure non-sensitive reads, by class) — `allow`
 *     without going through the gate (see `packages/types/src/command-gate.ts`
 *     §"do not gate pure, non-sensitive reads").
 *
 * Linked ADRs: 0002 (Command Policy is a production invariant).
 */
import type { CommandClass, CommandDecision, CommandPolicyId, CommandRequest } from '@qm/types'
import type { CommandPolicy, CommandPolicyContext } from '../command-policy.ts'

export const BASELINE_DENY_POLICY_ID: CommandPolicyId = 'baseline-deny'
export const DEFAULT_DENYLIST_POLICY_ID: CommandPolicyId = 'default-denylist'

const SIDE_EFFECTING: ReadonlySet<CommandClass> = new Set<CommandClass>([
  'shell',
  'file_write',
  'publish',
  'background_job',
  'cron_mutation',
  'webhook_mutation',
  'mcp_mutation',
  'memory_mutation',
])

const REASON_SIDE_EFFECTING = 'side-effecting operation requires approval'
const REASON_SENSITIVE_READ = 'sensitive read requires approval'

/**
 * Returns `true` when the command class must pass through the Gate at
 * all. Pure non-sensitive reads return `false` here — those bypass the
 * gate entirely (ADR-0002 §"Do not gate pure non-sensitive reads").
 */
export function classRequiresGate(klass: CommandClass): boolean {
  return SIDE_EFFECTING.has(klass) || klass === 'sensitive_read'
}

/**
 * The Baseline Policy. Returns `require_approval` for every
 * side-effecting operation and sensitive read; throws for unknown
 * classes (so producers cannot silently ship a new class without
 * bumping the policy).
 */
export function createDefaultDenylistPolicy(): CommandPolicy {
  return {
    id: BASELINE_DENY_POLICY_ID,
    displayName: 'Default Denylist (baseline)',
    evaluate(request: CommandRequest, _ctx: CommandPolicyContext = {}): CommandDecision {
      const klass = request.class
      if (klass === 'shell' || klass === 'file_write' || klass === 'publish' || klass === 'background_job'
          || klass === 'cron_mutation' || klass === 'webhook_mutation' || klass === 'mcp_mutation'
          || klass === 'memory_mutation') {
        return {
          requestId: request.id,
          decision: 'require_approval',
          ruleId: 'baseline-deny:side-effecting',
          reason: REASON_SIDE_EFFECTING,
          ts: _ctx.now ?? Date.now(),
        }
      }
      if (klass === 'sensitive_read') {
        return {
          requestId: request.id,
          decision: 'require_approval',
          ruleId: 'baseline-deny:sensitive-read',
          reason: REASON_SENSITIVE_READ,
          ts: _ctx.now ?? Date.now(),
        }
      }
      throw new Error(
        `DefaultDenylistPolicy: unknown CommandClass '${String(klass)}' — bump the policy before shipping`,
      )
    },
  }
}

/** Alias retained for migration windows where the legacy name was used. */
export function createDefaultDenylistPolicyAlias(): CommandPolicy {
  const policy = createDefaultDenylistPolicy()
  return { ...policy, id: DEFAULT_DENYLIST_POLICY_ID }
}