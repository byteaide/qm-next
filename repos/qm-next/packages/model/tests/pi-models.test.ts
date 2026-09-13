/**
 * Model core contract tests: registry resolution, clones, subscription
 * namespacing, custom providers, serviceability and default selection.
 * resolveModel exercises the real pi-ai builtin catalog (pinned 0.82.0).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ALL_PROVIDERS_AVAILABLE,
  auxiliaryModelFor,
  codexSubscriptionModelId,
  contextTokenBudgetForModel,
  customModelCatalog,
  customModelsJson,
  customProvidersVersion,
  defaultInteractiveThinkingLevel,
  defaultModelForHarness,
  defaultModelForProvider,
  getRequiredModel,
  isCustomModelId,
  modelDisplayName,
  modelProviderAvailabilityFor,
  modelServiceable,
  modelSupportedByHarness,
  modelSupportsFastMode,
  onlyProvider,
  parseProviderBaseUrl,
  providerBaseUrlsFromEnv,
  providerBaseUrl,
  resolveModel,
  serviceableModelIds,
  setCustomProviders,
  setProviderBaseUrls,
  validateCustomProviderSpec,
} from '../src/index.ts'
import type { ModelProviderAvailability } from '@qm/types'

const FULL: ModelProviderAvailability = { anthropic: true, openai: true, openrouter: true }
const NO_KEYS: ModelProviderAvailability = { anthropic: false, openai: false, openrouter: false }

test('provider endpoints: validation, env parsing and override visibility', () => {
  assert.equal(parseProviderBaseUrl('X', 'https://api.example.com/v1/'), 'https://api.example.com/v1')
  assert.throws(() => parseProviderBaseUrl('X', 'ftp://api.example.com'), /http\(s\)/)
  assert.throws(() => parseProviderBaseUrl('X', 'https://u:p@api.example.com'), /credentials/)
  assert.throws(() => parseProviderBaseUrl('X', 'https://api.example.com/?a=1'), /query/)
  assert.throws(() => parseProviderBaseUrl('X', 'not a url'), /not a valid URL/)
  const urls = providerBaseUrlsFromEnv({ ANTHROPIC_BASE_URL: 'https://proxy.internal' })
  assert.equal(urls.anthropic, 'https://proxy.internal')
  assert.equal(urls.openai, undefined)
  setProviderBaseUrls(urls)
  assert.equal(providerBaseUrl('anthropic'), 'https://proxy.internal')
  assert.equal(providerBaseUrl('openai'), undefined)
  assert.equal(providerBaseUrl('unknown-provider'), undefined)
  setProviderBaseUrls({})
})

test('registry resolution: builtins resolve; unknown ids do not', () => {
  assert.ok(resolveModel('claude-opus-4-8'))
  assert.equal(resolveModel('no-such-model'), undefined)
  assert.equal(modelDisplayName('claude-opus-4-8'), 'Claude Opus 4.8')
  assert.equal(modelDisplayName('unknown'), 'unknown')
  assert.equal(getRequiredModel('claude-opus-4-8').id, 'claude-opus-4-8')
  assert.throws(() => getRequiredModel('nope'), /Unsupported model/)
})

test('clone models: opus-5 clones 4-8 with raised context and premium pricing', () => {
  const clone = getRequiredModel('claude-opus-5')
  assert.equal(clone.id, 'claude-opus-5')
  assert.equal(clone.contextWindow, 1_000_000)
  assert.equal(clone.maxTokens, 128_000)
  assert.equal(clone.cost.input, 5)
})

test('codex subscription namespacing keeps the prefixed id', () => {
  assert.equal(codexSubscriptionModelId('gpt-5.6-sol'), 'codex/gpt-5.6-sol')
  assert.equal(codexSubscriptionModelId('codex/gpt-5.6-sol'), 'codex/gpt-5.6-sol')
})

test('harness support and serviceability matrix', () => {
  assert.equal(modelSupportedByHarness('claude-opus-5', 'pi'), true)
  assert.equal(modelSupportedByHarness('claude-opus-5', 'claude'), true)
  assert.equal(modelSupportedByHarness('gpt-5.6-sol', 'claude'), false)
  assert.equal(modelSupportedByHarness(undefined, 'pi'), false)
  assert.equal(modelServiceable('claude-opus-5', FULL), true)
  assert.equal(modelServiceable('claude-opus-5', NO_KEYS), false)
  assert.equal(modelServiceable('nope', FULL), false)
  assert.deepEqual(serviceableModelIds(['claude-opus-5', 'gpt-5.6-sol'], onlyProvider('openai')), ['gpt-5.6-sol'])
})

test('auxiliary model selection prefers a same-provider auxiliary', () => {
  const aux = auxiliaryModelFor('claude-opus-4-8')
  assert.equal(aux, 'claude-haiku-4-5')
  assert.equal(auxiliaryModelFor('unknown-model'), 'unknown-model')
})

test('default model selection honours config, harness fit and availability', () => {
  assert.equal(defaultModelForHarness('pi'), 'claude-opus-5')
  assert.equal(defaultModelForHarness('codex'), 'gpt-5.6-sol')
  assert.equal(defaultModelForHarness('pi', 'gpt-5.6-sol'), 'gpt-5.6-sol')
  assert.equal(
    defaultModelForHarness('pi', 'gpt-5.6-sol', { anthropic: true, openai: false, openrouter: false }),
    'gpt-5.6-sol',
  )
  assert.equal(
    defaultModelForHarness('pi', 'unknown-model', { anthropic: true, openai: false, openrouter: false }),
    'claude-opus-5',
  )
  assert.equal(defaultModelForHarness('codex', undefined, { anthropic: true, openai: false, openrouter: false, codexOAuth: true }), 'gpt-5.6-sol')
  assert.equal(defaultModelForProvider('claude', 'openai'), undefined)
  assert.equal(defaultModelForProvider('pi', 'anthropic'), 'claude-opus-5')
})

test('availability projection per harness', () => {
  const keys = { anthropic: true, openai: true, openrouter: true }
  assert.deepEqual(modelProviderAvailabilityFor('pi', keys, { anthropic: true, openai: false, openrouter: false }), {
    anthropic: true,
    openai: false,
    openrouter: false,
  })
  assert.equal(modelProviderAvailabilityFor('opencode', keys).openrouter, false)
  assert.equal(modelProviderAvailabilityFor('codex', NO_KEYS, NO_KEYS).openai, false)
  assert.equal(
    modelProviderAvailabilityFor('codex', { anthropic: false, openai: false, openrouter: false, codexOAuth: true }).openai,
    true,
  )
  assert.deepEqual(modelProviderAvailabilityFor('claude', keys), ALL_PROVIDERS_AVAILABLE)
})

test('context budget, fast mode and thinking level', () => {
  assert.equal(contextTokenBudgetForModel('claude-opus-5'), Math.floor((1_000_000 - 128_000) * 0.5))
  assert.equal(contextTokenBudgetForModel('unknown'), undefined)
  assert.equal(modelSupportsFastMode('claude-opus-5'), true)
  assert.equal(modelSupportsFastMode('claude-sonnet-5'), false)
  assert.equal(modelSupportsFastMode(undefined), false)
  assert.equal(defaultInteractiveThinkingLevel({ api: 'anthropic-messages', provider: 'anthropic' }), 'low')
  assert.equal(defaultInteractiveThinkingLevel({ api: 'openai-completions', provider: 'openai' }), 'auto')
})

test('custom providers: validation, registry resolution, versioning and models.json', () => {
  assert.equal(isCustomModelId('acme-large'), false)
  const before = customProvidersVersion()
  setCustomProviders([
    {
      id: 'acme',
      name: 'Acme AI',
      protocol: 'openai',
      baseUrl: 'https://api.acme.dev/v1',
      models: [{ id: 'acme-large', name: 'Acme Large', contextWindow: 200_000, input: 3, output: 12 }],
    },
  ])
  assert.equal(customProvidersVersion(), before + 1)
  assert.equal(isCustomModelId('acme-large'), true)
  assert.equal(resolveModel('acme-large')?.provider, 'acme')
  assert.equal(modelServiceable('acme-large', NO_KEYS), true)
  assert.equal(modelSupportedByHarness('acme-large', 'pi'), true)
  assert.equal(modelSupportedByHarness('acme-large', 'claude'), false)
  assert.deepEqual(customModelCatalog(), [{ id: 'acme-large', name: 'Acme Large', provider: 'acme' }])
  const json = customModelsJson()!
  assert.equal((json.providers.acme as { name: string }).name, 'Acme AI')
  assert.equal(modelSupportedByHarness('claude-opus-5', 'pi'), true)
  assert.equal(resolveModel('claude-opus-4-8')?.id, 'claude-opus-4-8')
})

test('custom provider validation rejects bad specs', () => {
  const spec = (over: Record<string, unknown>) => ({
    id: 'okslug',
    name: 'Ok',
    protocol: 'openai' as const,
    baseUrl: 'https://api.ok.dev',
    models: [{ id: 'm1' }],
    ...over,
  })
  assert.throws(() => validateCustomProviderSpec(spec({ id: 'Bad_Slug' }) as never), /lowercase slug/)
  assert.throws(() => validateCustomProviderSpec(spec({ id: 'anthropic' }) as never), /reserved/)
  assert.throws(() => validateCustomProviderSpec(spec({ name: '  ' }) as never), /name is required/)
  assert.throws(() => validateCustomProviderSpec(spec({ baseUrl: 'notaurl' }) as never), /valid URL/)
  assert.throws(() => validateCustomProviderSpec(spec({ models: [] }) as never), /at least one model/)
  assert.throws(
    () => validateCustomProviderSpec(spec({ models: [{ id: 'a' }, { id: 'a' }] }) as never),
    /duplicate model id/,
  )
  assert.throws(
    () => validateCustomProviderSpec(spec({ models: [{ id: 'a', contextWindow: -1 }] }) as never),
    /non-negative number/,
  )
  assert.ok(validateCustomProviderSpec(spec({} as never)) === undefined)
})
