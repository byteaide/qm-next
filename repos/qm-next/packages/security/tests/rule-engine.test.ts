import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCommandGate, registerDefaultPolicies } from '../src/command-gate.ts'
import { createCommandPolicyRegistry } from '../src/command-policy.ts'
import { createRuleEnginePolicy, commandTextOf, RULE_ENGINE_POLICY_ID } from '../src/policies/rule-engine.ts'
import { defaultDenylistPolicy } from '@qm/sandbox'
import type { CommandRequest } from '@qm/types'

function request(over: Partial<CommandRequest> = {}): CommandRequest {
  return {
    id: 'req-1',
    runId: 'run-1',
    attemptId: 'att-1',
    class: 'shell',
    args: { argv: ['echo', 'hello'] },
    context: { scopeId: 'org:test', principalId: 'person:ada', surface: 'api' },
    ts: 1_700_000_000_000,
    ...over,
  }
}

test('rule-engine policy: argv text evaluates through the sandbox engine (G6, ADR-0019)', async () => {
  const policy = createRuleEnginePolicy({ resolvePolicy: () => defaultDenylistPolicy() })
  const denied = await policy.evaluate(request({ args: { argv: ['sh', '-c', 'rm -rf /etc'] } }))
  assert.equal(denied.requestId, 'req-1')
  assert.equal(denied.decision, 'deny')
  assert.ok(denied.ruleId?.includes('rm'), 'the fired rule identity travels')
  assert.ok(denied.reason?.includes('root-level'), 'the rule reason travels')
  const allowed = await policy.evaluate(request())
  assert.equal(allowed.decision, 'allow')
})

test('rule-engine policy: rawText fallback and no-text allow', async () => {
  const policy = createRuleEnginePolicy({ resolvePolicy: () => defaultDenylistPolicy() })
  const raw = await policy.evaluate(request({ args: {}, rawText: "sh -c 'mkfs.ext4 /dev/sda'" }))
  assert.equal(raw.decision, 'deny')
  const silent = await policy.evaluate(request({ args: {} }))
  assert.equal(silent.decision, 'allow')
  assert.equal(commandTextOf(request({ args: {} })), '')
})

test('rule-engine policy: per-scope resolver picks the stored rule set', async () => {
  const scopeRules = {
    mode: 'denylist' as const,
    rules: [{ pattern: '\\bhelm\\s+install\\b', decision: 'require_approval' as const, reason: 'scope: helm' }],
  }
  const policy = createRuleEnginePolicy({ resolvePolicy: (req) => (req.context.scopeId === 'channel:a' ? scopeRules : undefined) })
  const scoped = await policy.evaluate(request({ context: { scopeId: 'channel:a', principalId: 'p', surface: 'api' }, args: { argv: ['helm', 'install', 'x'] } }))
  assert.equal(scoped.decision, 'require_approval')
  assert.equal(scoped.reason, 'scope: helm')
  const unscoped = await policy.evaluate(request({ args: { argv: ['helm', 'install', 'x'] } }))
  assert.equal(unscoped.decision, 'allow', 'fallback open denylist when the resolver has nothing')
})

test('rule-engine policy: reachable through the CommandGate port', async () => {
  const registry = createCommandPolicyRegistry()
  const ids = registerDefaultPolicies(registry, { policies: ['rule-engine'], ruleEngineResolve: () => defaultDenylistPolicy() })
  assert.deepEqual([...ids], ['rule-engine'])
  const gate = createCommandGate(registry)
  const decision = await gate.evaluate(request({ args: { argv: ['bash', '-c', 'mkfs.ext4 /dev/sda'] } }), RULE_ENGINE_POLICY_ID)
  assert.equal(decision.requestId, 'req-1')
  assert.equal(decision.decision, 'deny')
})
