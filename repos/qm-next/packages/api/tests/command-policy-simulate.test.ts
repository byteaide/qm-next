import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@qm/cordis'
import {
  createApiServer,
  createMemoryAdminService,
  createMemoryAuditLog,
  createMemoryCommandPolicyStore,
  mintSignedPayload,
  type ApiDeps,
  type ApiServerOptions,
} from '../src/index.ts'
import type { ResolutionService, ScopeId } from '@qm/types'
import { createHarnessRouter, createMockHarness, OrchestratorService } from '@qm/orchestrator'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'

const SECRET = '[redacted-credential]'
const SCOPE: ScopeId = 'org:test'
const ORG = 'org:test'
const OPTS: ApiServerOptions = { secrets: [SECRET] }
const URL = '/v1/admin/scopes/org:test/command-policy-simulate'

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

function token(p: string): Promise<string> {
  return mintSignedPayload({ p }, SECRET)
}

function resolution(): ResolutionService {
  return {
    resolve: async () => ({ systemPrompt: 'You are a test agent.', orgScopeId: SCOPE }),
    scopeFor: () => SCOPE,
  }
}

function baseDeps(): ApiDeps {
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(createMockHarness())
  const res = resolution()
  return {
    orchestrator: new OrchestratorService(new Context(), {
      sessions: createMemorySessionStore(),
      runs: createMemoryRunStore(),
      harness: registry,
      identity: { isInternal: (p) => p.type === 'internal', audienceIsAllInternal: (a) => a.every((p) => p.type === 'internal') },
      resolution: res,
      rateLimiter: { check: async () => ({ allowed: true }) },
    }),
    sessions: createMemorySessionStore(),
    runs: createMemoryRunStore(),
    resolution: res,
  }
}

function rig(opts: { commandPolicies?: boolean } = {}) {
  const auditLog = createMemoryAuditLog()
  const adminDeps = {
    admin: createMemoryAdminService({ orgId: 'test', seedAdmins: ['person:ada'] }),
    orgScope: ORG,
    auditLog,
    ...(opts.commandPolicies ? { commandPolicies: createMemoryCommandPolicyStore() } : {}),
  }
  const app = createApiServer({ ...baseDeps(), admin: adminDeps }, OPTS)
  return { app, auditLog, adminDeps }
}

test('admin command-policy-simulate: baseline fallback catches catastrophic commands', async () => {
  const { app, auditLog } = rig()
  const ada = auth(await token('person:ada'))
  const res = await app.inject({ method: 'PUT', url: URL, headers: ada, payload: { command: 'rm -rf /etc' } })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.decision, 'deny')
  assert.equal(body.policySource, 'baseline')
  assert.equal(body.ruleSource, 'scope')
  assert.equal(body.ruleIndex, 0)
  assert.match(body.matched, /rm/)
  const events = await auditLog.tail({ limit: 10 })
  assert.ok(events.some((e) => e.action === 'admin.command_policy.simulate' && e.principalId === 'person:ada'))
  await app.close()
})

test('admin command-policy-simulate: matching is case-insensitive (engine parity with sandbox gate)', async () => {
  const { app } = rig()
  const ada = auth(await token('person:ada'))
  const res = await app.inject({ method: 'PUT', url: URL, headers: ada, payload: { command: 'DROP TABLE users' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().decision, 'deny')
  await app.close()
})

test('admin command-policy-simulate: inline policy evaluates and is attributed as inline', async () => {
  const { app } = rig()
  const ada = auth(await token('person:ada'))
  const res = await app.inject({
    method: 'PUT',
    url: URL,
    headers: ada,
    payload: {
      command: 'kubectl delete namespace prod',
      policy: {
        mode: 'denylist',
        rules: [{ pattern: 'kubectl\\s+delete', decision: 'require_approval', reason: 'cluster mutation' }],
      },
    },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.decision, 'require_approval')
  assert.equal(body.ruleSource, 'scope')
  assert.equal(body.policySource, 'inline')
  assert.equal(body.ruleIndex, 0)
  assert.equal(body.reason, 'cluster mutation')
  assert.equal(body.matched, 'kubectl delete')
  await app.close()
})

test('admin command-policy-simulate: inline allowlist denies by default with null provenance', async () => {
  const { app } = rig()
  const ada = auth(await token('person:ada'))
  const res = await app.inject({
    method: 'PUT',
    url: URL,
    headers: ada,
    payload: {
      command: 'ls -la',
      policy: { mode: 'allowlist', rules: [{ pattern: '^git\\s+status$', decision: 'allow' }] },
    },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.decision, 'deny')
  assert.equal(body.matched, null)
  assert.equal(body.ruleIndex, null)
  await app.close()
})

test('admin command-policy-simulate: bad request shape and invalid inline policy are 400', async () => {
  const { app } = rig()
  const ada = auth(await token('person:ada'))

  const noCommand = await app.inject({ method: 'PUT', url: URL, headers: ada, payload: {} })
  assert.equal(noCommand.statusCode, 400)
  assert.equal(noCommand.json().message, 'command is required')

  const blank = await app.inject({ method: 'PUT', url: URL, headers: ada, payload: { command: '   ' } })
  assert.equal(blank.statusCode, 400)

  const badMode = await app.inject({
    method: 'PUT',
    url: URL,
    headers: ada,
    payload: { command: 'ls', policy: { mode: 'magic', rules: [] } },
  })
  assert.equal(badMode.statusCode, 400)
  assert.equal(badMode.json().message, 'mode must be "denylist" or "allowlist"')

  const badRegex = await app.inject({
    method: 'PUT',
    url: URL,
    headers: ada,
    payload: { command: 'ls', policy: { mode: 'denylist', rules: [{ pattern: '(x+x+)+y', decision: 'deny' }] } },
  })
  assert.equal(badRegex.statusCode, 400)
  assert.match(badRegex.json().message, /rules\[0\]\.pattern is not a valid regex/)
  await app.close()
})

test('admin command-policy-simulate: non-admin gets the guard ladder 403', async () => {
  const { app } = rig()
  const stranger = auth(await token('person:stranger'))
  const res = await app.inject({ method: 'PUT', url: URL, headers: stranger, payload: { command: 'ls' } })
  assert.equal(res.statusCode, 403)
  await app.close()
})

test('admin impersonate: start audits and answers displayName; stop audits the lifecycle end (X2, qm parity)', async () => {  const { app, auditLog } = rig()
  const ada = auth(await token('person:ada'))

  const noTarget = await app.inject({ method: 'POST', url: '/v1/admin/impersonate', headers: ada, payload: {} })
  assert.equal(noTarget.statusCode, 400)
  assert.equal(noTarget.json().message, 'target principal required')

  const self = await app.inject({ method: 'POST', url: '/v1/admin/impersonate', headers: ada, payload: { target: 'person:ada' } })
  assert.equal(self.statusCode, 400)
  assert.equal(self.json().message, 'cannot impersonate yourself')

  const stranger = auth(await token('person:stranger'))
  const forbidden = await app.inject({ method: 'POST', url: '/v1/admin/impersonate', headers: stranger, payload: { target: 'person:ada' } })
  assert.equal(forbidden.statusCode, 403)

  const started = await app.inject({ method: 'POST', url: '/v1/admin/impersonate', headers: ada, payload: { target: 'feishu:gang' } })
  assert.equal(started.statusCode, 200)
  assert.deepEqual(started.json(), { ok: true, target: 'feishu:gang', displayName: 'feishu:gang' })

  const stopped = await app.inject({ method: 'POST', url: '/v1/admin/impersonate/stop', headers: ada, payload: { target: 'feishu:gang' } })
  assert.equal(stopped.statusCode, 200)
  assert.deepEqual(stopped.json(), { ok: true })

  const events = await auditLog.tail({ limit: 10 })
  const startEvent = events.find((e) => e.action === 'impersonate.start')
  const stopEvent = events.find((e) => e.action === 'impersonate.stop')
  assert.ok(startEvent)
  assert.equal(startEvent.principalId, 'person:ada')
  assert.equal(startEvent.resource, 'feishu:gang')
  assert.equal(startEvent.scopeLabel, ORG)
  assert.ok(stopEvent)
  assert.equal(stopEvent.resource, 'feishu:gang')
  await app.close()
})

test('admin command-policy CRUD: put/get/delete round-trips with audit + validation (X3b 4b)', async () => {
  const { app, auditLog } = rig({ commandPolicies: true })
  const ada = auth(await token('person:ada'))

  const missing = await app.inject({ method: 'GET', url: '/v1/admin/scopes/org:test/command-policy', headers: ada })
  assert.equal(missing.statusCode, 200)
  assert.equal(missing.json().policy, null)

  const invalid = await app.inject({
    method: 'PUT',
    url: '/v1/admin/scopes/org:test/command-policy',
    headers: ada,
    payload: { policy: { mode: 'denylist', rules: [{ pattern: '(', decision: 'deny' }] } },
  })
  assert.equal(invalid.statusCode, 400)
  assert.match(invalid.json().message, /pattern is not a valid regex/)

  const put = await app.inject({
    method: 'PUT',
    url: '/v1/admin/scopes/org:test/command-policy',
    headers: ada,
    payload: {
      policy: {
        mode: 'denylist',
        rules: [{ pattern: '\\bkubectl\\b', decision: 'require_approval', reason: 'cluster mutation' }],
      },
    },
  })
  assert.equal(put.statusCode, 200)
  assert.equal(put.json().ok, true)
  assert.equal(put.json().policy.rules.length, 1)

  const got = await app.inject({ method: 'GET', url: '/v1/admin/scopes/org:test/command-policy', headers: ada })
  assert.equal(got.statusCode, 200)
  assert.equal(got.json().policy.rules[0].reason, 'cluster mutation')
  assert.equal(got.json().setBy, 'person:ada')

  const gone = await app.inject({ method: 'DELETE', url: '/v1/admin/scopes/org:test/command-policy', headers: ada })
  assert.equal(gone.statusCode, 200)
  assert.equal(gone.json().deleted, true)
  const afterDelete = await app.inject({ method: 'GET', url: '/v1/admin/scopes/org:test/command-policy', headers: ada })
  assert.equal(afterDelete.json().policy, null)

  const events = await auditLog.tail({ limit: 10 })
  for (const action of ['admin.command_policy.update', 'admin.command_policy.read', 'admin.command_policy.delete']) {
    assert.ok(events.some((e) => e.action === action), `expected audit: ${action}`)
  }
  await app.close()
})

test('admin command-policy simulate: stored scope policy composes over the org floor (qm ruleSource arithmetic)', async () => {
  const { app } = rig({ commandPolicies: true })
  const ada = auth(await token('person:ada'))
  const channelURL = '/v1/admin/scopes/channel:test/command-policy'
  const simulateURL = '/v1/admin/scopes/channel:test/command-policy-simulate'

  await app.inject({
    method: 'PUT',
    url: channelURL,
    headers: ada,
    payload: {
      policy: {
        mode: 'denylist',
        rules: [{ pattern: '\\bhelm\\s+install\\b', decision: 'require_approval', reason: 'scope: helm' }],
      },
    },
  })
  await app.inject({
    method: 'PUT',
    url: '/v1/admin/scopes/org:test/command-policy',
    headers: ada,
    payload: {
      policy: {
        mode: 'denylist',
        rules: [{ pattern: '\\bkubectl\\b', decision: 'deny', reason: 'org: kubectl' }],
      },
    },
  })

  const orgRule = await app.inject({ method: 'PUT', url: simulateURL, headers: ada, payload: { command: 'kubectl get pods' } })
  assert.equal(orgRule.json().decision, 'deny')
  assert.equal(orgRule.json().ruleSource, 'organization', 'org rule fires through the composed policy')
  assert.equal(orgRule.json().ruleIndex, 0)
  assert.equal(orgRule.json().policySource, 'stored')

  const scopeRule = await app.inject({ method: 'PUT', url: simulateURL, headers: ada, payload: { command: 'helm install x' } })
  assert.equal(scopeRule.json().decision, 'require_approval')
  assert.equal(scopeRule.json().ruleSource, 'scope', 'scope rule fires after the silent org floor')
  assert.equal(scopeRule.json().ruleIndex, 0, 'scope-relative rule index')
  assert.equal(scopeRule.json().reason, 'scope: helm')

  const silent = await app.inject({ method: 'PUT', url: simulateURL, headers: ada, payload: { command: 'echo hello' } })
  assert.equal(silent.json().decision, 'allow')
  assert.equal(silent.json().ruleSource, null)

  await app.inject({ method: 'DELETE', url: channelURL, headers: ada })
  const orgStillBinds = await app.inject({ method: 'PUT', url: simulateURL, headers: ada, payload: { command: 'kubectl get pods' } })
  assert.equal(orgStillBinds.json().decision, 'deny', 'stored org policy still binds after scope policy deletion')
  assert.equal(orgStillBinds.json().ruleSource, 'organization')
  await app.close()
})

test('admin command-policy CRUD: 403 for non-admins, 404 when the store is unwired', async () => {
  const wired = rig({ commandPolicies: true })
  const stranger = auth(await token('person:stranger'))
  const forbidden = await wired.app.inject({
    method: 'PUT',
    url: '/v1/admin/scopes/org:test/command-policy',
    headers: stranger,
    payload: { policy: { mode: 'denylist', rules: [] } },
  })
  assert.equal(forbidden.statusCode, 403)
  await wired.app.close()

  const unwired = rig()
  const ada = auth(await token('person:ada'))
  const missing = await unwired.app.inject({
    method: 'PUT',
    url: '/v1/admin/scopes/org:test/command-policy',
    headers: ada,
    payload: { policy: { mode: 'denylist', rules: [] } },
  })
  assert.equal(missing.statusCode, 404)
  await unwired.app.close()
})
