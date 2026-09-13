import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OPENCODE_STARTUP_TIMEOUT_MS,
  assistantFailure,
  bridgeToolName,
  createOpenCodeHarness,
  modelRef,
  needsHistoryImport,
} from '@qm/harness-opencode'
import type { Session } from '@qm/types'

function makeSession(id = 's1'): Session {
  return { id, type: 'channel', scopeId: 'org:default', threadRef: 't1', surface: 'api', createdAt: Date.now() }
}

test('bridgeToolName renames the raw control verbs and keeps the rest', () => {
  assert.equal(bridgeToolName('execute'), 'workspace_execute')
  assert.equal(bridgeToolName('read'), 'workspace_read')
  assert.equal(bridgeToolName('write'), 'workspace_write')
  assert.equal(bridgeToolName('memory'), 'memory')
})

test('modelRef splits provider/model with registry-aware defaults', () => {
  assert.deepEqual(modelRef('anthropic/claude-opus-5'), { providerID: 'anthropic', modelID: 'claude-opus-5' })
  assert.deepEqual(modelRef('openai/gpt-5.6'), { providerID: 'openai', modelID: 'gpt-5.6' })
  const registry = modelRef('claude-opus-5')
  assert.equal(registry.providerID, 'anthropic')
  assert.equal(registry.modelID, 'claude-opus-5')
  assert.deepEqual(modelRef('gpt-5.6'), { providerID: 'openai', modelID: 'gpt-5.6' })
  assert.deepEqual(modelRef('mystery-model'), { providerID: 'anthropic', modelID: 'mystery-model' })
})

test('assistantFailure classifies retryability from the provider error name', () => {
  assert.equal(assistantFailure(undefined), null)
  assert.equal(assistantFailure({ error: { name: 'MessageAbortedError' } }), null)
  assert.equal(assistantFailure({ error: { name: 'MessageOutputLengthError' } }), null)
  const auth = assistantFailure({ error: { name: 'ProviderAuthError' } })
  assert.equal(auth?.retryable, false)
  assert.match(auth?.message ?? '', /ProviderAuthError/)
  const terminalApi = assistantFailure({
    error: { name: 'APIError', data: { isRetryable: false, message: 'quota exceeded' } },
  })
  assert.equal(terminalApi?.retryable, false)
  assert.match(terminalApi?.message ?? '', /quota exceeded/)
  const retryable = assistantFailure({ error: { name: 'APIError', data: { isRetryable: true, message: '503' } } })
  assert.equal(retryable?.retryable, true)
  const unknown = assistantFailure({ error: { name: 'SomethingElse' } })
  assert.equal(unknown?.retryable, true)
})

test('needsHistoryImport asks for replay only on the first user message', () => {
  const history = [{ info: { role: 'user' }, parts: [] }]
  assert.equal(needsHistoryImport([{ info: { role: 'user' }, parts: [] }], history), true)
  assert.equal(
    needsHistoryImport(
      [
        { info: { role: 'assistant' }, parts: [] },
        { info: { role: 'user' }, parts: [] },
      ],
      history,
    ),
    false,
  )
  assert.equal(needsHistoryImport([{ info: { role: 'user' }, parts: [] }], undefined), false)
})

test('createOpenCodeHarness: adapter profile, tool presentation, and cancel short-circuit', async () => {
  const harness = createOpenCodeHarness()
  assert.equal(OPENCODE_STARTUP_TIMEOUT_MS, 90_000)
  assert.deepEqual(
    { ...harness.profile, capabilities: [...harness.profile.capabilities].sort() },
    {
      id: 'opencode',
      controlTransport: 'http',
      toolTransport: 'plugin',
      transcriptFormat: 'opencode',
      capabilities: ['abort', 'images', 'provider-sessions', 'steer'],
    },
  )
  assert.equal(harness.tools.name('execute'), 'workspace_execute')
  assert.equal(harness.tools.name('memory'), 'memory')
  assert.equal(typeof harness.models.oneShot, 'function')
  assert.equal(typeof harness.models.judge, 'function')
  harness.turns.resetSession?.('s1')
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
