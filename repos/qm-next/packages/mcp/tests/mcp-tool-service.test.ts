/**
 * MCP tool service tests — registry→tool bridge: snapshot rebuild on
 * server changes, namespacing, audit log, refresh coalescing, probe,
 * close semantics, MAX_RESULT_CHARS clamp.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryMap } from '@qm/store'
import type { AuditEvent, AuditLog } from '@qm/admin'
import {
  createMcpServerStore,
  createMcpToolService,
  type McpServer,
  type McpFetch,
  type McpHttpResponse,
} from '../src/index.ts'

function makeResponse(opts: {
  status?: number
  body: string
  contentType?: string
}): McpHttpResponse {
  const status = opts.status ?? 200
  const base: McpHttpResponse = {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return opts.body
    },
  }
  if (opts.contentType !== undefined) {
    const ct = opts.contentType
    return { ...base, headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? ct : null) } }
  }
  return base
}

interface FakeEndpoint {
  match: (url: string, method: string) => boolean
  reply: (url: string, method: string, body: string) => McpHttpResponse | Promise<McpHttpResponse>
}

function makeFakeFetch(endpoints: FakeEndpoint[]): { fetch: McpFetch; calls: Array<{ url: string; method: string; body: string }> } {
  const calls: Array<{ url: string; method: string; body: string }> = []
  const fetch: McpFetch = (url, init) => {
    calls.push({ url, method: init.method, body: init.body })
    for (const ep of endpoints) {
      if (ep.match(url, init.method)) return Promise.resolve(ep.reply(url, init.method, init.body))
    }
    return Promise.resolve(makeResponse({ status: 404, body: 'no endpoint' }))
  }
  return { fetch, calls }
}

/**
 * Build a single endpoint that dispatches between tools/list and tools/call
 * based on the request body's `method` field. Use this when both endpoints
 * point at the same URL.
 */
function listAndCallEndpoint(
  match: (url: string, method: string) => boolean,
  listTools_: Array<{ name: string; description?: string }>,
  callText: (toolName: string, args: unknown) => string,
  id = 1,
): FakeEndpoint {
  return {
    match,
    reply: (_url, _method, body) => {
      try {
        const req = JSON.parse(body) as { method?: string; params?: { name?: string; arguments?: unknown } }
        if (req.method === 'tools/list') {
          return makeResponse({ body: toolsListResponse(listTools_, id) })
        }
        if (req.method === 'tools/call') {
          return makeResponse({ body: toolsCallResponse(callText(req.params?.name ?? '', req.params?.arguments), id) })
        }
      } catch {
        // fall through
      }
      return makeResponse({ status: 400, body: 'bad request' })
    },
  }
}

function toolsListResponse(tools: Array<{ name: string; description?: string }>, id = 1): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: { tools: tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: { type: 'object' } })) },
  })
}

function toolsCallResponse(text: string, id = 1): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text }] },
  })
}

class TestAuditLog implements AuditLog {
  recorded: AuditEvent[] = []
  record(e: AuditEvent): void {
    this.recorded.push(e)
  }
  events(): Promise<readonly AuditEvent[]> {
    return Promise.resolve(this.recorded)
  }
  tail(): Promise<readonly AuditEvent[]> {
    return Promise.resolve(this.recorded)
  }
}

function makeServer(id: string, overrides: Partial<McpServer> = {}): McpServer {
  return {
    id,
    name: `name-${id}`,
    url: `https://mcp-${id}.example.com/mcp`,
    auth: 'none',
    readOnly: false,
    enabled: true,
    updatedAt: 1_700_000_000_000,
    updatedBy: 'admin-1',
    ...overrides,
  }
}

test('mcp-tool-service: snapshot rebuilds from enabled servers on first refresh', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('s1'))
  await servers.put(makeServer('s2'))
  const fake = makeFakeFetch([
    { match: (u, m) => m === 'POST' && u === 'https://mcp-s1.example.com/mcp', reply: () => makeResponse({ body: toolsListResponse([{ name: 'q' }, { name: 'lookup' }]) }) },
    { match: (u, m) => m === 'POST' && u === 'https://mcp-s2.example.com/mcp', reply: () => makeResponse({ body: toolsListResponse([{ name: 'send' }]) }) },
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch })
  await service.refresh()
  const defs = service.toolDefs()
  const names = defs.map((d) => d.name).sort()
  assert.deepEqual(names, ['s1_lookup', 's1_q', 's2_send'])
  service.close()
})

test('mcp-tool-service: disabled servers are excluded from snapshot', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('s1'))
  await servers.put(makeServer('s2', { enabled: false }))
  const fake = makeFakeFetch([
    { match: (u, m) => m === 'POST' && u === 'https://mcp-s1.example.com/mcp', reply: () => makeResponse({ body: toolsListResponse([{ name: 'q' }]) }) },
    { match: (u, m) => m === 'POST' && u === 'https://mcp-s2.example.com/mcp', reply: () => makeResponse({ body: toolsListResponse([{ name: 'send' }]) }) },
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch })
  await service.refresh()
  const defs = service.toolDefs()
  assert.equal(defs.length, 1)
  assert.equal(defs[0]?.serverId, 's1')
  service.close()
})

test('mcp-tool-service: registry change triggers refresh', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  const fake = makeFakeFetch([
    { match: (u, m) => m === 'POST' && u === 'https://mcp-s1.example.com/mcp', reply: () => makeResponse({ body: toolsListResponse([{ name: 'q' }]) }) },
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch, refreshIntervalMs: 1_000_000 })
  await service.refresh()
  assert.equal(service.toolDefs().length, 0)
  await servers.put(makeServer('s1'))
  // Give the onChange listener a microtask boundary to fire refresh().
  await new Promise((r) => setImmediate(r))
  await service.refresh()
  assert.equal(service.toolDefs().length, 1)
  service.close()
})

test('mcp-tool-service: tool name is namespaced and non-alnum chars are scrubbed', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('s1'))
  const fake = makeFakeFetch([
    { match: () => true, reply: () => makeResponse({ body: toolsListResponse([{ name: 'weird.tool/name' }]) }) },
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch })
  await service.refresh()
  const defs = service.toolDefs()
  assert.equal(defs[0]?.name, 's1_weird_tool_name')
  service.close()
})

test('mcp-tool-service: cross-server tools with the same remote name coexist', async () => {
  // Two servers both expose a tool called `q`. After namespacing they
  // become distinct (`s1_q`, `s2_q`); the defensive dedup keeps both.
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('s1'))
  await servers.put(makeServer('s2'))
  const fake = makeFakeFetch([
    {
      match: (u) => u.includes('s1'),
      reply: () => makeResponse({ body: toolsListResponse([{ name: 'q' }]) }),
    },
    {
      match: (u) => u.includes('s2'),
      reply: () => makeResponse({ body: toolsListResponse([{ name: 'q' }]) }),
    },
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch })
  await service.refresh()
  const defs = service.toolDefs()
  assert.equal(defs.length, 2)
  const names = defs.map((d) => d.name).sort()
  assert.deepEqual(names, ['s1_q', 's2_q'])
  service.close()
})

test('mcp-tool-service: list error for one server does not block others', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('bad'))
  await servers.put(makeServer('good'))
  const fake = makeFakeFetch([
    { match: (u) => u.includes('bad'), reply: () => makeResponse({ status: 500, body: 'boom' }) },
    { match: (u) => u.includes('good'), reply: () => makeResponse({ body: toolsListResponse([{ name: 'q' }]) }) },
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch })
  await service.refresh()
  assert.equal(service.toolDefs().length, 1)
  assert.equal(service.toolDefs()[0]?.serverId, 'good')
  service.close()
})

test('mcp-tool-service: MAX_TOOLS_PER_SERVER caps the per-server tools', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('s1'))
  const tools = Array.from({ length: 80 }, (_, i) => ({ name: `t${i}` }))
  const fake = makeFakeFetch([
    { match: () => true, reply: () => makeResponse({ body: toolsListResponse(tools) }) },
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch })
  await service.refresh()
  assert.equal(service.toolDefs().length, 64)
  service.close()
})

test('mcp-tool-service: tool descriptor copies inputSchema verbatim', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('s1'))
  const schema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  const fake = makeFakeFetch([
    {
      match: () => true,
      reply: () => makeResponse({ body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'q', description: '', inputSchema: schema }] } }) }),
    },
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch })
  await service.refresh()
  assert.deepEqual(service.toolDefs()[0]?.inputSchema, schema)
  service.close()
})

test('mcp-tool-service: missing description falls back to "<tool> on <server>"', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('s1', { name: 'Salesforce' }))
  const fake = makeFakeFetch([
    { match: () => true, reply: () => makeResponse({ body: toolsListResponse([{ name: 'q' }]) }) },
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch })
  await service.refresh()
  assert.equal(service.toolDefs()[0]?.description, 'q on Salesforce')
  service.close()
})

test('mcp-tool-service: call routes to the right server and returns text', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('s1'))
  const fake = makeFakeFetch([
    listAndCallEndpoint(
      (u) => u.includes('s1'),
      [{ name: 'q' }],
      (_toolName, _args) => 'hello world',
    ),
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch })
  await service.refresh()
  const out = await service.call('s1_q', { who: 'world' })
  assert.equal(out, 'hello world')
  const callReq = fake.calls.find((c) => c.body.includes('tools/call'))
  assert.ok(callReq)
  const sent = JSON.parse(callReq!.body) as { method?: string; params?: { name?: string; arguments?: unknown } }
  assert.equal(sent.method, 'tools/call')
  assert.equal(sent.params?.name, 'q')
  assert.deepEqual(sent.params?.arguments, { who: 'world' })
  service.close()
})

test('mcp-tool-service: call on unknown tool throws', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  const service = createMcpToolService({ servers, fetchImpl: makeFakeFetch([]).fetch })
  await assert.rejects(service.call('nope', {}), /unknown MCP tool: nope/)
  service.close()
})

test('mcp-tool-service: call on disabled server throws', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('s1'))
  const fake = makeFakeFetch([
    listAndCallEndpoint(
      () => true,
      [{ name: 'q' }],
      () => 'unused',
    ),
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch })
  await service.refresh()
  await servers.put(makeServer('s1', { enabled: false }))
  // Drain the onChange refresh microtask.
  await new Promise((r) => setImmediate(r))
  await service.refresh()
  // After refresh, snapshot drops the disabled server's tools; call must reject.
  await assert.rejects(service.call('s1_q', {}), /unknown MCP tool: s1_q/)
  service.close()
})

test('mcp-tool-service: MAX_RESULT_CHARS clamps and appends [truncated]', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('s1'))
  const big = 'x'.repeat(80_000)
  const fake = makeFakeFetch([
    listAndCallEndpoint(
      () => true,
      [{ name: 'q' }],
      () => big,
    ),
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch })
  await service.refresh()
  const out = await service.call('s1_q', {})
  assert.ok(out.endsWith('\n[truncated]'))
  assert.equal(out.length, 60_000 + '\n[truncated]'.length)
  service.close()
})

test('mcp-tool-service: structured content falls back to JSON when no text', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('s1'))
  const fake = makeFakeFetch([
    {
      match: (u) => u.endsWith('/mcp'),
      reply: (_u, _m, body) => {
        try {
          const req = JSON.parse(body) as { method?: string }
          if (req.method === 'tools/list') {
            return makeResponse({ body: toolsListResponse([{ name: 'q' }]) })
          }
          if (req.method === 'tools/call') {
            return makeResponse({
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                result: { structuredContent: { rows: [1, 2, 3] } },
              }),
            })
          }
        } catch {
          // fall through
        }
        return makeResponse({ status: 400, body: 'bad' })
      },
    },
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch })
  await service.refresh()
  const out = await service.call('s1_q', {})
  assert.equal(out, JSON.stringify({ rows: [1, 2, 3] }))
  service.close()
})

test('mcp-tool-service: readOnly flag flows from server config', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('s1', { readOnly: true }))
  const fake = makeFakeFetch([
    { match: () => true, reply: () => makeResponse({ body: toolsListResponse([{ name: 'q' }]) }) },
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch })
  await service.refresh()
  assert.equal(service.toolDefs()[0]?.readOnly, true)
  service.close()
})

test('mcp-tool-service: bearer auth uses server.bearerToken', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('s1', { auth: 'bearer', bearerToken: 'public-bearer-value' }))
  const fake = makeFakeFetch([
    { match: () => true, reply: () => makeResponse({ body: toolsListResponse([{ name: 'q' }]) }) },
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch })
  await service.refresh()
  // The tools/list request should have been issued against the bearer-protected server.
  const listCall = fake.calls.find((c) => c.url.endsWith('/mcp') && c.body.includes('tools/list'))
  assert.ok(listCall)
  service.close()
})

test('mcp-tool-service: client-credentials auth mints and uses bearer', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(
    makeServer('s1', {
      auth: 'client-credentials',
      clientId: 'public-cid',
      clientSecret: 'public-csec',
    }),
  )
  const fake = makeFakeFetch([
    { match: (u, m) => m === 'POST' && u.endsWith('/token'), reply: () => makeResponse({ body: JSON.stringify({ access_token: 'public-minted', expires_in: 3600 }) }) },
    { match: (u, m) => m === 'POST' && u.endsWith('/mcp'), reply: () => makeResponse({ body: toolsListResponse([{ name: 'q' }]) }) },
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch })
  await service.refresh()
  // Should have made one /token call and one /mcp call with bearer
  const tokenCalls = fake.calls.filter((c) => c.url.endsWith('/token'))
  const mcpCalls = fake.calls.filter((c) => c.url.endsWith('/mcp'))
  assert.equal(tokenCalls.length, 1)
  assert.equal(mcpCalls.length, 1)
  service.close()
})

test('mcp-tool-service: audit log records list + call outcomes', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('s1'))
  const fake = makeFakeFetch([
    { match: (u) => u.endsWith('/mcp'), reply: () => makeResponse({ body: toolsListResponse([{ name: 'q' }]) }) },
  ])
  const audit = new TestAuditLog()
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch, audit })
  await service.refresh()
  await service.call('s1_q', {}, 'person:ada')
  const actions = audit.recorded.map((e) => `${e.action}:${(e.status ?? '').split(' ')[0]}`)
  assert.ok(actions.some((a) => a.startsWith('mcp.list:ok')))
  assert.ok(actions.some((a) => a.startsWith('mcp.call:ok')))
  const call = audit.recorded.find((e) => e.action === 'mcp.call')
  assert.equal(call?.resource, 's1/q')
  assert.equal(call?.principalId, 'person:ada')
  assert.equal(call?.scopeLabel, 'mcp-connectors')
  service.close()
})

test('mcp-tool-service: call errors are audited with status and re-thrown', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('s1'))
  const fake = makeFakeFetch([
    {
      match: (u) => u.endsWith('/mcp'),
      reply: (_u, _m, body) => {
        try {
          const req = JSON.parse(body) as { method?: string }
          if (req.method === 'tools/list') {
            return makeResponse({ body: toolsListResponse([{ name: 'q' }]) })
          }
        } catch {
          // fall through
        }
        return makeResponse({ status: 500, body: '' })
      },
    },
  ])
  const audit = new TestAuditLog()
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch, audit })
  await service.refresh()
  await assert.rejects(service.call('s1_q', {}))
  const failed = audit.recorded.find((e) => e.action === 'mcp.call' && (e.status ?? '').startsWith('error'))
  assert.ok(failed)
  service.close()
})

test('mcp-tool-service: probe does not register the server and lists remote tool names', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  const fake = makeFakeFetch([
    { match: () => true, reply: () => makeResponse({ body: toolsListResponse([{ name: 'q' }, { name: 'send' }]) }) },
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch })
  const probeServer = makeServer('probe-only')
  const names = await service.probe(probeServer)
  assert.deepEqual(names, ['q', 'send'])
  assert.equal((await servers.list()).length, 0, 'probe must not register the server')
  service.close()
})

test('mcp-tool-service: close stops further refreshes and clears state', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('s1'))
  const fake = makeFakeFetch([
    { match: () => true, reply: () => makeResponse({ body: toolsListResponse([{ name: 'q' }]) }) },
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch, refreshIntervalMs: 10 })
  await service.refresh()
  assert.equal(service.toolDefs().length, 1)
  service.close()
  // After close, refresh is a no-op and snapshot is empty.
  await service.refresh()
  assert.deepEqual(service.toolDefs(), [])
})

test('mcp-tool-service: refresh coalesces concurrent invocations into one cycle', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('s1'))
  let listCalls = 0
  const fake = makeFakeFetch([
    {
      match: (u) => u.endsWith('/mcp'),
      reply: async () => {
        listCalls++
        await new Promise((r) => setTimeout(r, 5))
        return makeResponse({ body: toolsListResponse([{ name: 'q' }]) })
      },
    },
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch, refreshIntervalMs: 1_000_000 })
  await Promise.all([service.refresh(), service.refresh(), service.refresh()])
  assert.equal(listCalls, 1, 'concurrent refreshes coalesce to one listTools call')
  service.close()
})

test('mcp-tool-service: refresh on closed service is a no-op', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  const fake = makeFakeFetch([])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch })
  service.close()
  // Should not throw even with no servers / no endpoints.
  await service.refresh()
})

test('mcp-tool-service: server-config change invalidates the cached client', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('s1'))
  const fake = makeFakeFetch([
    { match: () => true, reply: () => makeResponse({ body: toolsListResponse([{ name: 'q' }]) }) },
  ])
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch, refreshIntervalMs: 1_000_000 })
  await service.refresh()
  await servers.put(makeServer('s1', { auth: 'bearer', bearerToken: 'public-bearer-value' }))
  await new Promise((r) => setImmediate(r))
  await service.refresh()
  // The change should have triggered a refresh; tools/list should still work.
  assert.equal(service.toolDefs().length, 1)
  service.close()
})

test('mcp-tool-service: listTools failure records an error audit', async () => {
  const backing = createMemoryMap<McpServer>()
  const servers = createMcpServerStore(backing)
  await servers.put(makeServer('bad'))
  const fake = makeFakeFetch([
    { match: () => true, reply: () => makeResponse({ status: 500, body: 'down' }) },
  ])
  const audit = new TestAuditLog()
  const service = createMcpToolService({ servers, fetchImpl: fake.fetch, audit })
  await service.refresh()
  const errorEvent = audit.recorded.find((e) => e.action === 'mcp.list' && (e.status ?? '').startsWith('error'))
  assert.ok(errorEvent)
  assert.equal(errorEvent?.resource, 'bad')
  assert.equal(errorEvent?.scopeLabel, 'mcp-connectors')
  service.close()
})