import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createClaudeHarness,
  claudeChildAgentAllowed,
  claudeChildEnv,
  claudeProcessIdentity,
  claudeReplayTranscript,
  claudeToolContext,
  stripClaudeImageBytes,
  type ClaudeHarnessOptions,
} from '@qm/harness-claude'
import { DEFAULT_AGENT_MODEL_ID } from '@qm/model'
import type { HarnessTurnInput, Session } from '@qm/types'

function makeSession(id = 's1'): Session {
  return { id, type: 'channel', scopeId: 'org:default', threadRef: 't1', surface: 'api', createdAt: Date.now() }
}

test('claudeChildEnv: jails HOME/CLAUDE_CONFIG_DIR and passes only the allowlist', () => {
  const env = claudeChildEnv(
    { PATH: '/usr/bin', TMPDIR: '/tmp', ANTHROPIC_API_KEY: 'k', NOT_ALLOWED: 'x' },
    '/jail',
  )
  assert.equal(env.HOME, '/jail')
  assert.equal(env.CLAUDE_CONFIG_DIR, '/jail/.claude')
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.TMPDIR, '/tmp')
  assert.equal(env.ANTHROPIC_API_KEY, 'k')
  assert.equal(env.NOT_ALLOWED, undefined)
})

test('claudeProcessIdentity: root drops to nobody, otherwise none', () => {
  assert.deepEqual(claudeProcessIdentity(0), { uid: 65534, gid: 65534 })
  assert.equal(claudeProcessIdentity(1000), undefined)
  assert.equal(claudeProcessIdentity(undefined), undefined)
})

test('claudeChildAgentAllowed: only research/code/consult subagents pass', () => {
  assert.equal(claudeChildAgentAllowed({ subagent_type: 'research' }), true)
  assert.equal(claudeChildAgentAllowed({ subagent_type: 'code' }), true)
  assert.equal(claudeChildAgentAllowed({ subagent_type: 'consult' }), true)
  assert.equal(claudeChildAgentAllowed({ subagent_type: 'bash' }), false)
  assert.equal(claudeChildAgentAllowed({}), false)
  assert.equal(claudeChildAgentAllowed(null), false)
  assert.equal(claudeChildAgentAllowed('research'), false)
})

test('claudeReplayTranscript: renders user/assistant/toolResult lines inside an untrusted-transcript fence', () => {
  const messages = [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'hello "world"' }] },
    {
      role: 'toolResult' as const,
      toolName: 'execute',
      toolCallId: 'c1',
      isError: true,
      content: [{ type: 'text' as const, text: 'boom' }],
    },
    {
      role: 'assistant' as const,
      content: [
        { type: 'text' as const, text: 'hi there' },
        { type: 'toolCall' as const, id: 'c2', name: 'read', arguments: { path: '/x' } },
      ],
    },
  ] as never
  const out = claudeReplayTranscript(messages)
  assert.ok(/BEGIN TRANSCRIPT/.test(out))
  assert.ok(/END TRANSCRIPT>/.test(out))
  assert.ok(/untrusted conversation history/.test(out))
  assert.ok(out.includes(JSON.stringify('User: hello "world"')))
  assert.ok(out.includes(JSON.stringify('Tool result (execute, call c1, error): boom')))
  assert.ok(out.includes(JSON.stringify('Assistant: hi there')))
  assert.ok(out.includes(JSON.stringify('Assistant tool call (read, call c2): {"path":"/x"}')))
  assert.equal(claudeReplayTranscript([]), '')
})

test('stripClaudeImageBytes: omits base64 image data, leaves other strings', () => {
  const message = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'text', text: 'keep' },
      ],
    },
  }
  const out = stripClaudeImageBytes(message as never) as {
    message: { content: Array<{ text?: string; source?: { data: string } }> }
  }
  assert.equal(out.message.content[0]?.source?.data, '[image omitted]')
  assert.equal(out.message.content[1]?.text, 'keep')
})

test('claudeToolContext: fresh approval state with turn passthrough', () => {
  const gate = (tool: string) => tool === 'execute'
  const emit = async () => ({}) as never
  const ref = claudeToolContext({
    session: makeSession(),
    input: 'hi',
    systemPrompt: 'sys',
    history: [],
    scopeLabel: 'org:default',
    orgScopeId: 'org:default',
    pollFire: true,
    toolApprovalGate: gate,
    emit,
    recordModelCall: () => {},
  } as HarnessTurnInput)
  assert.equal(ref.pendingApprovals?.length, 0)
  assert.equal(ref.pausedOnApproval, false)
  assert.equal(ref.silentRequested, false)
  assert.equal(ref.pollFire, true)
  assert.equal(ref.toolApprovalGate, gate)
  assert.equal(ref.scopeLabel, 'org:default')
  assert.equal(ref.emit, emit)
})

test('createClaudeHarness: adapter profile and utilities', () => {
  const harness = createClaudeHarness({ env: { PATH: '/usr/bin' } } as ClaudeHarnessOptions)
  assert.deepEqual(
    { ...harness.profile, capabilities: [...harness.profile.capabilities].sort() },
    {
      id: 'claude',
      controlTransport: 'sdk',
      toolTransport: 'in-process-mcp',
      transcriptFormat: 'claude-agent-sdk',
      capabilities: ['abort', 'fast-mode', 'images', 'steer', 'thinking-level'],
    },
  )
  assert.equal(typeof harness.turns.runTurn, 'function')
  assert.equal(typeof harness.models.oneShot, 'function')
  assert.equal(typeof harness.models.judge, 'function')
  assert.equal(typeof harness.models.screenSecurity, 'function')
  assert.equal(typeof harness.tools.name, 'function')
  assert.equal(harness.tools.name('execute'), 'execute')
  harness.turns.resetSession?.('s1')
})

test('createClaudeHarness: contextTokenBudget resolves through the claude support matrix', () => {
  const harness = createClaudeHarness()
  const direct = harness.models.contextTokenBudget?.(undefined, 'claude-opus-5')
  const fallback = harness.models.contextTokenBudget?.('org:default', 'not-a-model')
  assert.equal(typeof direct, 'number')
  assert.equal(fallback, harness.models.contextTokenBudget?.(undefined, DEFAULT_AGENT_MODEL_ID))
})

test('claude runTurn: pre-aborted cancel stops before any provider work', async () => {
  const harness = createClaudeHarness()
  const controller = new AbortController()
  controller.abort()
  let emitted = 0
  const result = await harness.turns.runTurn({
    session: makeSession(),
    input: 'hello',
    systemPrompt: 'sys',
    history: [],
    scopeLabel: 'org:default',
    orgScopeId: 'org:default',
    cancel: controller.signal,
    emit: async () => {
      emitted++
      throw new Error('should not emit')
    },
    recordModelCall: () => {},
  })
  assert.deepEqual(result, { reply: '', stopped: true })
  assert.equal(emitted, 0)
})
