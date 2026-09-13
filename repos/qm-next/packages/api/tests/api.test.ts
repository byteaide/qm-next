/**
 * End-to-end tests for the HTTP surface: signed-token auth (JOSE roundtrip,
 * rotation, legacy format, expiry), request validation, the synchronous turn
 * loop over the mock harness against real memory stores, the async queue
 * path driven by the runner, and the composed ApiService listening for real.
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { Context } from '@qm/cordis'
import { createHarnessRouter, createMockHarness, OrchestratorService } from '@qm/orchestrator'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { ResolutionService, ScopeId, TurnResult } from '@qm/types'
import { ApiService, createApiServer, createTurnRunner, mintSignedPayload, verifySignedPayload } from '../src/index.ts'
import type { ApiDeps } from '../src/index.ts'

const SECRET = 'test-secret'
const SCOPE: ScopeId = 'org:test'

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

function mint(claims: Record<string, unknown>, secret: string = SECRET): Promise<string> {
  return mintSignedPayload(claims, secret)
}

function buildDeps(): ApiDeps & { sessions: ReturnType<typeof createMemorySessionStore>; runs: ReturnType<typeof createMemoryRunStore> } {
  const sessions = createMemorySessionStore()
  const runs = createMemoryRunStore()
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(createMockHarness())
  const resolution: ResolutionService = {
    resolve: async () => ({ systemPrompt: 'You are a test agent.', orgScopeId: SCOPE }),
    scopeFor: () => SCOPE,
  }
  const orchestrator = new OrchestratorService(new Context(), {
    sessions,
    runs,
    harness: registry,
    identity: {
      isInternal: (p) => p.type === 'internal',
      audienceIsAllInternal: (audience) => audience.every((p) => p.type === 'internal'),
    },
    resolution,
    rateLimiter: { check: async () => ({ allowed: true }) },
  })
  return { orchestrator, sessions, runs, resolution }
}

test('signed-token: roundtrip, rotation, tamper rejection, legacy format', async () => {
  const claims = { p: 'user-1', name: 'Ada' }
  assert.deepEqual(await verifySignedPayload(await mint(claims), SECRET), claims)
  const next = 'next-secret'
  const rotated = await mint(claims, next)
  assert.deepEqual(await verifySignedPayload(rotated, [SECRET, next]), claims)
  assert.equal(await verifySignedPayload(await mint(claims, 'other-secret'), SECRET), null)
  const [head, payload, sig] = rotated.split('.')
  assert.ok(head)
  assert.ok(payload)
  assert.ok(sig)
  const flipped = sig[0] === 'A' ? `B${sig.slice(1)}` : `A${sig.slice(1)}`
  assert.equal(await verifySignedPayload(`${head}.${payload}.${flipped}`, SECRET), null)
  const legacyPayload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const legacyToken = `${legacyPayload}.${createHmac('sha256', SECRET).update(legacyPayload).digest('hex')}`
  assert.deepEqual(await verifySignedPayload(legacyToken, SECRET), claims)
})

test('auth: missing, garbage and expired tokens are rejected', async () => {
  const app = createApiServer(buildDeps(), { secrets: [SECRET] })
  const body = { text: 'hi', surface: 'api', conversation: { kind: 'dm', threadRef: 'thread:1' } }
  const missing = await app.inject({ method: 'POST', url: '/v1/turns', payload: body })
  assert.equal(missing.statusCode, 401)
  const garbage = await app.inject({ method: 'POST', url: '/v1/turns', headers: authHeader('garbage'), payload: body })
  assert.equal(garbage.statusCode, 401)
  const expired = await mint({ p: 'user-1', exp: Date.now() - 1_000 })
  const stale = await app.inject({ method: 'POST', url: '/v1/turns', headers: authHeader(expired), payload: body })
  assert.equal(stale.statusCode, 401)
  await app.close()
})

test('validation: text, surface and conversation are required', async () => {
  const app = createApiServer(buildDeps(), { secrets: [SECRET] })
  const headers = authHeader(await mint({ p: 'user-1' }))
  const noText = await app.inject({ method: 'POST', url: '/v1/turns', headers, payload: { surface: 'api' } })
  assert.equal(noText.statusCode, 400)
  const noSurface = await app.inject({ method: 'POST', url: '/v1/turns', headers, payload: { text: 'hi' } })
  assert.equal(noSurface.statusCode, 400)
  assert.match(noSurface.body, /surface/)
  const noConversation = await app.inject({
    method: 'POST',
    url: '/v1/turns',
    headers,
    payload: { text: 'hi', surface: 'api', conversation: { kind: 'dm' } },
  })
  assert.equal(noConversation.statusCode, 400)
  await app.close()
})

test('sync turn: 200 ok with reply, session entries recorded', async () => {
  const deps = buildDeps()
  const app = createApiServer(deps, { secrets: [SECRET] })
  const res = await app.inject({
    method: 'POST',
    url: '/v1/turns',
    headers: authHeader(await mint({ p: 'user-1', name: 'Ada' })),
    payload: { text: 'hello', surface: 'api', conversation: { kind: 'dm', threadRef: 'thread:1' } },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json() as TurnResult
  assert.equal(body.status, 'ok')
  assert.equal(body.reply, 'echo: hello')
  assert.ok(body.sessionId)
  const entries = await deps.sessions.getEntries(body.sessionId!)
  assert.deepEqual(entries.map((e) => e.type), ['user', 'assistant'])
  await app.close()
})

test('refused: guest principal and unknown harness map to 403', async () => {
  const app = createApiServer(buildDeps(), { secrets: [SECRET] })
  const guest = await app.inject({
    method: 'POST',
    url: '/v1/turns',
    headers: authHeader(await mint({ p: 'stranger', typ: 'guest' })),
    payload: { text: 'hi', surface: 'api', conversation: { kind: 'dm', threadRef: 'thread:1' } },
  })
  assert.equal(guest.statusCode, 403)
  assert.equal((guest.json() as TurnResult).status, 'refused')
  const unknown = await app.inject({
    method: 'POST',
    url: '/v1/turns',
    headers: authHeader(await mint({ p: 'user-1' })),
    payload: { text: 'hi', surface: 'api', harness: 'nope', conversation: { kind: 'dm', threadRef: 'thread:1' } },
  })
  assert.equal(unknown.statusCode, 403)
  assert.match((unknown.json() as TurnResult).reason ?? '', /unknown harness/)
  await app.close()
})

test('async turn: 202 queued, runner claims and completes the run', async () => {
  const deps = buildDeps()
  const app = createApiServer(deps, { secrets: [SECRET] })
  const runner = createTurnRunner(deps, { tickMs: 5 })
  runner.start()
  const res = await app.inject({
    method: 'POST',
    url: '/v1/turns?async=1',
    headers: authHeader(await mint({ p: 'user-1' })),
    payload: { text: 'hi async', surface: 'api', conversation: { kind: 'dm', threadRef: 'thread:async' } },
  })
  assert.equal(res.statusCode, 202)
  const body = res.json() as TurnResult
  assert.equal(body.status, 'queued')
  assert.ok(body.runId)
  assert.ok(body.sessionId)
  const run = await deps.runs.waitFor(body.runId!, 5_000)
  assert.equal(run.status, 'done')
  assert.equal(run.result?.reply, 'echo: hi async')
  const entries = await deps.sessions.getEntries(body.sessionId!)
  assert.deepEqual(entries.map((e) => e.type), ['user', 'assistant'])
  await runner.stop()
  await app.close()
})

test('ApiService: real listen, healthz and sync turn over HTTP, clean dispose', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(ApiService, { secrets: [SECRET], port: 0 })
  const { port } = ctx.api.address
  assert.ok(port > 0)
  const base = `http://127.0.0.1:${port}`
  const health = await fetch(`${base}/healthz`)
  assert.equal(health.status, 200)
  const res = await fetch(`${base}/v1/turns`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await mint({ p: 'user-1' })}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi http', surface: 'api', conversation: { kind: 'dm', threadRef: 'thread:http' } }),
  })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as TurnResult).reply, 'echo: hi http')
  await fiber.dispose()
  await assert.rejects(() => fetch(`${base}/healthz`))
})

test('ApiService: defaultHarness pi registers the real engine beside mock; explicit mock turns still work', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(ApiService, { secrets: [SECRET], port: 0, defaultHarness: 'pi' })
  const deps = ctx.api.orchestrator.deps
  assert.deepEqual(deps.harness.ids().sort(), ['mock', 'pi'])
  assert.ok(deps.harness.get('pi'))
  assert.ok(deps.modelGateway)
  const { port } = ctx.api.address
  const base = `http://127.0.0.1:${port}`
  const res = await fetch(`${base}/v1/turns`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await mint({ p: 'user-1' })}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'hi mock',
      surface: 'api',
      harness: 'mock',
      conversation: { kind: 'dm', threadRef: 'thread:pi-registered' },
    }),
  })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as TurnResult).reply, 'echo: hi mock')
  await fiber.dispose()
})

test('ApiService: custom providers register into the model registry before the pi harness boots', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(ApiService, {
    secrets: [SECRET],
    port: 0,
    defaultHarness: 'pi',
    customProviders: [
      {
        id: 'acme',
        name: 'Acme AI',
        protocol: 'openai',
        baseUrl: 'https://api.acme.dev/v1',
        models: [{ id: 'acme-large', name: 'Acme Large', contextWindow: 200_000 }],
      },
    ],
    customProviderKeys: { acme: 'k-acme' },
  })
  try {
    const { resolveModel, isCustomModelId } = await import('@qm/model')
    assert.equal(isCustomModelId('acme-large'), true)
    assert.equal(resolveModel('acme-large')?.provider, 'acme')
    assert.ok(ctx.api.orchestrator.deps.harness.get('pi'))
  } finally {
    await fiber.dispose()
  }
})

test('ApiService: an invalid custom provider spec rejects boot', async () => {
  const ctx = new Context()
  await assert.rejects(
    async () => {
      await ctx.plugin(ApiService, {
        secrets: [SECRET],
        port: 0,
        customProviders: [
          { id: 'Bad_Slug', name: 'x', protocol: 'openai', baseUrl: 'https://api.x.dev/v1', models: [{ id: 'm' }] },
        ],
      })
    },
    /lowercase slug/,
  )
})
