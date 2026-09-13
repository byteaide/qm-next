import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHarnessRouter, createMockHarness, resolveRuntimeChoice } from '@qm/orchestrator'
import { NonRetryableTurnError, type Harness } from '@qm/types'

test('resolveRuntimeChoice: fallback ladder, approval gating, and requested overrides', () => {
  const registered = ['pi', 'claude', 'codex', 'opencode', 'mock']
  const fallback = { harnessId: 'pi', modelId: 'claude-opus-5' }

  assert.deepEqual(resolveRuntimeChoice({}, { registered, scope: 'org:default', fallback }), fallback)

  assert.deepEqual(
    resolveRuntimeChoice(
      { approved: registered, default: { harness: 'codex', model: 'gpt-5.6-sol' } },
      { registered, scope: 'org:default', fallback },
    ),
    { harnessId: 'codex', modelId: 'gpt-5.6-sol' },
  )

  assert.deepEqual(
    resolveRuntimeChoice(
      {
        approved: registered,
        default: { harness: 'codex' },
        scopes: { 'org:acme': { harness: 'claude', model: 'claude-opus-5' } },
      },
      { registered, scope: 'org:acme', orgScope: 'org:default', fallback },
    ),
    { harnessId: 'claude', modelId: 'claude-opus-5' },
  )

  assert.throws(
    () =>
      resolveRuntimeChoice(
        { approved: ['pi', 'mock'] },
        {
          registered,
          scope: 'org:default',
          fallback,
          requested: { harness: 'codex', model: 'gpt-5.6-sol' },
        },
      ),
    NonRetryableTurnError,
    'a requested harness outside the approved list is non-retryable',
  )

  assert.throws(
    () =>
      resolveRuntimeChoice(
        { approved: ['pi', 'codex'] },
        {
          registered,
          scope: 'org:default',
          fallback,
          requested: { harness: 'codex', model: 'claude-opus-5' },
        },
      ),
    NonRetryableTurnError,
    'a requested model the engine cannot run is non-retryable',
  )
})

function fakeHarness(id: string): Harness {
  return {
    profile: {
      id,
      controlTransport: 'mock',
      toolTransport: 'mock',
      transcriptFormat: id,
      capabilities: new Set(['abort']),
    },
    turns: {
      runTurn: async () => ({ reply: id }),
    },
    models: {},
    tools: { name: (coreName) => coreName },
  }
}

test('configured router: per-turn choice overrides and switch bookkeeping', () => {
  const registry = createHarnessRouter({
    defaultId: 'mock',
    fallbackModelId: 'claude-opus-5',
    routes: {
      approved: ['mock', 'pi'],
      default: { harness: 'mock', model: 'claude-opus-5' },
      scopes: { 'org:acme': { harness: 'pi', model: 'claude-opus-5' } },
    },
  })
  registry.register(createMockHarness())
  registry.register(fakeHarness('pi'))
  registry.register(fakeHarness('claude'))

  assert.deepEqual(registry.resolveChoice('thread-1', 'org:default'), {
    harnessId: 'mock',
    modelId: 'claude-opus-5',
  })
  assert.deepEqual(registry.resolveChoice('thread-2', 'org:acme'), {
    harnessId: 'pi',
    modelId: 'claude-opus-5',
  })
  assert.deepEqual(registry.resolveChoice('thread-2', 'org:acme', { harness: 'mock' }), {
    harnessId: 'mock',
    modelId: 'claude-opus-5',
  })
  assert.equal(registry.resolve('pi').profile.id, 'pi')
  assert.throws(() => registry.resolve('codex'), /unknown harness/)
})

test('configured router: bare registry keeps legacy resolve semantics', () => {
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(createMockHarness())
  assert.deepEqual(registry.resolveChoice('thread-1', 'org:default'), {
    harnessId: 'mock',
    modelId: 'mock',
  })
  assert.deepEqual(registry.resolveChoice('thread-1', 'org:default', { harness: 'mock', model: 'x' }), {
    harnessId: 'mock',
    modelId: 'x',
  })
})
