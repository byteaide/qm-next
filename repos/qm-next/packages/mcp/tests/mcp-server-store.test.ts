/**
 * MCP server store tests: list/get/put/delete sorted-by-id, change
 * notifications, ID pattern validation.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryMap } from '@qm/store'
import {
  createMcpServerStore,
  isValidMcpServerId,
  type McpServer,
} from '../src/index.ts'

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

test('mcp-server-store: list returns sorted by id', async () => {
  const backing = createMemoryMap<McpServer>()
  const store = createMcpServerStore(backing)
  await store.put(makeServer('zeta'))
  await store.put(makeServer('alpha'))
  await store.put(makeServer('mu'))
  const list = await store.list()
  assert.deepEqual(list.map((s) => s.id), ['alpha', 'mu', 'zeta'])
})

test('mcp-server-store: get returns null for missing id', async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>())
  assert.equal(await store.get('absent'), null)
})

test('mcp-server-store: put overwrites existing entry', async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>())
  await store.put(makeServer('a', { name: 'first' }))
  await store.put(makeServer('a', { name: 'second' }))
  const got = await store.get('a')
  assert.equal(got?.name, 'second')
})

test('mcp-server-store: delete removes entry', async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>())
  await store.put(makeServer('a'))
  await store.delete('a')
  assert.equal(await store.get('a'), null)
  const list = await store.list()
  assert.equal(list.length, 0)
})

test('mcp-server-store: onChange fires on put and delete', async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>())
  let count = 0
  const off = store.onChange(() => {
    count++
  })
  await store.put(makeServer('a'))
  await store.put(makeServer('b'))
  await store.delete('a')
  assert.equal(count, 3)
  off()
  await store.put(makeServer('c'))
  assert.equal(count, 3, 'unsubscribe stops notifications')
})

test('mcp-server-store: multiple listeners each fire', async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>())
  let aCount = 0
  let bCount = 0
  store.onChange(() => {
    aCount++
  })
  store.onChange(() => {
    bCount++
  })
  await store.put(makeServer('x'))
  assert.equal(aCount, 1)
  assert.equal(bCount, 1)
})

test('isValidMcpServerId: accepts ids that match the pattern', () => {
  assert.ok(isValidMcpServerId('aa'))
  assert.ok(isValidMcpServerId('salesforce'))
  assert.ok(isValidMcpServerId('a-1'))
  assert.ok(isValidMcpServerId('foo-bar-baz-qux'))
  assert.ok(isValidMcpServerId('a23456789012345678901234567890123456789'))
})

test('isValidMcpServerId: rejects ids that violate the pattern', () => {
  assert.ok(!isValidMcpServerId(''))
  assert.ok(!isValidMcpServerId('a'), 'must be at least 2 chars')
  assert.ok(!isValidMcpServerId('1abc'), 'must start with a letter')
  assert.ok(!isValidMcpServerId('A-bc'), 'must start with a lowercase letter')
  assert.ok(!isValidMcpServerId('aBc'), 'no uppercase letters')
  assert.ok(!isValidMcpServerId('a_bc'), 'no underscores')
  assert.ok(!isValidMcpServerId('a!bc'), 'no punctuation')
  assert.ok(!isValidMcpServerId('a'.repeat(41)), 'too long')
})

test('mcp-server-store: round-trips bearer and client-credentials records', async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>())
  const bearer = makeServer('s1', { auth: 'bearer', bearerToken: 'public-bearer-value' })
  const cc = makeServer('s2', { auth: 'client-credentials', clientId: 'public-cid', clientSecret: 'public-csec' })
  await store.put(bearer)
  await store.put(cc)
  const list = await store.list()
  const byId = Object.fromEntries(list.map((s) => [s.id, s]))
  assert.equal(byId.s1?.auth, 'bearer')
  assert.equal(byId.s1?.bearerToken, 'public-bearer-value')
  assert.equal(byId.s2?.auth, 'client-credentials')
  assert.equal(byId.s2?.clientId, 'public-cid')
  assert.equal(byId.s2?.clientSecret, 'public-csec')
})