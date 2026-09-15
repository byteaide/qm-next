/**
 * Provider routing, config parsing and the memorable relay (parity 15.0).
 * Routed recall merges provider blocks; capture policies gate automatic
 * providers; the memorable provider derives tool-call traces from session
 * entries and relays them through a scripted CLI.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScopeId, SessionEntry } from '@qm/types'
import { createMemoryScopeMemory } from '../src/memory-store.ts'
import {
  createMemorableMemoryProvider,
  memorableInject,
  type MemorableSpawnOpts,
} from '../src/memorable/index.ts'
import {
  captureFacts,
  parseMemoryProviderConfig,
  createConfiguredMemoryService,
  createRoutedMemoryService,
  type MemorableCapture,
  type MemoryProviderRoute,
  type RelayOutcome,
  type ScopeMemory,
} from '../src/index.ts'

function fakeMemorable(impl: {
  inject?: (argv: readonly string[], scopeId: string, task: string) => string | null
  relay?: (capture: MemorableCapture) => RelayOutcome
}): { provider: ScopeMemory & Required<Pick<ScopeMemory, 'capture'>>; relays: MemorableCapture[] } {
  const relays: MemorableCapture[] = []
  const provider = createMemorableMemoryProvider({
    argv: ['memorable'],
    env: { MEMORABLE_API_KEY: 'k-secret', PATH: '/usr/bin' },
    loadEntries: async (sessionId) =>
      sessionId === 's1'
        ? [
            {
              sessionId: 's1',
              seq: 1,
              parentSeq: null,
              type: 'user',
              payload: { text: 'deploy the service' },
              scopeLabel: 'org:acme',
              createdAt: 1,
            },
            {
              sessionId: 's1',
              seq: 2,
              parentSeq: null,
              type: 'tool_call',
              payload: { tool: 'execute', callId: 'c1', cmd: 'deploy --token sk-supersecret' },
              scopeLabel: 'org:acme',
              createdAt: 2,
            },
            {
              sessionId: 's1',
              seq: 3,
              parentSeq: null,
              type: 'tool_result',
              payload: { callId: 'c1', isError: false },
              scopeLabel: 'org:acme',
              createdAt: 3,
            },
            {
              sessionId: 's1',
              seq: 4,
              parentSeq: null,
              type: 'tool_call',
              payload: { tool: 'execute', callId: 'c2', cmd: 'deploy --token sk-supersecret' },
              scopeLabel: 'org:acme',
              createdAt: 4,
            },
            {
              sessionId: 's1',
              seq: 5,
              parentSeq: null,
              type: 'tool_result',
              payload: { callId: 'c2', isError: false, code: 0 },
              scopeLabel: 'org:acme',
              createdAt: 5,
            },
          ] satisfies SessionEntry[]
        : [],
    mask: (text) => text.split('sk-supersecret').join('[redacted]'),
    inject: async (argv, scopeId, task) => (impl.inject ? impl.inject(argv, scopeId, task) : null),
    relay: async (_argv, capture) => {
      relays.push(capture)
      return impl.relay ? impl.relay(capture) : { ok: true }
    },
  })
  return { provider: provider as ScopeMemory & Required<Pick<ScopeMemory, 'capture'>>, relays }
}

test('routed recall merges provider blocks under labels; manage routes read/replace', async () => {
  const notebook = createMemoryScopeMemory()
  await notebook.replace('personal:person:ada' as ScopeId, '- Prefers go')
  const memorable = fakeMemorable({ inject: (_argv, _scope, task) => `### brain\nhow to ${task}` }).provider
  const routes: MemoryProviderRoute[] = [
    { provider: 'default', scopes: ['personal'], label: 'notebook' },
    { provider: 'mem', scopes: ['personal'], capture: 'automatic' },
  ]
  const routed = createRoutedMemoryService({
    providers: { default: notebook, mem: memorable },
    routes,
  })

  const recalled = await routed.recall('personal:person:ada' as ScopeId, { query: 'deploy' })
  assert.match(recalled, /### brain/)
  assert.match(recalled, /Prefers go/)

  assert.ok(await routed.get('personal:person:ada' as ScopeId), 'manage defaults to the first route')
  assert.match(await routed.get('personal:person:ada' as ScopeId), /Prefers go/)
  await routed.replace('personal:person:ada' as ScopeId, '- Prefers rust')
  assert.match(await routed.get('personal:person:ada' as ScopeId), /Prefers rust/)

  const empty = await routed.recall('org:acme' as ScopeId)
  assert.equal(empty, '')
})

test('routed capture: policy gates keep explicit writes out of automatic providers', async () => {
  const notebook = createMemoryScopeMemory()
  const memorable = fakeMemorable({}).provider
  const routed = createRoutedMemoryService({
    providers: { default: notebook, mem: memorable },
    routes: [
      { provider: 'default', scopes: ['org'], capture: 'explicit' },
      { provider: 'mem', scopes: ['org'], capture: 'automatic', failOpen: true },
    ],
  })

  const explicit = await routed.append('org:acme' as ScopeId, ['org fact'], Date.now())
  assert.equal(explicit, 1, 'only the notebook captures explicit facts')
  assert.match(await notebook.get('org:acme' as ScopeId), /org fact/)

  const automatic = await captureFacts(routed, 'org:acme' as ScopeId, ['auto fact'], Date.now(), undefined, {
    mode: 'automatic',
    sessionId: 's-missing',
  })
  assert.equal(automatic, 0, 'the memorable provider refuses automatic captures without a session')

  const sessionScoped = await captureFacts(routed, 'org:acme' as ScopeId, ['ignored'], Date.now(), undefined, {
    mode: 'automatic',
    sessionId: 's-empty',
  })
  assert.equal(sessionScoped, 0, 'sessions without offerable workflows record nothing')
})

test('routed capture: a throwing provider only breaks the turn when the route is not fail-open', async () => {
  const strict: ScopeMemory = {
    ...createMemoryScopeMemory(),
    async capture() {
      throw new Error('relay refused')
    },
  }
  const routed = createRoutedMemoryService({
    providers: { strict },
    routes: [{ provider: 'strict', scopes: ['org'], capture: 'automatic' }],
    onError: () => {},
  })
  await assert.rejects(
    routed.capture!('org:acme' as ScopeId, ['x'], Date.now(), undefined, { mode: 'automatic' }),
    /relay refused/,
  )

  const lenient = createRoutedMemoryService({
    providers: { strict },
    routes: [{ provider: 'strict', scopes: ['org'], capture: 'automatic', failOpen: true }],
    onError: () => {},
  })
  const count = await lenient.capture!('org:acme' as ScopeId, ['x'], Date.now(), undefined, { mode: 'automatic' })
  assert.equal(count, 0)
})

test('memorable: recall keys on the query; capture derives and redacts a tool-call trace', async () => {
  const { provider, relays } = fakeMemorable({
    inject: (_argv, scopeId, task) => `brain for ${scopeId}/${task}`,
    relay: (capture) => {
      assert.equal(capture.workflows.length, 1, 'the repeated call differs only by call id — still one workflow')
      return { ok: true }
    },
  })

  assert.equal(await provider.recall('org:acme' as ScopeId), '')
  assert.equal(
    await provider.recall('org:acme' as ScopeId, { query: '  deploy  ' }),
    'brain for org:acme/deploy',
  )

  assert.equal(await provider.capture('org:acme' as ScopeId, ['x'], 1, undefined, { mode: 'explicit' }), 0)
  assert.equal(await provider.capture('org:acme' as ScopeId, ['x'], 1, undefined, { mode: 'automatic' }), 0)

  const count = await provider.capture('org:acme' as ScopeId, ['x'], 1, undefined, {
    mode: 'automatic',
    sessionId: 's1',
  })
  assert.equal(count, 1)
  assert.equal(relays.length, 1)
  const workflow = relays[0]!.workflows[0]!
  assert.equal(relays[0]!.scope_id, 'org:acme')
  assert.equal(workflow.prompt, 'deploy the service')
  assert.equal(JSON.stringify(workflow.tool_calls).includes('sk-supersecret'), false, 'secrets are masked pre-relay')
  assert.match(JSON.stringify(workflow.tool_calls), /\[redacted\]/)

  await assert.rejects(
    provider.replace('org:acme' as ScopeId, '- nope'),
    /not an editable notebook/,
  )
})

test('memorable: relay refusals propagate as capture errors', async () => {
  const { provider } = fakeMemorable({
    relay: () => ({ ok: false, reason: 'consent off' }),
  })
  await assert.rejects(
    provider.capture('org:acme' as ScopeId, ['x'], 1, undefined, { mode: 'automatic', sessionId: 's1' }),
    /consent off/,
  )
})

test('provider config: memorable entries parse with the env allowlist', () => {
  const env = {
    PATH: '/usr/bin',
    DATABASE_URL: 'postgres://db',
    MEMORABLE_BACKEND: ' prod ',
    APP_SECRET: 'do-not-send',
  }
  const config = parseMemoryProviderConfig(
    JSON.stringify({
      providers: [{ id: 'procs', type: 'memorable', bin: 'memorable', passEnv: ['APP_SECRET'] }],
      routes: [{ provider: 'procs', scopes: ['personal'], capture: 'automatic', failOpen: true }],
    }),
    env,
  )
  assert.ok(config)
  const provider = config.providers[0]!
  assert.equal(provider.type, 'memorable')
  assert.deepEqual(provider.argv, ['memorable'])
  assert.equal(provider.env.PATH, '/usr/bin')
  assert.equal(provider.env.MEMORABLE_DB_URL, 'postgres://db', 'DATABASE_URL crosses under the CLI name only')
  assert.equal(provider.env.MEMORABLE_BACKEND, 'prod')
  assert.equal(provider.env.APP_SECRET, 'do-not-send', 'passEnv extends the CLI env allowlist')
  assert.equal(provider.redactValues.APP_SECRET, 'do-not-send', 'passed values register for relay masking')

  const defaults = parseMemoryProviderConfig(
    JSON.stringify({ providers: [{ id: 'm', type: 'memorable' }], routes: [] }),
    {},
  )
  assert.ok(defaults)
  const m = defaults.providers[0]!
  assert.equal(m.type, 'memorable')
  if (m.type !== 'memorable') throw new Error('unreachable')
  assert.equal(m.env.MEMORABLE_BACKEND, 'qm')
})

test('provider config: validation errors name the offender', () => {
  assert.throws(() => parseMemoryProviderConfig('not json', {}), /valid JSON/)
  assert.throws(
    () => parseMemoryProviderConfig(JSON.stringify({ providers: [] }), {}),
    /requires providers and routes/,
  )
  assert.throws(
    () =>
      parseMemoryProviderConfig(
        JSON.stringify({ providers: [{ id: 'default', type: 'memorable' }], routes: [] }),
        {},
      ),
    /invalid memory provider id/,
  )
  assert.throws(
    () =>
      parseMemoryProviderConfig(
        JSON.stringify({ providers: [{ id: 'mcp1', type: 'mcp', url: 'https://x', read: {} }], routes: [] }),
        {},
      ),
    /clientIdEnv must be a non-empty string/,
  )
  assert.throws(
    () =>
      parseMemoryProviderConfig(
        JSON.stringify({
          providers: [{ id: 'm', type: 'memorable' }],
          routes: [{ provider: 'm', scopes: ['personal'], capture: 'explicit' }],
        }),
        {},
      ),
    /does not support capture/,
  )
  assert.throws(
    () =>
      parseMemoryProviderConfig(
        JSON.stringify({ providers: [], routes: [{ provider: 'ghost', scopes: ['org'] }] }),
        {},
      ),
    /unknown memory provider in route/,
  )
  assert.throws(
    () =>
      parseMemoryProviderConfig(
        JSON.stringify({ providers: [], routes: [{ provider: 'default', scopes: ['bogus-scope'] }] }),
        {},
      ),
    /scope kind or scope id/,
  )
})

test('provider factory: absent config returns the default; present config routes around it', async () => {
  const notebook = createMemoryScopeMemory()
  assert.equal(createConfiguredMemoryService({ defaultMemory: notebook }), notebook)

  const noSessionConfig = parseMemoryProviderConfig(
    JSON.stringify({ providers: [{ id: 'm', type: 'memorable' }], routes: [] }),
    {},
  )
  assert.ok(noSessionConfig)
  assert.throws(
    () => createConfiguredMemoryService({ defaultMemory: notebook, config: noSessionConfig }),
    /needs session access/,
  )

  const config = parseMemoryProviderConfig(
    JSON.stringify({
      providers: [{ id: 'm', type: 'memorable' }],
      routes: [{ provider: 'default', scopes: ['org'], capture: 'explicit' }],
    }),
    {},
  )
  assert.ok(config)
  const routed = createConfiguredMemoryService({
    defaultMemory: notebook,
    config,
    sessionEntries: async () => [],
  })
  await routed.append('org:acme' as ScopeId, ['fact'], Date.now())
  assert.match(await notebook.get('org:acme' as ScopeId), /fact/)
})

test('memorableInject resolves null on a missing binary', async () => {
  const opts: MemorableSpawnOpts = { env: { PATH: '/nonexistent' } }
  const out = await memorableInject(['definitely-not-a-real-binary-xyz'], 'scope', 'task', opts, 2_000)
  assert.equal(out, null)
})
