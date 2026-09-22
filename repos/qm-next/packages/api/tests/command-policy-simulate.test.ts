import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@qm/cordis'
import {
  createApiServer,
  createMemoryAdminService,
  createMemoryAuditLog,
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

function rig() {
  const auditLog = createMemoryAuditLog()
  const adminDeps = {
    admin: createMemoryAdminService({ orgId: 'test', seedAdmins: ['person:ada'] }),
    orgScope: ORG,
    auditLog,
  }
  const app = createApiServer({ ...baseDeps(), admin: adminDeps }, OPTS)
  return { app, auditLog }
}

test('admin command-policy-simulate: baseline fallback catches catastrophic commands', async () => {
  const { app, auditLog } = rig()
  const ada = auth(await token('person:ada'))
  const res = await app.inject({ method: 'PUT', url: URL, headers: ada, payload: { command: 'rm -rf /etc' } })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.decision, 'deny')
  assert.equal(body.ruleSource, 'baseline')
  assert.equal(typeof body.ruleIndex, 'number')
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
  assert.equal(body.ruleSource, 'inline')
  assert.equal(body.ruleIndex, 0)
  assert.equal(body.reason, 'cluster mutation')
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

test('admin impersonate: start audits and answers displayName; stop audits the lifecycle end (X2, qm parity)', async () => {
  const { app, auditLog } = rig()
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
