/**
 * MCP memory provider tests (parity 16.0): the read tool surfaces the
 * remote result, the write tool relays explicit captures, recall is
 * locally bounded, and read calls time out. Backed by a fake McpClient so
 * the test stays free of the network.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScopeId } from '@qm/types'
import { createMcpMemoryProvider } from '../src/mcp-memory-provider.ts'
import type { McpClient, McpToolResult } from '@qm/mcp'

interface CallRecord {
  tool: string
  args: Record<string, unknown>
}

function fakeClient(
  calls: CallRecord[],
  text = 'result',
  options: { hang?: boolean } = {},
): McpClient {
  return {
    base: 'http://brain.internal',
    host: 'brain.internal',
    async listTools() {
      return []
    },
    async callTool(tool, args): Promise<McpToolResult> {
      calls.push({ tool, args })
      if (options.hang) return new Promise<McpToolResult>(() => undefined)
      return { content: [{ type: 'text', text }] }
    },
  }
}

test('MCP provider passes query, actor, and explicit writes through configured tools', async () => {
  const calls: CallRecord[] = []
  const memory = createMcpMemoryProvider({
    read: {
      client: fakeClient(calls),
      tool: 'read_brain',
      timeoutMs: 100,
      scopeArg: 'namespace',
      maxCharsArg: 'max_chars',
    },
    write: {
      client: fakeClient(calls),
      tool: 'write_brain',
      timeoutMs: 100,
      scopeArg: 'namespace',
      capturedAtArg: 'captured_at',
      sourceArg: 'source',
    },
  })
  assert.equal(await memory.recall('org:yc' as ScopeId, { query: 'launch', maxChars: 2000 }), 'result')
  assert.equal(await memory.capture('org:yc' as ScopeId, ['decision'], 10, 'u1', { mode: 'explicit', actorId: 'u1' }), 1)
  assert.deepEqual(calls, [
    { tool: 'read_brain', args: { query: 'launch', namespace: 'org:yc', max_chars: 2000 } },
    {
      tool: 'write_brain',
      args: { content: 'decision', captured_at: 10, source: 'explicit', acting_user: 'u1', namespace: 'org:yc' },
    },
  ])
})

test('MCP recall is locally bounded and times out', async () => {
  const calls: CallRecord[] = []
  const bounded = createMcpMemoryProvider({
    read: { client: fakeClient(calls, 'abcdefgh'), tool: 'read', timeoutMs: 100 },
  })
  assert.equal(await bounded.recall('org:yc' as ScopeId, { maxChars: 4 }), 'abcd')

  const timed = createMcpMemoryProvider({
    read: { client: fakeClient(calls, '', { hang: true }), tool: 'read', timeoutMs: 10 },
  })
  await assert.rejects(timed.recall('org:yc' as ScopeId), /timed out after 10ms/)
})

test('MCP write without configured write op rejects, query splits lines', async () => {
  const calls: CallRecord[] = []
  const readOnly = createMcpMemoryProvider({
    read: { client: fakeClient(calls, 'one\ntwo\nthree'), tool: 'read', timeoutMs: 100 },
  })

  await assert.rejects(readOnly.capture('org:yc' as ScopeId, ['x'], 1, undefined), /brain write is not configured/)

  const lines = await readOnly.query('org:yc' as ScopeId, 'noop', 10)
  assert.deepEqual(lines, ['one', 'two', 'three'])

  const limited = await readOnly.query('org:yc' as ScopeId, 'noop', 2)
  assert.equal(limited.length, 2)
})

test('MCP provider refuses notebook edits; head/replace/restore stay inert', async () => {
  const calls: CallRecord[] = []
  const memory = createMcpMemoryProvider({
    read: { client: fakeClient(calls, ''), tool: 'read', timeoutMs: 100 },
  })

  const head = await memory.head('org:yc' as ScopeId)
  assert.deepEqual(head, { content: '', revision: '0' })

  await assert.rejects(async () => memory.replace('org:yc' as ScopeId, '- x'), /notebook replacement/)
  assert.equal(await memory.replaceIfRevision('org:yc' as ScopeId, '- x', '0'), false)
  assert.deepEqual(await memory.history?.('org:yc' as ScopeId), [])
  assert.equal(await memory.restore?.('org:yc' as ScopeId, 'rev', '0'), false)
  assert.equal(await memory.get('org:yc' as ScopeId), '')
})

test('MCP capture without write thread through append as well', async () => {
  const calls: CallRecord[] = []
  const memory = createMcpMemoryProvider({
    read: { client: fakeClient(calls), tool: 'read', timeoutMs: 100 },
    write: {
      client: fakeClient(calls),
      tool: 'write',
      timeoutMs: 100,
      inputArg: 'user_input',
      replyArg: 'reply_text',
      idempotencyArg: 'idem',
    },
  })

  const count = await memory.append('org:yc' as ScopeId, ['a', 'b'], 5, 'u1')
  assert.equal(count, 2)
  const last = calls[calls.length - 1]!
  assert.equal(last.tool, 'write')
  assert.equal(last.args.content, 'a\nb')
  assert.equal(last.args.acting_user, 'u1')

  const explicit = await memory.capture('org:yc' as ScopeId, ['x'], 6, 'u1', {
    mode: 'explicit',
    actorId: 'u1',
    input: 'hi',
    reply: 'hello',
    idempotencyKey: 'idem-1',
  })
  assert.equal(explicit, 1)
  const captureCall = calls[calls.length - 1]!
  assert.equal(captureCall.args.user_input, 'hi')
  assert.equal(captureCall.args.reply_text, 'hello')
  assert.equal(captureCall.args.idem, 'idem-1')
})