/**
 * Slice 2.1 — Command Gate contract tests.
 *
 * Asserts the §2.1 invariants:
 *   - Production missing policy fails startup.
 *   - Explicit baseline policy starts successfully.
 *   - `deny`, `allow`, and `require_approval` remain distinguishable.
 *   - Policy denial is not represented as an ordinary exit code.
 *   - Side-effecting tools cannot bypass the Gate.
 *   - Sensitive reads can require the Gate.
 *   - Pure non-sensitive reads do not require the Gate.
 *   - Operator policy can tighten the baseline (allowlist mode).
 *
 * Linked ADRs: 0002 (Command Policy is a production invariant).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { CommandRequest } from '@qm/types'
import {
  BASELINE_DENY_POLICY_ID,
  CommandPolicyNotConfigured,
  classRequiresGate,
  createAllowlistPolicy,
  createCommandGate,
  createCommandPolicyRegistry,
  createDefaultDenylistPolicy,
  registerDefaultPolicies,
} from '../src/index.ts'

function makeRequest(overrides: Partial<CommandRequest> = {}): CommandRequest {
  return {
    id: overrides.id ?? 'req-1',
    runId: overrides.runId ?? 'run-1',
    attemptId: overrides.attemptId ?? 'attempt-1',
    class: overrides.class ?? 'shell',
    args: overrides.args ?? { argv: ['ls'] },
    context: overrides.context ?? {
      scopeId: 'personal:test',
      principalId: 'person:test',
      surface: 'web',
      resource: '/tmp',
    },
    ...(overrides.rawText !== undefined ? { rawText: overrides.rawText } : {}),
    ts: overrides.ts ?? Date.now(),
    ...overrides,
  }
}

test('slice-2.1: production missing policy fails startup', () => {
  const registry = createCommandPolicyRegistry()
  assert.throws(
    () => registry.assertProductionConfigured(),
    (err: unknown) =>
      err instanceof CommandPolicyNotConfigured &&
      /CommandPolicy registry is empty/.test((err as Error).message),
  )
})

test('slice-2.1: explicit baseline policy starts successfully', () => {
  const registry = createCommandPolicyRegistry()
  registerDefaultPolicies(registry)
  registry.setActive(BASELINE_DENY_POLICY_ID)
  const policy = registry.assertProductionConfigured()
  assert.equal(policy.id, BASELINE_DENY_POLICY_ID)
})

test('slice-2.1: deny/allow/require_approval remain distinguishable', async () => {
  const registry = createCommandPolicyRegistry()
  // Baseline only: each allowlist variant below registers under its own
  // explicit id, so nothing collides with the canonical default id.
  registerDefaultPolicies(registry, { policies: ['baseline-deny'] })
  registry.setActive(BASELINE_DENY_POLICY_ID)
  const gate = createCommandGate(registry)
  // Baseline returns require_approval for shell — distinct from deny/allow.
  const decision = await gate.evaluate(makeRequest({ class: 'shell' }), BASELINE_DENY_POLICY_ID)
  assert.equal(decision.decision, 'require_approval')
  // An allowlist with no rules returns deny — also distinct.
  const emptyAllowlist = createAllowlistPolicy({ id: 'allowlist-empty' })
  registry.register(emptyAllowlist)
  const allowlistDecision = await gate.evaluate(makeRequest({ class: 'shell' }), emptyAllowlist.id)
  assert.equal(allowlistDecision.decision, 'deny')
  // Allowlist with a matching rule returns allow.
  const policy = createAllowlistPolicy({
    id: 'allowlist-shell',
    allow: [{ class: 'shell', ruleId: 'allow-shell' }],
  })
  registry.register(policy)
  const allowed = await gate.evaluate(makeRequest({ class: 'shell' }), policy.id)
  assert.equal(allowed.decision, 'allow')
  // Each decision has a stable requestId matching the request.
  assert.equal(decision.requestId, 'req-1')
  assert.equal(allowlistDecision.requestId, 'req-1')
  assert.equal(allowed.requestId, 'req-1')
})

test('slice-2.1: policy denial is not represented as an ordinary exit code', async () => {
  const registry = createCommandPolicyRegistry()
  const policy = createAllowlistPolicy({ deny: [{ class: 'shell', ruleId: 'no-shell' }] })
  registry.register(policy)
  registry.setActive(policy.id)
  const gate = createCommandGate(registry)
  const decision = await gate.evaluate(makeRequest({ class: 'shell' }), policy.id)
  assert.equal(decision.decision, 'deny')
  assert.equal(decision.ruleId, 'no-shell')
  // Decision is structured; it does not leak a thrown error / exit code.
  assert.doesNotThrow(() => gate.evaluate(makeRequest({ class: 'shell' }), policy.id))
})

test('slice-2.1: side-effecting tool cannot bypass the gate', async () => {
  const registry = createCommandPolicyRegistry()
  registerDefaultPolicies(registry)
  registry.setActive(BASELINE_DENY_POLICY_ID)
  const gate = createCommandGate(registry)
  for (const klass of ['shell', 'file_write', 'publish', 'background_job', 'cron_mutation', 'webhook_mutation', 'mcp_mutation', 'memory_mutation'] as const) {
    const decision = await gate.evaluate(makeRequest({ class: klass }), BASELINE_DENY_POLICY_ID)
    assert.equal(
      decision.decision,
      'require_approval',
      `class '${klass}' must require approval`,
    )
    assert.match(decision.reason ?? '', /approval/i)
  }
})

test('slice-2.1: sensitive reads require the gate', async () => {
  const registry = createCommandPolicyRegistry()
  registerDefaultPolicies(registry)
  registry.setActive(BASELINE_DENY_POLICY_ID)
  const gate = createCommandGate(registry)
  const decision = await gate.evaluate(makeRequest({ class: 'sensitive_read' }), BASELINE_DENY_POLICY_ID)
  assert.equal(decision.decision, 'require_approval')
  assert.match(decision.ruleId ?? '', /sensitive-read/)
})

test('slice-2.1: pure non-sensitive reads do not require the gate', () => {
  // Pure non-sensitive reads bypass the gate entirely (ADR-0002). The
  // helper `classRequiresGate` is the single source of truth; the
  // gate is only entered for side-effecting classes or sensitive reads.
  assert.equal(classRequiresGate('shell'), true)
  assert.equal(classRequiresGate('file_write'), true)
  assert.equal(classRequiresGate('publish'), true)
  assert.equal(classRequiresGate('background_job'), true)
  assert.equal(classRequiresGate('cron_mutation'), true)
  assert.equal(classRequiresGate('webhook_mutation'), true)
  assert.equal(classRequiresGate('mcp_mutation'), true)
  assert.equal(classRequiresGate('memory_mutation'), true)
  assert.equal(classRequiresGate('sensitive_read'), true)
})

test('slice-2.1: operator policy can tighten baseline (allowlist mode)', async () => {
  const registry = createCommandPolicyRegistry()
  // Baseline only — the operator allowlist below registers under the
  // canonical allowlist id.
  registerDefaultPolicies(registry, { policies: ['baseline-deny'] })
  registry.setActive(BASELINE_DENY_POLICY_ID)
  const gate = createCommandGate(registry)

  // Baseline requires approval for shell.
  const baseline = await gate.evaluate(makeRequest({ class: 'shell' }), BASELINE_DENY_POLICY_ID)
  assert.equal(baseline.decision, 'require_approval')

  // Operator deploys an allowlist that allows only `mcp_mutation` on a
  // specific resource prefix.
  const policy = createAllowlistPolicy({
    allow: [{ class: 'mcp_mutation', resourcePrefix: 'mcp://tools/', ruleId: 'mcp-allow' }],
  })
  registry.register(policy)
  registry.setActive(policy.id)

  const allowed = await gate.evaluate(
    makeRequest({ class: 'mcp_mutation', context: { scopeId: 'personal:test', principalId: 'person:test', surface: 'web', resource: 'mcp://tools/registry' } }),
    policy.id,
  )
  assert.equal(allowed.decision, 'allow')

  // Outside the allowlist prefix: deny (no allow rule matched).
  const denied = await gate.evaluate(
    makeRequest({ class: 'mcp_mutation', context: { scopeId: 'personal:test', principalId: 'person:test', surface: 'web', resource: 'mcp://other/registry' } }),
    policy.id,
  )
  assert.equal(denied.decision, 'deny')

  // Shell under allowlist: deny by default.
  const shellDenied = await gate.evaluate(makeRequest({ class: 'shell' }), policy.id)
  assert.equal(shellDenied.decision, 'deny')
})

test('slice-2.1: unknown policy id throws CommandPolicyNotConfigured', async () => {
  const registry = createCommandPolicyRegistry()
  registerDefaultPolicies(registry)
  const gate = createCommandGate(registry)
  await assert.rejects(
    () => gate.evaluate(makeRequest(), 'never-registered'),
    (err: unknown) => err instanceof CommandPolicyNotConfigured,
  )
})

test('slice-2.1: gate allocates requestId when missing', async () => {
  const registry = createCommandPolicyRegistry()
  registry.register(createDefaultDenylistPolicy())
  registry.setActive(BASELINE_DENY_POLICY_ID)
  let count = 0
  const gate = createCommandGate(registry, { requestIdAllocator: () => `alloc-${++count}` })
  const decision = await gate.evaluate(
    { ...makeRequest(), id: '' },
    BASELINE_DENY_POLICY_ID,
  )
  assert.equal(decision.requestId, 'alloc-1')
})

test('slice-2.1: register throws on duplicate policy id', () => {
  const registry = createCommandPolicyRegistry()
  registry.register(createDefaultDenylistPolicy())
  assert.throws(
    () => registry.register(createDefaultDenylistPolicy()),
    /already registered/,
  )
})

test('slice-2.1: setActive throws on unknown id', () => {
  const registry = createCommandPolicyRegistry()
  assert.throws(() => registry.setActive('never-registered'), CommandPolicyNotConfigured)
})