/**
 * MCP transport tests — JSON-RPC framing, auth modes, envelope parsing
 * (JSON + SSE), error propagation, input schema defaults.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createMcpClient,
  mcpResultText,
  type McpFetch,
  type McpHttpResponse,
} from '../src/index.ts'

function makeResponse(opts: {
  status?: number
  contentType?: string
  body: string
}): McpHttpResponse {
  const status = opts.status ?? 200
  const base: McpHttpResponse = {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return opts.body
    },
  }
  if (opts.contentType) {
    const ct = opts.contentType
    return {
      ...base,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? ct : null) },
    }
  }
  return base
}

function makeRecorder(opts: {
  responses: Array<{ url: string; method: string; body: string; status?: number; contentType?: string }>
}): { fetch: McpFetch; calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> } {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = []
  let i = 0
  const fetch: McpFetch = (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    const fallback = opts.responses[opts.responses.length - 1]
    const r = opts.responses[i++] ?? fallback
    if (!r) throw new Error('makeRecorder: no responses configured')
    const responseOpts: { body: string; status?: number; contentType?: string } = { body: r.body }
    if (r.status !== undefined) responseOpts.status = r.status
    if (r.contentType !== undefined) responseOpts.contentType = r.contentType
    return Promise.resolve(makeResponse(responseOpts))
  }
  return { fetch, calls }
}

test('mcp-client: listTools parses JSON envelope', async () => {
  const rec = makeRecorder({
    responses: [
      {
        url: 'https://mcp.example.com/mcp',
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [
              { name: 'query', description: 'Run a query', inputSchema: { type: 'object' } },
              { name: 'lookup', description: '', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
            ],
          },
        }),
      },
    ],
  })
  const client = createMcpClient({ url: 'https://mcp.example.com/mcp', auth: { mode: 'none' }, fetchImpl: rec.fetch })
  const tools = await client.listTools()
  assert.equal(tools.length, 2)
  assert.equal(tools[0]?.name, 'query')
  assert.equal(tools[0]?.description, 'Run a query')
  assert.equal(tools[1]?.description, '')
  assert.equal(rec.calls[0]?.headers.accept, 'application/json, text/event-stream')
})

test('mcp-client: missing description and missing inputSchema use defaults', async () => {
  const rec = makeRecorder({
    responses: [
      {
        url: 'https://mcp.example.com/mcp',
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [{ name: 'bare' }],
          },
        }),
      },
    ],
  })
  const client = createMcpClient({ url: 'https://mcp.example.com/mcp', auth: { mode: 'none' }, fetchImpl: rec.fetch })
  const tools = await client.listTools()
  assert.equal(tools[0]?.description, '')
  assert.deepEqual(tools[0]?.inputSchema, { type: 'object', properties: {} })
})

test('mcp-client: non-string tool name is filtered out', async () => {
  const rec = makeRecorder({
    responses: [
      {
        url: 'https://mcp.example.com/mcp',
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [{ name: 42 }, { name: '' }, { name: 'ok' }],
          },
        }),
      },
    ],
  })
  const client = createMcpClient({ url: 'https://mcp.example.com/mcp', auth: { mode: 'none' }, fetchImpl: rec.fetch })
  const tools = await client.listTools()
  assert.equal(tools.length, 1)
  assert.equal(tools[0]?.name, 'ok')
})

test('mcp-client: missing tools array yields empty list', async () => {
  const rec = makeRecorder({
    responses: [
      { url: 'https://mcp.example.com/mcp', method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) },
    ],
  })
  const client = createMcpClient({ url: 'https://mcp.example.com/mcp', auth: { mode: 'none' }, fetchImpl: rec.fetch })
  const tools = await client.listTools()
  assert.deepEqual(tools, [])
})

test('mcp-client: bearer auth sets Bearer token header', async () => {
  const rec = makeRecorder({
    responses: [
      {
        url: 'https://mcp.example.com/mcp',
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
      },
    ],
  })
  const client = createMcpClient({
    url: 'https://mcp.example.com/mcp',
    auth: { mode: 'bearer', token: 'public-bearer-test-value' },
    fetchImpl: rec.fetch,
  })
  await client.listTools()
  assert.equal(rec.calls[0]?.headers.authorization, 'Bearer public-bearer-test-value')
})

test('mcp-client: client-credentials mints and caches token', async () => {
  const rec = makeRecorder({
    responses: [
      { url: 'https://mcp.example.com/token', method: 'POST', body: JSON.stringify({ access_token: 'public-minted-token', expires_in: 3600 }) },
      { url: 'https://mcp.example.com/mcp', method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }) },
      { url: 'https://mcp.example.com/mcp', method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } }) },
    ],
  })
  const client = createMcpClient({
    url: 'https://mcp.example.com/mcp',
    auth: { mode: 'client-credentials', clientId: 'public-test-client', clientSecret: 'public-test-secret' },
    fetchImpl: rec.fetch,
  })
  await client.listTools()
  await client.listTools()
  // First call mints; both rpcs should reuse the cached token.
  assert.equal(rec.calls.filter((c) => c.url.endsWith('/token')).length, 1)
  assert.equal(rec.calls[1]?.headers.authorization, 'Bearer public-minted-token')
  assert.equal(rec.calls[2]?.headers.authorization, 'Bearer public-minted-token')
  // Token mint body carries grant_type and credentials form-encoded.
  const tokenReq = rec.calls[0]
  assert.equal(tokenReq?.headers['content-type'], 'application/x-www-form-urlencoded')
  assert.match(tokenReq?.body ?? '', /grant_type=client_credentials/)
  assert.match(tokenReq?.body ?? '', /client_id=public-test-client/)
})

test('mcp-client: client-credentials re-mints past the skew window', async () => {
  const rec = makeRecorder({
    responses: [
      { url: 'https://mcp.example.com/token', method: 'POST', body: JSON.stringify({ access_token: 'first', expires_in: 1 }) },
      { url: 'https://mcp.example.com/mcp', method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }) },
      { url: 'https://mcp.example.com/token', method: 'POST', body: JSON.stringify({ access_token: 'second', expires_in: 3600 }) },
      { url: 'https://mcp.example.com/mcp', method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } }) },
    ],
  })
  // expires_in=1 ⇒ cached.expiresAt = now + 1000ms. Advance clock past the 60s skew
  // window so the next mint refreshes the token.
  let t = 1_000_000
  const now = () => t
  const client = createMcpClient({
    url: 'https://mcp.example.com/mcp',
    auth: { mode: 'client-credentials', clientId: 'public-test-client', clientSecret: 'public-test-secret' },
    fetchImpl: rec.fetch,
    now,
  })
  await client.listTools()
  t += 2 * 60_000 + 1
  await client.listTools()
  assert.equal(rec.calls.filter((c) => c.url.endsWith('/token')).length, 2)
  assert.equal(rec.calls[1]?.headers.authorization, 'Bearer first')
  assert.equal(rec.calls[3]?.headers.authorization, 'Bearer second')
})

test('mcp-client: token mint error throws', async () => {
  const rec = makeRecorder({
    responses: [{ url: 'https://mcp.example.com/token', method: 'POST', body: '', status: 500 }],
  })
  const client = createMcpClient({
    url: 'https://mcp.example.com/mcp',
    auth: { mode: 'client-credentials', clientId: 'public-test-client', clientSecret: 'public-test-secret' },
    fetchImpl: rec.fetch,
  })
  await assert.rejects(client.listTools(), /token mint failed/)
})

test('mcp-client: token mint missing access_token throws', async () => {
  const rec = makeRecorder({
    responses: [{ url: 'https://mcp.example.com/token', method: 'POST', body: JSON.stringify({}) }],
  })
  const client = createMcpClient({
    url: 'https://mcp.example.com/mcp',
    auth: { mode: 'client-credentials', clientId: 'public-test-client', clientSecret: 'public-test-secret' },
    fetchImpl: rec.fetch,
  })
  await assert.rejects(client.listTools(), /no access_token/)
})

test('mcp-client: HTTP error on rpc throws with method name', async () => {
  const rec = makeRecorder({
    responses: [{ url: 'https://mcp.example.com/mcp', method: 'POST', body: '', status: 502 }],
  })
  const client = createMcpClient({ url: 'https://mcp.example.com/mcp', auth: { mode: 'none' }, fetchImpl: rec.fetch })
  await assert.rejects(client.listTools(), /mcp tools\/list failed \(HTTP 502\)/)
})

test('mcp-client: rpc returns non-JSON throws', async () => {
  const rec = makeRecorder({
    responses: [{ url: 'https://mcp.example.com/mcp', method: 'POST', body: 'not json' }],
  })
  const client = createMcpClient({ url: 'https://mcp.example.com/mcp', auth: { mode: 'none' }, fetchImpl: rec.fetch })
  await assert.rejects(client.listTools(), /returned non-JSON/)
})

test('mcp-client: JSON-RPC error envelope throws with message', async () => {
  const rec = makeRecorder({
    responses: [
      {
        url: 'https://mcp.example.com/mcp',
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'rate limited' } }),
      },
    ],
  })
  const client = createMcpClient({ url: 'https://mcp.example.com/mcp', auth: { mode: 'none' }, fetchImpl: rec.fetch })
  await assert.rejects(client.listTools(), /mcp tools\/list error: rate limited/)
})

test('mcp-client: SSE envelope is parsed and matched by id', async () => {
  const rec = makeRecorder({
    responses: [
      {
        url: 'https://mcp.example.com/mcp',
        method: 'POST',
        body:
          'event: message\n' +
          'data: {"jsonrpc":"2.0","id":99,"result":{"keepalive":true}}\n' +
          '\n' +
          'event: message\n' +
          'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"q","description":"d","inputSchema":{"type":"object"}}]}}\n' +
          '\n',
        contentType: 'text/event-stream',
      },
    ],
  })
  const client = createMcpClient({ url: 'https://mcp.example.com/mcp', auth: { mode: 'none' }, fetchImpl: rec.fetch })
  const tools = await client.listTools()
  assert.equal(tools.length, 1)
  assert.equal(tools[0]?.name, 'q')
})

test('mcp-client: SSE without matching id still finds a result-carrying envelope', async () => {
  const rec = makeRecorder({
    responses: [
      {
        url: 'https://mcp.example.com/mcp',
        method: 'POST',
        body:
          'event: message\n' +
          'data: {"jsonrpc":"2.0","id":42,"result":{"tools":[]}}\n' +
          '\n',
        contentType: 'text/event-stream',
      },
    ],
  })
  const client = createMcpClient({ url: 'https://mcp.example.com/mcp', auth: { mode: 'none' }, fetchImpl: rec.fetch })
  const tools = await client.listTools()
  assert.deepEqual(tools, [])
})

test('mcp-client: callTool forwards arguments and returns content', async () => {
  const rec = makeRecorder({
    responses: [
      {
        url: 'https://mcp.example.com/mcp',
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: 'hello' }] },
        }),
      },
    ],
  })
  const client = createMcpClient({ url: 'https://mcp.example.com/mcp', auth: { mode: 'none' }, fetchImpl: rec.fetch })
  const result = await client.callTool('greet', { who: 'world' })
  assert.deepEqual(result.content, [{ type: 'text', text: 'hello' }])
  const sent = JSON.parse(rec.calls[0]?.body ?? '{}') as { method?: string; params?: { name?: string; arguments?: unknown } }
  assert.equal(sent.method, 'tools/call')
  assert.equal(sent.params?.name, 'greet')
  assert.deepEqual(sent.params?.arguments, { who: 'world' })
})

test('mcp-client: callTool isError throws with text detail', async () => {
  const rec = makeRecorder({
    responses: [
      {
        url: 'https://mcp.example.com/mcp',
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { isError: true, content: [{ type: 'text', text: 'bad query' }] },
        }),
      },
    ],
  })
  const client = createMcpClient({ url: 'https://mcp.example.com/mcp', auth: { mode: 'none' }, fetchImpl: rec.fetch })
  await assert.rejects(client.callTool('q', {}), /mcp tool q error: bad query/)
})

test('mcp-client: baseUrl strips trailing slashes and /mcp suffix', () => {
  const c1 = createMcpClient({ url: 'https://x.example.com/mcp', auth: { mode: 'none' }, fetchImpl: makeRecorder({ responses: [] }).fetch })
  assert.equal(c1.base, 'https://x.example.com')
  const c2 = createMcpClient({ url: 'https://x.example.com/mcp/', auth: { mode: 'none' }, fetchImpl: makeRecorder({ responses: [] }).fetch })
  assert.equal(c2.base, 'https://x.example.com')
  const c3 = createMcpClient({ url: 'https://x.example.com/mcp//', auth: { mode: 'none' }, fetchImpl: makeRecorder({ responses: [] }).fetch })
  assert.equal(c3.base, 'https://x.example.com')
  const c4 = createMcpClient({ url: 'https://x.example.com/api/mcp', auth: { mode: 'none' }, fetchImpl: makeRecorder({ responses: [] }).fetch })
  assert.equal(c4.base, 'https://x.example.com/api')
})

test('mcp-client: host falls back to base on bad URL', () => {
  const c = createMcpClient({ url: 'not-a-url', auth: { mode: 'none' }, fetchImpl: makeRecorder({ responses: [] }).fetch })
  assert.equal(c.host, 'not-a-url')
})

test('mcpResultText: returns concatenated text blocks', () => {
  const out = mcpResultText({
    content: [
      { type: 'text', text: 'one' },
      { type: 'image', text: 'ignored' },
      { type: 'text', text: 'two' },
    ],
  })
  assert.equal(out, 'one\ntwo')
})

test('mcpResultText: missing content returns empty string', () => {
  assert.equal(mcpResultText({}), '')
  assert.equal(mcpResultText({ content: [] }), '')
})