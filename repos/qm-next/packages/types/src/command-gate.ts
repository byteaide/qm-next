/**
 * Target Command Gate contracts — implements ADR-0002 (Command Policy is a
 * production invariant) and the Phase 2 architecture gate rules (§2.1 of
 * `docs/implementation-plan.md`).
 *
 * Phase 0 freeze: types compile and are referenced from ADR JSDoc.
 * Runtime Command Gate lives in `packages/security` / sandbox policy
 * (legacy shape); Phase 2 migrates it onto these contracts. New behavior
 * must not collapse decisions into exit codes — the architecture gate
 * enforces this (§Phase 0 boundary checks, line 121 of the plan).
 */
import type { RunVisibilityToken } from './run-observation.ts'

/** Operation class — Side-Effecting Operations must pass the Gate. */
export type CommandClass =
  | 'shell'
  | 'file_write'
  | 'publish'
  | 'background_job'
  | 'cron_mutation'
  | 'webhook_mutation'
  | 'mcp_mutation'
  | 'memory_mutation'
  | 'sensitive_read'

/** A candidate command the Gate evaluates. */
export interface CommandRequest {
  /** Stable identity assigned by `CommandGate`; survives approval round-trip. */
  id: string
  runId: string
  attemptId: string
  /** Operation class — Side-Effecting Operations must always go through the Gate. */
  class: CommandClass
  /** Structured arguments or argv. Raw text only when one exists. */
  args: CommandRequestArgs
  /** Execution context the Gate may inspect (scope, principal, surface, …). */
  context: CommandRequestContext
  /** Raw text the user typed, when one exists; absent for purely structured calls. */
  rawText?: string
  /** Monotonic issuance timestamp in epoch ms. */
  ts: number
}

/** Structured args; the Gate MUST NOT receive an unstructured shell string in place of this. */
export interface CommandRequestArgs {
  /** argv-style for shell/file/sandbox. */
  argv?: readonly string[]
  /** Structured arguments for publish/share/MCP. */
  fields?: Readonly<Record<string, unknown>>
}

export interface CommandRequestContext {
  scopeId: string
  principalId: string
  surface: string
  /** Resource targeted (path, id, URL). Free-form but required. */
  resource?: string
}

/** Closed set of Command Gate outcomes — decisions are never exit codes on target paths. */
export type CommandDecisionValue = 'allow' | 'deny' | 'require_approval'

export interface CommandDecision {
  requestId: string
  decision: CommandDecisionValue
  /** Rule identity that produced the decision (so audit can trace it). */
  ruleId?: string
  reason?: string
  /** When `decision === 'require_approval'`, the Approval Request created for it. */
  approvalRequestId?: string
  ts: number
}

/**
 * The Command Gate port. Implementations MUST distinguish allow/deny/
 * require_approval and MUST reject collapsing into exit codes.
 *
 * `policyId` identifies the production-selected Baseline Policy (ADR-0002
 * §"production policy configuration"). Production startup fails when
 * `policyId` is absent.
 */
export interface CommandGate {
  evaluate(request: CommandRequest, policyId: string): Promise<CommandDecision>
}

/** Tag identifying the production-selected Command Policy. */
export type CommandPolicyId = string

/** Marker used by the architecture gate to reject exit-code collapse on target paths. */
export const COMMAND_GATE_DECISIONS = ['allow', 'deny', 'require_approval'] as const

/** Construct a typed decision; shared between producers and the audit log. */
export function commandDecisionEquals(a: CommandDecision, b: CommandDecision): boolean {
  return (
    a.requestId === b.requestId &&
    a.decision === b.decision &&
    (a.ruleId ?? null) === (b.ruleId ?? null) &&
    (a.approvalRequestId ?? null) === (b.approvalRequestId ?? null)
  )
}

/** Visibility token used by the audit log; not part of the Gate's evaluation. */
export type CommandAuditVisibility = RunVisibilityToken
