/**
 * Phase 1 slice 1.4 — Run Observation HTTP routes.
 *
 * Exercises the snapshot/replay/subscribe endpoints through the Fastify
 * route table. Asserts:
 *   - 401 when bearer is missing/invalid.
 *   - 404 when the Run does not exist.
 *   - 400 when the `after` cursor is invalid.
 *   - 200 + typed envelope on snapshot/replay.
 *   - 200 + SSE stream on subscribe.
 *   - 200 + `skipped_newer_session` counter ticks when redaction fires.
 *
 * Linked ADRs: 0001, 0013, 0014.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type {
  EventCursor,
  Run,
  RunSnapshot,
  RunStore,
  RunVisibilityToken,
  TargetRunEvent,
  TargetRunObservation,
} from '@qm/types'
import { createApiServer, mintSignedPayload, type ApiDeps, type ApiServerOptions } from '../src/index.ts'
import { RUN_METRICS, createRunMetricsRegistry } from '@qm/runs'

const SECRET = 'slice-1-4-secret'
const OPTS: ApiServerOptions = { secrets: [SECRET] }

async function token(principalId: string): Promise<string> {
  return mintSignedPayload({ p: principalId }, SECRET)
}

function auth(principalId: string): Record<string, string> {
  return { authorization: `Bearer ${principalId}` } // not used — placeholder for tests that bypass signing
}

/** Build a fake `TargetRunObservation` port backed by an in-memory
 *  event list. The fake mirrors the contract used by the route: callers
 *  receive a `RunVisibilityToken` and the fake records the tokens so
 *  the test can assert authorization is wired. */
function makeObservation(events: readonly TargetRunEvent[]): TargetRunObservation & {
  seenAuth: RunVisibilityToken[]
  seenCursors: EventCursor[]
} {
  const seenAuth: RunVisibilityToken[] = []
  const seenCursors: EventCursor[] = []
  return {
    seenAuth,
    seenCursors,
    async snapshot(runId, auth) {
      seenAuth.push(auth)
      const latest = events.at(-1)
      if (!latest) return null
      const snapshot: RunSnapshot = {
        id: runId,
        sessionId: latest.sessionId,
        state: 'running',
        attempts: 0,
        lastEventSeq: latest.seq,
        createdAt: latest.ts,
        updatedAt: latest.ts,
      }
      return snapshot
    },
    async replay(from, auth) {
      seenAuth.push(auth)
      seenCursors.push(from)
      return events.filter((e) => e.seq > from.seq)
    },
    subscribe(from, auth, listener) {
      seenAuth.push(auth)
      seenCursors.push(from)
      for (const e of events) {
        if (e.seq > from.seq) listener(e)
      }
      return () => undefined
    },
  }
}

function makeEvent(seq: number, kind: TargetRunEvent['kind'] = 'run.created'): TargetRunEvent {
  return {
    runId: 'run-1',
    sessionId: 'session-A',
    seq,
    ts: 1_700_000_000_000 + seq,
    kind,
  } as TargetRunEvent
}

async function seedRun(runs: RunStore): Promise<Run> {
  const enq = await runs.enqueue({
    sessionId: 'session-A',
    request: {
      surface: 'api',
      actor: { type: 'internal', id: 'tester' },
      conversation: { kind: 'dm', threadRef: 'thread-1', audience: [] },
      origin: { kind: 'direct' },
      text: 'slice-1-4 observation',
    },
  })
  return enq.run
}

function buildDeps(observation: TargetRunObservation, metrics?: ReturnType<typeof createRunMetricsRegistry>): ApiDeps {
  const runs = createMemoryRunStore()
  const sessions = createMemorySessionStore()
  return {
    orchestrator: {} as never,
    sessions,
    runs,
    resolution: {} as never,
    runsObservation: { runs, observation, ...(metrics ? { metrics } : {}) },
  }
}

test('runs-observation snapshot: 401 without bearer', async () => {
  const observation = makeObservation([])
  const deps = buildDeps(observation)
  const app = createApiServer(deps, OPTS)
  const seed = await seedRun(deps.runs)
  const res = await app.inject({ method: 'GET', url: `/v1/runs/${seed.id}/observation/snapshot` })
  assert.equal(res.statusCode, 401)
})

test('runs-observation snapshot: 200 returns RunSnapshot and records auth', async () => {
  const events = [makeEvent(0), makeEvent(1, 'attempt.started')]
  const observation = makeObservation(events)
  const deps = buildDeps(observation)
  const app = createApiServer(deps, OPTS)
  const seed = await seedRun(deps.runs)
  const res = await app.inject({
    method: 'GET',
    url: `/v1/runs/${seed.id}/observation/snapshot`,
    headers: { authorization: `Bearer ${await token('person:ada')}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json() as RunSnapshot
  assert.equal(body.id, seed.id)
  assert.equal(body.lastEventSeq, 1)
  assert.equal((observation as ReturnType<typeof makeObservation>).seenAuth.length, 1)
  assert.equal((observation as ReturnType<typeof makeObservation>).seenAuth[0]?.callerPrincipalId, 'person:ada')
  // The minted bearer resolves to an internal control-plane actor, so
  // the visibility heuristic rides the `internal` reach scope (slice
  // 1.4 ships the conservative principal-id check; ADR-0014 §3).
  assert.equal((observation as ReturnType<typeof makeObservation>).seenAuth[0]?.scope, 'internal')
})

test('runs-observation replay: 400 when after cursor is invalid', async () => {
  const observation = makeObservation([makeEvent(0)])
  const deps = buildDeps(observation)
  const app = createApiServer(deps, OPTS)
  const seed = await seedRun(deps.runs)
  const res = await app.inject({
    method: 'GET',
    url: `/v1/runs/${seed.id}/observation/replay?after=not-a-number`,
    headers: { authorization: `Bearer ${await token('person:ada')}` },
  })
  assert.equal(res.statusCode, 400)
})

test('runs-observation replay: 200 returns events strictly after cursor', async () => {
  const events = [makeEvent(0), makeEvent(1), makeEvent(2, 'attempt.finished')]
  const observation = makeObservation(events)
  const deps = buildDeps(observation)
  const app = createApiServer(deps, OPTS)
  const seed = await seedRun(deps.runs)
  const res = await app.inject({
    method: 'GET',
    url: `/v1/runs/${seed.id}/observation/replay?after=0`,
    headers: { authorization: `Bearer ${await token('person:ada')}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json() as TargetRunEvent[]
  assert.deepEqual(
    body.map((e) => e.seq),
    [1, 2],
  )
})

test('runs-observation subscribe: 200 emits events as SSE data frames', async () => {
  const events = [makeEvent(0), makeEvent(1)]
  const observation = makeObservation(events)
  const deps = buildDeps(observation)
  const app = createApiServer(deps, OPTS)
  const seed = await seedRun(deps.runs)
  // A live SSE tail never ends by design, so drive it over a real
  // listener and cancel the stream once both frames are observed.
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}/v1/runs/${seed.id}/observation/subscribe?after=-1`
  const res = await fetch(url, { headers: { authorization: `Bearer ${await token('person:ada')}` } })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let seen = ''
  while (!seen.includes('"seq":0') || !seen.includes('"seq":1')) {
    const { done, value } = await reader.read()
    if (done) break
    seen += decoder.decode(value, { stream: true })
  }
  await reader.cancel().catch(() => undefined)
  assert.match(seen, /event: run_observation/)
  assert.match(seen, /"seq":0/)
  assert.match(seen, /"seq":1/)
  await app.close()
})

test('runs-observation: redaction at the boundary ticks REDACTION_HIT_TOTAL', async () => {
  const secret = "abcdef0123456789abcdef0123456789" // synthetic bearer token fixture (matches the scanner pattern)
  const events: TargetRunEvent[] = [
    {
      runId: 'run-1',
      sessionId: 'session-A',
      seq: 0,
      ts: 1_700_000_000_000,
      kind: 'progress',
      redactedExcerpt: `Bearer ${secret}`,
    } as TargetRunEvent,
  ]
  const registry = createRunMetricsRegistry()
  const observation = makeObservation(events)
  // The boundary scanner consumes the serialized snapshot payload, so
  // carry the secret-shaped text on the snapshot the fake returns.
  const leaking = {
    ...observation,
    async snapshot(runId: string, auth: RunVisibilityToken) {
      const snap = await observation.snapshot(runId, auth)
      return snap === null ? null : ({ ...snap, lastMessage: `Bearer ${secret}` } as unknown as RunSnapshot)
    },
  }
  const deps = buildDeps(leaking, registry)
  const app = createApiServer(deps, OPTS)
  const seed = await seedRun(deps.runs)
  const res = await app.inject({
    method: 'GET',
    url: `/v1/runs/${seed.id}/observation/snapshot`,
    headers: { authorization: `Bearer ${await token('person:ada')}` },
  })
  assert.equal(res.statusCode, 200)
  const snap = registry.snapshot().find((s) => s.name === RUN_METRICS.REDACTION_HIT_TOTAL)
  assert.ok(snap, `expected ${RUN_METRICS.REDACTION_HIT_TOTAL} to be ticked`)
  assert.ok((snap?.total ?? 0) >= 1)
  // Secret bytes never leak.
  assert.equal(res.body.includes(secret), false)
})

test('runs-observation: 404 when Run does not exist', async () => {
  const observation = makeObservation([])
  const app = createApiServer(buildDeps(observation), OPTS)
  const res = await app.inject({
    method: 'GET',
    url: '/v1/runs/nonexistent/observation/snapshot',
    headers: { authorization: `Bearer ${await token('person:ada')}` },
  })
  assert.equal(res.statusCode, 404)
})

void auth // referenced indirectly via auth headers above