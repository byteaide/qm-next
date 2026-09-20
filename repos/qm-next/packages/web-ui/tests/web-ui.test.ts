/**
 * Web-ui server half tests: dev cookie auth, the turn → run → SSE
 * event-stream flow over the mock harness, session transcript reads, the
 * live skills/crons/contexts views over real frozen-contract stores, the
 * cron run-now fire path, and the M3-out stub answers.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { FastifyInstance } from 'fastify'
import { Context } from '@qm/cordis'
import { createMemoryDirectoryStore } from '@qm/directory'
import { createHarnessRouter, createMockHarness, OrchestratorService } from '@qm/orchestrator'
import { createMemoryRunEventBus, createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import { createMemorySkillStore } from '@qm/skills'
import { createMemoryCronStore } from '@qm/triggers'
import type { ResolutionService, ScopeId } from '@qm/types'
import { createTurnRunner } from '@qm/api'
import { createWebUiServer, type WebUiDeps } from '../src/index.ts'

const SCOPE: ScopeId = 'org:default'
const COOKIE = { cookie: 'webuiuser=dev' }

interface TestRig {
  deps: WebUiDeps
  sessions: ReturnType<typeof createMemorySessionStore>
  runs: ReturnType<typeof createMemoryRunStore>
  skills: ReturnType<typeof createMemorySkillStore>
  crons: ReturnType<typeof createMemoryCronStore>
  runner: ReturnType<typeof createTurnRunner>
  app: FastifyInstance
}

async function buildRig(): Promise<TestRig> {
  const sessions = createMemorySessionStore()
  const runs = createMemoryRunStore()
  const runEvents = createMemoryRunEventBus()
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(createMockHarness())
  const resolution: ResolutionService = {
    resolve: async () => ({ systemPrompt: 'You are qm-next.', orgScopeId: SCOPE }),
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
    runEvents,
  })
  const skills = createMemorySkillStore()
  const crons = createMemoryCronStore()
  const directory = createMemoryDirectoryStore()
  const runner = createTurnRunner({ orchestrator, runs }, { tickMs: 5 })
  runner.start()
  const app = createWebUiServer(
    { orchestrator, sessions, runs, resolution, runEvents, skills, crons, directory },
    { host: '127.0.0.1', port: 0, user: 'dev' },
  )
  return { deps: { orchestrator, sessions, runs, resolution, runEvents, skills, crons, directory }, sessions, runs, skills, crons, runner, app }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('auth: /me gate, signin cookie, protected routes reject anonymous callers', async () => {
  const rig = await buildRig()
  try {
    const anon = await rig.app.inject({ method: 'GET', url: '/me' })
    assert.equal(anon.statusCode, 401)
    const anonBody = anon.json() as { mode?: string; reason?: string }
    assert.equal(anonBody.mode, 'dev')
    assert.equal(anonBody.reason, 'unauthenticated')
    const anonTurn = await rig.app.inject({ method: 'POST', url: '/api/turn', payload: { text: 'hi' } })
    assert.equal(anonTurn.statusCode, 401)
    const signin = await rig.app.inject({ method: 'POST', url: '/signin', payload: { user: 'dev' } })
    assert.equal(signin.statusCode, 200)
    assert.match(String(signin.headers['set-cookie']), /webuiuser=dev/)
    const me = await rig.app.inject({ method: 'GET', url: '/me', headers: COOKIE })
    assert.equal(me.statusCode, 200)
    const meBody = me.json() as { user: string; mode: string; permissions: string[] }
    assert.equal(meBody.user, 'dev')
    assert.equal(meBody.mode, 'dev')
    assert.ok(Array.isArray(meBody.permissions))
    const badSignin = await rig.app.inject({ method: 'POST', url: '/signin', payload: { user: '' } })
    assert.equal(badSignin.statusCode, 400)
  } finally {
    await rig.runner.stop()
    await rig.app.close()
  }
})

test('turn flow: POST /api/turn queues, run reaches done with echo reply, SSE stream replays and finishes', async () => {
  const rig = await buildRig()
  try {
    const submitted = await rig.app.inject({
      method: 'POST',
      url: '/api/turn',
      headers: COOKIE,
      payload: { text: 'hello web', threadRef: 'web:dev:default' },
    })
    assert.equal(submitted.statusCode, 202)
    const { runId } = submitted.json() as { runId: string }
    assert.ok(runId)

    await rig.runs.waitFor(runId, 5_000)
    const polled = await rig.app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: COOKIE })
    assert.equal(polled.statusCode, 200)
    const poll = polled.json() as { status: string; result: { status: string; reply?: string } | null }
    assert.equal(poll.status, 'succeeded')
    assert.equal(poll.result?.status, 'ok')
    assert.equal(poll.result?.reply, 'echo: hello web')

    const stream = await rig.app.inject({ method: 'GET', url: `/api/runs/${runId}/events`, headers: COOKIE })
    assert.equal(stream.statusCode, 200)
    assert.match(stream.body, /event: done/)
    const doneLine = stream.body.split('\n').find((line) => line.startsWith('data: ') && line.includes('"status"'))
    assert.ok(doneLine)
    const done = JSON.parse(doneLine.slice('data: '.length)) as { status: string; result: { reply?: string } | null }
    assert.equal(done.status, 'succeeded')
    assert.equal(done.result?.reply, 'echo: hello web')

    const again = await rig.app.inject({ method: 'GET', url: `/api/runs/${runId}/events`, headers: COOKIE })
    assert.equal(again.statusCode, 200)
    assert.match(again.body, /event: done/)
    assert.match(again.body, /echo: hello web/)

    const missing = await rig.app.inject({ method: 'GET', url: '/api/runs/nope/events', headers: COOKIE })
    assert.equal(missing.statusCode, 404)
  } finally {
    await rig.runner.stop()
    await rig.app.close()
  }
})

test('sessions: list, transcript entries, title update, entry fetch, approvals stub', async () => {
  const rig = await buildRig()
  try {
    const submitted = await rig.app.inject({
      method: 'POST',
      url: '/api/turn',
      headers: COOKIE,
      payload: { text: 'trace me', threadRef: 'web:dev:default' },
    })
    const { sessionId } = submitted.json() as { sessionId: string }
    await rig.runs.waitFor((submitted.json() as { runId: string }).runId, 5_000)

    const list = await rig.app.inject({ method: 'GET', url: '/api/sessions', headers: COOKIE })
    assert.equal(list.statusCode, 200)
    const sessions = (list.json() as { sessions: Array<{ id: string; threadRef: string; type: string; title: string | null }> }).sessions
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]!.id, sessionId)
    assert.equal(sessions[0]!.threadRef, 'web:dev:default')
    assert.equal(sessions[0]!.type, 'dm')

    const transcript = await rig.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}`, headers: COOKIE })
    assert.equal(transcript.statusCode, 200)
    const page = transcript.json() as { entries: Array<{ type: string; payload: unknown; seq: number }>; earlierEntries: number }
    assert.deepEqual(page.entries.map((e) => e.type), ['user', 'assistant'])
    assert.deepEqual((page.entries[0]!.payload as { text: string }).text, 'trace me')

    const titled = await rig.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}`,
      headers: COOKIE,
      payload: { title: 'Weekly sync' },
    })
    assert.equal(titled.statusCode, 200)
    const listed = await rig.app.inject({ method: 'GET', url: '/api/sessions', headers: COOKIE })
    const after = (listed.json() as { sessions: Array<{ title: string | null }> }).sessions
    assert.equal(after[0]!.title, 'Weekly sync')

    const entry = await rig.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/entries/1`, headers: COOKIE })
    assert.equal(entry.statusCode, 200)
    const entryBody = entry.json() as { entry: { seq: number } }
    assert.equal(entryBody.entry.seq, 1)

    const approvals = await rig.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/approvals`, headers: COOKIE })
    assert.equal(approvals.statusCode, 200)
    assert.deepEqual(approvals.json(), { approvals: [] })

    const fork = await rig.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/fork`, headers: COOKIE, payload: {} })
    assert.equal(fork.statusCode, 501)
  } finally {
    await rig.runner.stop()
    await rig.app.close()
  }
})

test('skills live view: register, list with editable, collision 409, update, archive, restore, delete', async () => {
  const rig = await buildRig()
  try {
    const created = await rig.app.inject({
      method: 'POST',
      url: '/api/skills',
      headers: COOKIE,
      payload: { name: 'triage', description: 'Triage rules', body: '# triage\nDo it well.', scopeId: 'personal:dev' },
    })
    assert.equal(created.statusCode, 200)
    const { skill } = created.json() as { skill: { id: string; name: string; status: string; editable?: boolean; body?: string } }
    assert.equal(skill.name, 'triage')
    assert.equal(skill.status, 'published')
    assert.equal(skill.editable, true)

    const collision = await rig.app.inject({
      method: 'POST',
      url: '/api/skills',
      headers: COOKIE,
      payload: { name: 'triage', description: 'dup', body: 'x', scopeId: 'personal:dev' },
    })
    assert.equal(collision.statusCode, 409)

    const list = await rig.app.inject({ method: 'GET', url: '/api/skills?includeShadowed=1', headers: COOKIE })
    const skills = (list.json() as { skills: Array<{ name: string }> }).skills
    assert.equal(skills.length, 1)

    const detail = await rig.app.inject({ method: 'GET', url: `/api/skills/${skill.id}`, headers: COOKIE })
    const detailBody = detail.json() as { skill: { body?: string } }
    assert.equal(detailBody.skill.body, '# triage\nDo it well.')

    const updated = await rig.app.inject({
      method: 'PUT',
      url: `/api/skills/${skill.id}`,
      headers: COOKIE,
      payload: { description: 'Better rules' },
    })
    assert.equal(updated.statusCode, 200)
    const updatedBody = updated.json() as { skill: { description: string } }
    assert.equal(updatedBody.skill.description, 'Better rules')

    const archived = await rig.deps.skills.archive(skill.id)
    assert.equal(archived.status, 'archived')
    const restored = await rig.app.inject({ method: 'POST', url: `/api/skills/${skill.id}/restore`, headers: COOKIE, payload: {} })
    assert.equal(restored.statusCode, 200)
    const restoredBody = restored.json() as { skill: { status: string } }
    assert.equal(restoredBody.skill.status, 'published')

    const removed = await rig.app.inject({ method: 'DELETE', url: `/api/skills/${skill.id}`, headers: COOKIE })
    assert.equal(removed.statusCode, 200)
    const empty = await rig.app.inject({ method: 'GET', url: '/api/skills', headers: COOKIE })
    assert.equal((empty.json() as { skills: unknown[] }).skills.length, 0)
  } finally {
    await rig.runner.stop()
    await rig.app.close()
  }
})

test('crons live view: store-created cron listed, patch, enable/disable, run-now fires, runs log, delete', async () => {
  const rig = await buildRig()
  try {
    const cron = await rig.crons.create({
      scopeId: 'personal:dev',
      ownerId: 'dev',
      createdBy: 'dev',
      schedule: { everyMs: 3_600_000, firstFireAt: Date.now() + 3_600_000 },
      action: 'check the queue',
      title: 'Queue check',
    })
    const listed = await rig.app.inject({ method: 'GET', url: '/api/crons', headers: COOKIE })
    assert.equal(listed.statusCode, 200)
    const listBody = listed.json() as { crons: Array<{ id: string; owner: string; action?: string; permission?: string }> }
    assert.equal(listBody.crons.length, 1)
    assert.equal(listBody.crons[0]!.id, cron.id)
    assert.equal(listBody.crons[0]!.permission, 'manage')

    const patched = await rig.app.inject({
      method: 'PATCH',
      url: `/api/crons/${cron.id}`,
      headers: COOKIE,
      payload: { title: 'Renamed', task: 'check the queue twice' },
    })
    assert.equal(patched.statusCode, 200)
    const patchedBody = patched.json() as { cron: { title: string; action?: string } }
    assert.equal(patchedBody.cron.title, 'Renamed')
    assert.equal(patchedBody.cron.action, 'check the queue twice')

    const disabled = await rig.app.inject({ method: 'POST', url: `/api/crons/${cron.id}/disable`, headers: COOKIE })
    assert.equal(disabled.statusCode, 200)
    const enabled = await rig.app.inject({ method: 'POST', url: `/api/crons/${cron.id}/enable`, headers: COOKIE })
    assert.equal(enabled.statusCode, 200)

    const runNow = await rig.app.inject({ method: 'POST', url: `/api/crons/${cron.id}/run`, headers: COOKIE })
    assert.equal(runNow.statusCode, 200)
    let fires = 0
    for (let i = 0; i < 200 && fires === 0; i++) {
      const page = await rig.crons.getFires(cron.id, 20)
      fires = page.total
      if (!fires) await sleep(25)
    }
    assert.equal(fires, 1)

    const runsListed = await rig.app.inject({ method: 'GET', url: `/api/crons/${cron.id}/runs`, headers: COOKIE })
    assert.equal(runsListed.statusCode, 200)
    const runsBody = runsListed.json() as { runs: Array<{ fireKey: string; status?: string }> }
    assert.equal(runsBody.runs.length, 1)

    const removed = await rig.app.inject({ method: 'DELETE', url: `/api/crons/${cron.id}`, headers: COOKIE })
    assert.equal(removed.statusCode, 200)
    const gone = await rig.app.inject({ method: 'GET', url: '/api/crons', headers: COOKIE })
    assert.equal((gone.json() as { crons: unknown[] }).crons.length, 0)
  } finally {
    await rig.runner.stop()
    await rig.app.close()
  }
})

test('contexts and stubs: personal context present, M3-out surfaces answer empty states', async () => {
  const rig = await buildRig()
  try {
    const contexts = await rig.app.inject({ method: 'GET', url: '/api/contexts', headers: COOKIE })
    assert.equal(contexts.statusCode, 200)
    const list = (contexts.json() as { contexts: Array<{ scopeId: string; kind: string }> }).contexts
    assert.ok(list.some((c) => c.scopeId === 'personal:dev' && c.kind === 'personal'))

    // Convergence lanes relay into the api app; a relay-less rig answers 503.
    const relayEndpoints = [
      'GET /api/webhooks',
      'GET /api/files',
      'GET /api/deployments',
      'GET /api/connectors',
      'GET /api/search?q=x',
      'GET /api/memory',
      'GET /api/memory/history',
      'GET /api/user-model-auth/status',
    ]
    for (const lane of relayEndpoints) {
      const [method, url] = lane.split(' ') as ['GET', string]
      const res = await rig.app.inject({ method, url, headers: COOKIE })
      assert.equal(res.statusCode, 503, lane)
      assert.equal((res.json() as { error: string }).error, 'unavailable', lane)
    }

    const memorySave = await rig.app.inject({ method: 'POST', url: '/api/memory', headers: COOKIE, payload: { content: 'x' } })
    assert.equal(memorySave.statusCode, 404)
    const blobs = await rig.app.inject({
      method: 'POST',
      url: '/api/blobs?sha=abc',
      headers: { ...COOKIE, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    })
    assert.equal(blobs.statusCode, 400)

    const uiPut = await rig.app.inject({
      method: 'PUT',
      url: '/api/ui-state',
      headers: COOKIE,
      payload: { key: 'density', value: 'compact', updatedAt: 1 },
    })
    assert.equal(uiPut.statusCode, 200)
    const uiGet = await rig.app.inject({ method: 'GET', url: '/api/ui-state?key=density', headers: COOKIE })
    const uiBody = uiGet.json() as { value: unknown }
    assert.equal(uiBody.value, 'compact')

    const runtime = await rig.app.inject({ method: 'GET', url: '/api/runtime-config', headers: COOKIE })
    assert.equal(runtime.statusCode, 200)
    const runtimeBody = runtime.json() as { approvedHarnesses: string[]; effective: { harnessId: string } }
    assert.deepEqual(runtimeBody.approvedHarnesses, ['mock'])
    assert.equal(runtimeBody.effective.harnessId, 'mock')

    const active = await rig.app.inject({ method: 'GET', url: '/api/runs/active?threadRef=web:dev:default', headers: COOKIE })
    assert.equal(active.statusCode, 200)
    assert.equal((active.json() as { runId: string | null }).runId, null)
    const badActive = await rig.app.inject({ method: 'GET', url: '/api/runs/active?threadRef=ch:1', headers: COOKIE })
    assert.equal(badActive.statusCode, 404)

    const signal = await rig.app.inject({ method: 'POST', url: '/api/runs/x/signal', headers: COOKIE, payload: { kind: 'abort' } })
    assert.equal(signal.statusCode, 409)

    const health = await rig.app.inject({ method: 'GET', url: '/healthz' })
    assert.equal(health.statusCode, 200)
  } finally {
    await rig.runner.stop()
    await rig.app.close()
  }
})
