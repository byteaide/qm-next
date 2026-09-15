import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@qm/cordis'
import { createMemoryMap } from '@qm/store'
import {
  createMcpServerStore,
  createMcpToolService,
  type McpFetch,
  type McpHttpResponse,
} from '@qm/mcp'
import {
  adminRoutes,
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

const SECRET = 'integration-secret-please-rotate'
const SCOPE: ScopeId = 'org:test'
const ORG = 'org:test'
const OPTS: ApiServerOptions = { secrets: [SECRET] }

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

interface FakeEndpoint {
  match: (url: string, method: string) => boolean
  reply: (url: string, method: string, body: string) => McpHttpResponse | Promise<McpHttpResponse>
}

function jsonRpcResponse(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function makeResponse(opts: { status?: number; body: string }): McpHttpResponse {
  const status = opts.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return opts.body
    },
  }
}

function makeFakeFetch(endpoints: FakeEndpoint[]): McpFetch {
  const fetch: McpFetch = (url, init) => {
    for (const ep of endpoints) {
      if (ep.match(url, init.method)) return Promise.resolve(ep.reply(url, init.method, init.body))
    }
    return Promise.resolve(makeResponse({ status: 404, body: 'no endpoint' }))
  }
  return fetch
}

function tokenEndpoint(matchUrlPrefix: string): FakeEndpoint {
  return {
    match: (url, method) => url === `${matchUrlPrefix}/token` && method === 'POST',
    reply: () =>
      makeResponse({ body: JSON.stringify({ access_token: 'tok-stub', expires_in: 3600 }) }),
  }
}

function listEndpoint(matchUrlPrefix: string, toolNames: string[]): FakeEndpoint {
  return {
    match: (url, method) => url === `${matchUrlPrefix}/mcp` && method === 'POST',
    reply: (_url, _method, body) => {
      try {
        const req = JSON.parse(body) as { id?: number; method?: string }
        if (req.method === 'tools/list') {
          return makeResponse({ body: jsonRpcResponse(req.id ?? 1, { tools: toolNames.map((n) => ({ name: n, description: `desc:${n}`, inputSchema: { type: 'object' } })) }) })
        }
        return makeResponse({ status: 400, body: 'unsupported method' })
      } catch {
        return makeResponse({ status: 400, body: 'bad json' })
      }
    },
  }
}

function probeServer(url: string, toolNames: string[]): McpFetch {
  return makeFakeFetch([tokenEndpoint(url), listEndpoint(url, toolNames)])
}

interface McpTestRig {
  backing: ReturnType<typeof createMemoryMap>
  servers: ReturnType<typeof createMcpServerStore>
  toolService: ReturnType<typeof createMcpToolService>
  adminDeps: Parameters<typeof adminRoutes>[0]
  app: ReturnType<typeof createApiServer>
}

function rigWithFetch(fetchImpl: McpFetch): McpTestRig {
  const backing = createMemoryMap()
  const servers = createMcpServerStore(backing)
  const toolService = createMcpToolService({ servers, fetchImpl, refreshIntervalMs: 1_000_000 })
  const adminDeps = {
    admin: createMemoryAdminService({ orgId: 'test', seedAdmins: ['person:ada'] }),
    orgScope: ORG,
    auditLog: createMemoryAuditLog(),
    mcp: { servers, toolService },
  }
  const app = createApiServer({ ...baseDeps(), admin: adminDeps }, OPTS)
  return { backing, servers, toolService, adminDeps, app }
}

test('admin mcp: guard ladder (unwired 404, non-admin 403)', async () => {
  const backing = createMemoryMap()
  const servers = createMcpServerStore(backing)
  const toolService = createMcpToolService({ servers, refreshIntervalMs: 1_000_000 })

  const unwired = createApiServer({ ...baseDeps(), admin: { admin: createMemoryAdminService({ orgId: 'test', seedAdmins: ['person:ada'] }), orgScope: ORG } }, OPTS)
  const unwiredRes = await unwired.inject({ method: 'GET', url: '/v1/admin/mcp-servers', headers: auth(await token('person:ada')) })
  assert.equal(unwiredRes.statusCode, 404)
  await unwired.close()

  const app = createApiServer({ ...baseDeps(), admin: { admin: createMemoryAdminService({ orgId: 'test', seedAdmins: ['person:ada'] }), orgScope: ORG, mcp: { servers, toolService } } }, OPTS)
  const stranger = await app.inject({ method: 'GET', url: '/v1/admin/mcp-servers', headers: auth(await token('person:stranger')) })
  assert.equal(stranger.statusCode, 403)
  assert.equal(stranger.json().message, 'admin grant required for this scope')

  const listOk = await app.inject({ method: 'GET', url: '/v1/admin/mcp-servers', headers: auth(await token('person:ada')) })
  assert.equal(listOk.statusCode, 200)
  assert.deepEqual(listOk.json(), { servers: [], tools: [] })
  await app.close()
})

test('admin mcp: PUT validates id, url, auth, and creds; persists; redacts in GET', async () => {
  const fetchImpl = probeServer('https://mcp.example', ['echo', 'fetch'])
  const rig = rigWithFetch(fetchImpl)
  const ada = auth(await token('person:ada'))

  const badId = await rig.app.inject({ method: 'PUT', url: '/v1/admin/mcp-servers/BadID?scope=org:test', headers: ada, payload: { url: 'https://mcp.example' } })
  assert.equal(badId.statusCode, 400)
  assert.match(badId.json().message, /id must be/)

  const badUrl = await rig.app.inject({ method: 'PUT', url: '/v1/admin/mcp-servers/srv1?scope=org:test', headers: ada, payload: { url: 'not a url' } })
  assert.equal(badUrl.statusCode, 400)
  assert.equal(badUrl.json().message, 'url must be a valid URL')

  const nonHttp = await rig.app.inject({ method: 'PUT', url: '/v1/admin/mcp-servers/srv1?scope=org:test', headers: ada, payload: { url: 'ftp://mcp.example' } })
  assert.equal(nonHttp.statusCode, 400)
  assert.equal(nonHttp.json().message, 'url must be http(s)')

  const credsInUrl = await rig.app.inject({ method: 'PUT', url: '/v1/admin/mcp-servers/srv1?scope=org:test', headers: ada, payload: { url: 'https://user:pass@mcp.example' } })
  assert.equal(credsInUrl.statusCode, 400)
  assert.equal(credsInUrl.json().message, 'url must not carry credentials, query, or fragment')

  const badAuth = await rig.app.inject({ method: 'PUT', url: '/v1/admin/mcp-servers/srv1?scope=org:test', headers: ada, payload: { url: 'https://mcp.example', auth: 'magic' } })
  assert.equal(badAuth.statusCode, 400)
  assert.match(badAuth.json().message, /auth must be one of/)

  const bearerMissing = await rig.app.inject({ method: 'PUT', url: '/v1/admin/mcp-servers/srv1?scope=org:test', headers: ada, payload: { url: 'https://mcp.example', auth: 'bearer' } })
  assert.equal(bearerMissing.statusCode, 400)
  assert.equal(bearerMissing.json().message, 'bearer auth requires bearerToken')

  const ccMissing = await rig.app.inject({ method: 'PUT', url: '/v1/admin/mcp-servers/srv1?scope=org:test', headers: ada, payload: { url: 'https://mcp.example', auth: 'client-credentials', clientSecret: 'secret' } })
  assert.equal(ccMissing.statusCode, 400)
  assert.equal(ccMissing.json().message, 'client-credentials auth requires clientId and clientSecret')

  const created = await rig.app.inject({
    method: 'PUT',
    url: '/v1/admin/mcp-servers/srv1?scope=org:test',
    headers: ada,
    payload: { url: 'https://mcp.example', auth: 'bearer', bearerToken: 'tok-1', validate: false },
  })
  assert.equal(created.statusCode, 200)
  assert.equal(created.json().ok, true)
  assert.equal(created.json().server.id, 'srv1')
  assert.equal(created.json().server.hasBearerToken, true)
  assert.equal(created.json().server.hasClientSecret, false)
  assert.equal(created.json().server.bearerToken, undefined, 'must not leak secret in response')

  const updated = await rig.app.inject({
    method: 'PUT',
    url: '/v1/admin/mcp-servers/srv1?scope=org:test',
    headers: ada,
    payload: { url: 'https://mcp.example', name: 'Renamed', enabled: false, readOnly: true, validate: false },
  })
  assert.equal(updated.statusCode, 200)
  assert.equal(updated.json().server.name, 'Renamed')
  assert.equal(updated.json().server.enabled, false)
  assert.equal(updated.json().server.readOnly, true)

  const withTools = await rig.app.inject({
    method: 'PUT',
    url: '/v1/admin/mcp-servers/srv2?scope=org:test',
    headers: ada,
    payload: { url: 'https://mcp.example', name: 'Probe Run' },
  })
  assert.equal(withTools.statusCode, 200)
  assert.deepEqual(withTools.json().tools, ['echo', 'fetch'])

  const list = await rig.app.inject({ method: 'GET', url: '/v1/admin/mcp-servers?scope=org:test', headers: ada })
  assert.equal(list.statusCode, 200)
  const payload = list.json() as { servers: Array<Record<string, unknown>> }
  assert.equal(payload.servers.length, 2)
  assert.equal(payload.servers[0].id, 'srv1', 'list is sorted by id')
  assert.equal(payload.servers[1].id, 'srv2')
  for (const s of payload.servers) {
    assert.equal(s.bearerToken, undefined, 'list redacts bearerToken')
    assert.equal(s.clientSecret, undefined, 'list redacts clientSecret')
  }

  await rig.app.close()
  rig.toolService.close()
})

test('admin mcp: probe failure maps to 400 unreachable', async () => {
  const fetchImpl = makeFakeFetch([
    { match: () => true, reply: () => Promise.resolve(makeResponse({ status: 500, body: 'kaboom' })) },
  ])
  const rig = rigWithFetch(fetchImpl)
  const ada = auth(await token('person:ada'))

  const probe = await rig.app.inject({
    method: 'PUT',
    url: '/v1/admin/mcp-servers/srv1?scope=org:test',
    headers: ada,
    payload: { url: 'https://mcp.example' },
  })
  assert.equal(probe.statusCode, 400)
  assert.equal(probe.json().error, 'unreachable')

  const skipProbe = await rig.app.inject({
    method: 'PUT',
    url: '/v1/admin/mcp-servers/srv2?scope=org:test',
    headers: ada,
    payload: { url: 'https://mcp.example', validate: false },
  })
  assert.equal(skipProbe.statusCode, 200)
  assert.equal(skipProbe.json().tools, undefined)

  await rig.app.close()
  rig.toolService.close()
})

test('admin mcp: client-credentials inherits prior creds on patch; rejects when none exist', async () => {
  const fetchImpl = probeServer('https://mcp.example', ['echo'])
  const rig = rigWithFetch(fetchImpl)
  const ada = auth(await token('person:ada'))

  const seed = await rig.app.inject({
    method: 'PUT',
    url: '/v1/admin/mcp-servers/srv1?scope=org:test',
    headers: ada,
    payload: { url: 'https://mcp.example', auth: 'client-credentials', clientId: 'cid-1', clientSecret: 'csec-1', validate: false },
  })
  assert.equal(seed.statusCode, 200)
  assert.equal(seed.json().server.hasClientSecret, true)

  const inherit = await rig.app.inject({
    method: 'PUT',
    url: '/v1/admin/mcp-servers/srv1?scope=org:test',
    headers: ada,
    payload: { url: 'https://mcp.example', auth: 'client-credentials' },
  })
  assert.equal(inherit.statusCode, 200, 'omitted creds inherit from existing record')
  assert.equal(inherit.json().server.hasClientSecret, true)

  const override = await rig.app.inject({
    method: 'PUT',
    url: '/v1/admin/mcp-servers/srv1?scope=org:test',
    headers: ada,
    payload: { url: 'https://mcp.example', auth: 'client-credentials', clientSecret: 'csec-2' },
  })
  assert.equal(override.statusCode, 200, 'partial override keeps clientId from prior record')
  assert.equal(override.json().server.hasClientSecret, true)

  const fresh = await rig.app.inject({
    method: 'PUT',
    url: '/v1/admin/mcp-servers/srv2?scope=org:test',
    headers: ada,
    payload: { url: 'https://mcp.example', auth: 'client-credentials', validate: false },
  })
  assert.equal(fresh.statusCode, 400, 'no prior creds and no body creds is refused')

  await rig.app.close()
  rig.toolService.close()
})

test('admin mcp: DELETE removes the entry, 404 on unknown; audit logs the action', async () => {
  const fetchImpl = probeServer('https://mcp.example', [])
  const rig = rigWithFetch(fetchImpl)
  const ada = auth(await token('person:ada'))

  const seed = await rig.app.inject({
    method: 'PUT',
    url: '/v1/admin/mcp-servers/srv1?scope=org:test',
    headers: ada,
    payload: { url: 'https://mcp.example', validate: false },
  })
  assert.equal(seed.statusCode, 200)

  const missing = await rig.app.inject({ method: 'DELETE', url: '/v1/admin/mcp-servers/nope?scope=org:test', headers: ada })
  assert.equal(missing.statusCode, 404)

  const removed = await rig.app.inject({ method: 'DELETE', url: '/v1/admin/mcp-servers/srv1?scope=org:test', headers: ada })
  assert.equal(removed.statusCode, 200)
  assert.deepEqual(removed.json(), { ok: true })

  const list = await rig.app.inject({ method: 'GET', url: '/v1/admin/mcp-servers?scope=org:test', headers: ada })
  assert.equal(list.json().servers.length, 0)

  const audit = await rig.app.inject({ method: 'GET', url: '/v1/admin/audit?scope=org:test', headers: ada })
  const events = audit.json().events as Array<{ action: string; resource: string; scopeLabel: string }>
  assert.ok(events.some((e) => e.action === 'mcp-servers.update' && e.resource === 'srv1'))
  assert.ok(events.some((e) => e.action === 'mcp-servers.delete' && e.resource === 'srv1'))
  assert.ok(events.every((e) => !e.action.startsWith('mcp-servers') || e.scopeLabel === ORG))

  await rig.app.close()
  rig.toolService.close()
})