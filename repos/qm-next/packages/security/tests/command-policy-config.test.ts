/**
 * Slice 2.2 — Production policy configuration contract tests.
 *
 * Asserts the §2.2 invariants:
 *   - Production startup fails when `QM_COMMAND_POLICY` is unset.
 *   - Production startup succeeds with the explicit baseline id.
 *   - Production startup fails when the policy id is unknown.
 *   - Operator tightening is achieved by registering additional
 *     policies at startup.
 *   - Dev / local profiles may omit the env var and still get the
 *     baseline policy.
 *
 * Linked ADRs: 0002 (Command Policy is a production invariant).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ALLOWLIST_POLICY_ID,
  BASELINE_DENY_POLICY_ID,
  CommandPolicyNotConfigured,
  PRODUCTION_DEFAULT_POLICY_ID,
  QM_COMMAND_POLICY_ENV,
  configureProductionCommandPolicy,
  createAllowlistPolicy,
  createCommandGate,
  createCommandPolicyRegistry,
} from '../src/index.ts'

test('slice-2.2: production startup fails when QM_COMMAND_POLICY is unset', () => {
  const registry = createCommandPolicyRegistry()
  assert.throws(
    () => configureProductionCommandPolicy(registry, { env: {} }),
    (err: unknown) =>
      err instanceof CommandPolicyNotConfigured &&
      new RegExp(QM_COMMAND_POLICY_ENV).test((err as Error).message),
  )
})

test('slice-2.2: production startup succeeds with explicit baseline id', () => {
  const registry = createCommandPolicyRegistry()
  const gate = configureProductionCommandPolicy(registry, {
    env: { [QM_COMMAND_POLICY_ENV]: BASELINE_DENY_POLICY_ID },
  })
  assert.ok(gate)
  // assertProductionConfigured runs inside the helper — we can also
  // re-invoke to confirm the registry is in a valid state.
  const policy = registry.assertProductionConfigured()
  assert.equal(policy.id, BASELINE_DENY_POLICY_ID)
})

test('slice-2.2: production startup fails when the env var names an unknown policy', () => {
  const registry = createCommandPolicyRegistry()
  assert.throws(
    () =>
      configureProductionCommandPolicy(registry, {
        env: { [QM_COMMAND_POLICY_ENV]: 'never-registered' },
      }),
    (err: unknown) =>
      err instanceof CommandPolicyNotConfigured &&
      /unknown CommandPolicy/.test((err as Error).message),
  )
})

test('slice-2.2: operator tightening via additional registered policies', async () => {
  const registry = createCommandPolicyRegistry()
  // Operator deploys an allowlist before startup; configureProduction
  // must not overwrite it.
  const allowlist = createAllowlistPolicy({
    allow: [{ class: 'mcp_mutation', resourcePrefix: 'mcp://tools/', ruleId: 'mcp-allow' }],
  })
  registry.register(allowlist)
  const gate = configureProductionCommandPolicy(registry, {
    env: { [QM_COMMAND_POLICY_ENV]: allowlist.id },
  })
  // The selected policy is the allowlist, not the baseline.
  const policy = registry.assertProductionConfigured()
  assert.equal(policy.id, allowlist.id)
  // Evaluation respects the operator's rules.
  const allowed = await gate.evaluate(
    {
      id: 'req-mcp',
      runId: 'run-1',
      attemptId: 'attempt-1',
      class: 'mcp_mutation',
      args: { argv: [] },
      context: { scopeId: 'personal:test', principalId: 'person:test', surface: 'web', resource: 'mcp://tools/registry' },
      ts: Date.now(),
    },
    allowlist.id,
  )
  assert.equal(allowed.decision, 'allow')
})

test('slice-2.2: dev profile may omit env var and falls back to baseline', () => {
  const registry = createCommandPolicyRegistry()
  const gate = configureProductionCommandPolicy(registry, {
    env: {},
    production: false,
  })
  assert.ok(gate)
  const policy = registry.assertProductionConfigured()
  assert.equal(policy.id, PRODUCTION_DEFAULT_POLICY_ID)
})

test('slice-2.2: production fails closed when an env override names a policy that was not registered', async () => {
  // The ALLOWLIST_POLICY_ID is registered by registerDefaultPolicies,
  // but if an operator wants to forbid the allowlist, they would
  // either not register it or register their own.
  const registry = createCommandPolicyRegistry()
  // Don't call registerDefaultPolicies via the helper — simulate a
  // tighter operator who only wants the baseline.
  const gate = configureProductionCommandPolicy(registry, {
    env: { [QM_COMMAND_POLICY_ENV]: BASELINE_DENY_POLICY_ID },
    policies: ['baseline-deny'],
  })
  assert.ok(gate)
  // ALLOWLIST is not registered (operator tightened) — so asking for
  // it via a direct gate.evaluate() must reject.
  await assert.rejects(
    () =>
      createCommandGate(registry).evaluate(
        {
          id: 'req-shell',
          runId: 'run-1',
          attemptId: 'attempt-1',
          class: 'shell',
          args: { argv: [] },
          context: { scopeId: 'personal:test', principalId: 'person:test', surface: 'web' },
          ts: Date.now(),
        },
        ALLOWLIST_POLICY_ID,
      ),
    CommandPolicyNotConfigured,
  )
})

test('slice-2.2: gateOptions.requestIdAllocator is honored through configureProductionCommandPolicy', async () => {
  const registry = createCommandPolicyRegistry()
  let count = 0
  const gate = configureProductionCommandPolicy(registry, {
    env: { [QM_COMMAND_POLICY_ENV]: BASELINE_DENY_POLICY_ID },
    gateOptions: { requestIdAllocator: () => `alloc-${++count}` },
  })
  const decision = await gate.evaluate(
    {
      id: '',
      runId: 'run-1',
      attemptId: 'attempt-1',
      class: 'shell',
      args: { argv: [] },
      context: { scopeId: 'personal:test', principalId: 'person:test', surface: 'web' },
      ts: Date.now(),
    },
    BASELINE_DENY_POLICY_ID,
  )
  assert.equal(decision.requestId, 'alloc-1')
})