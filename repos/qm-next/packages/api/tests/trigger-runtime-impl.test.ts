/**
 * Phase 4 — Trigger Runtime impl tests.
 *
 * Covers plan §Phase 4 Runtime behavior tests:
 *   - Trigger can submit a Turn through the minimal contract.
 *   - Identity returns pinned fields.
 *   - Health returns ok.
 *   - Failure surfaces a structured TriggerRuntimeError.
 *
 * Slice 4.1 surface. ADR-0003: API supplies the implementation.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  Principal,
  ResolutionService,
  RunStore,
  SessionStore,
} from '@qm/types'
import {
  TriggerRuntimeError,
  createTriggerRuntimeFromApi,
} from '@qm/api'
import { RUN_METRICS, createRunMetricsRegistry } from '@qm/runs'

const principal: Principal = { id: 'person:ada', type: 'internal' }

const resolution: ResolutionService = {
  async resolve() {
    return { systemPrompt: '', orgScopeId: 'personal:ada' }
  },
  scopeFor: () => 'personal:ada',
}

function makeRunStore(opts: { enqueueError?: Error } = {}): RunStore & { enqueued: unknown[] } {
  const enqueued: unknown[] = []
  const store = {
    enqueued,
    async enqueue(input: unknown) {
      if (opts.enqueueError) throw opts.enqueueError
      enqueued.push(input)
      // EnqueueResult contract shape (types/run.ts §EnqueueResult).
      return {
        run: { id: `run-${enqueued.length}`, sessionId: 'session-A' },
        deduped: false,
      }
    },
    async claim() {
      return null
    },
    async complete() {
      return false
    },
    async fail() {
      return false
    },
  }
  return store as unknown as RunStore & { enqueued: unknown[] }
}

function makeSessionStore(): SessionStore {
  return {
    async getOrCreateByThread() {
      return {
        id: 'session-A',
        threadRef: 'trigger:fire-1',
        kind: 'web',
        scopeId: 'personal:ada',
        surface: 'cron',
        channelName: 'cron',
        participants: [principal],
        createdAt: 0,
        updatedAt: 0,
      }
    },
    async addParticipant() {},
    async acquireLease() {
      return { lease: 'lease-A' as never }
    },
    async listByParticipant() {
      return []
    },
    async getEntries() {
      return []
    },
    async append() {
      return {
        id: 'entry-1',
        sessionId: 'session-A',
        type: 'user',
        payload: { text: 'hi', author: 'person:ada' },
        scopeLabel: 'personal:ada',
        createdAt: 0,
      }
    },
    async releaseLease() {
      return true
    },
    async getForViewer() {
      return null
    },
    async fork() {
      return {
        id: 'session-B',
        threadRef: 'thread-B',
        kind: 'web',
        scopeId: 'personal:ada',
        surface: 'cron',
        channelName: 'cron',
        participants: [principal],
        createdAt: 0,
        updatedAt: 0,
      }
    },
    async patch() {
      return null
    },
  } as unknown as SessionStore
}

function makeDeps(opts: { enqueueError?: Error } = {}): { runs: RunStore & { enqueued: unknown[] }; sessions: SessionStore; resolution: ResolutionService } {
  return {
    runs: makeRunStore(opts),
    sessions: makeSessionStore(),
    resolution,
  }
}

test('trigger-runtime: identity returns pinned fields', () => {
  const runtime = createTriggerRuntimeFromApi(makeDeps(), {
    instanceId: 'test-instance',
    version: '1.2.3',
    supportedTriggers: ['cron', 'manual'],
  })
  const identity = runtime.identity()
  assert.equal(identity.instanceId, 'test-instance')
  assert.equal(identity.version, '1.2.3')
  assert.deepEqual(identity.supportedTriggers, ['cron', 'manual'])
})

test('trigger-runtime: identity defaults', () => {
  const runtime = createTriggerRuntimeFromApi(makeDeps())
  const identity = runtime.identity()
  assert.match(identity.instanceId, /^api-\d+$/)
  assert.equal(identity.version, '0.1.0')
  assert.ok(identity.supportedTriggers.includes('cron'))
})

test('trigger-runtime: health returns ok', async () => {
  const runtime = createTriggerRuntimeFromApi(makeDeps())
  const health = await runtime.health()
  assert.equal(health.ok, true)
})

test('trigger-runtime: submit creates a Run and returns identity', async () => {
  const deps = makeDeps()
  const runtime = createTriggerRuntimeFromApi(deps)
  const result = await runtime.submit({
    triggerKind: 'cron',
    actor: principal,
    scopeId: 'personal:ada',
    text: 'hello cron',
    fireKey: 'cron-1:1700000000000',
  })
  assert.match(result.runId, /^run-/)
  assert.equal(result.sessionId, 'session-A')
  assert.ok(typeof result.acceptedAt === 'number')
  assert.equal(deps.runs.enqueued.length, 1)
})

test('trigger-runtime: submit throws structured error on unsupported kind', async () => {
  const runtime = createTriggerRuntimeFromApi(makeDeps(), {
    supportedTriggers: ['cron'],
  })
  await assert.rejects(
    () =>
      runtime.submit({
        triggerKind: 'unknown',
        actor: principal,
        scopeId: 'personal:ada',
        text: 'hi',
        fireKey: 'k-1',
      }),
    (err: unknown) => {
      assert.ok(err instanceof TriggerRuntimeError)
      assert.equal((err as TriggerRuntimeError).code, 'unsupported_trigger_kind')
      return true
    },
  )
})

test('trigger-runtime: submit throws structured error on enqueue failure', async () => {
  const runtime = createTriggerRuntimeFromApi(makeDeps({ enqueueError: new Error('pg down') }))
  await assert.rejects(
    () =>
      runtime.submit({
        triggerKind: 'cron',
        actor: principal,
        scopeId: 'personal:ada',
        text: 'hi',
        fireKey: 'k-2',
      }),
    (err: unknown) => {
      assert.ok(err instanceof TriggerRuntimeError)
      assert.equal((err as TriggerRuntimeError).code, 'submit_failed')
      assert.match((err as TriggerRuntimeError).message, /pg down/)
      return true
    },
  )
})

test('trigger-runtime: submit ticks accepted counter on success', async () => {
  const metrics = createRunMetricsRegistry()
  const runtime = createTriggerRuntimeFromApi(makeDeps(), { metrics })
  await runtime.submit({
    triggerKind: 'cron',
    actor: principal,
    scopeId: 'personal:ada',
    text: 'hi',
    fireKey: 'k-3',
  })
  const snap = metrics.snapshot().find((s) => s.name === RUN_METRICS.TRIGGER_SUBMIT_TOTAL)
  assert.ok(snap)
  assert.equal(snap?.byLabels[0]?.labels?.outcome, 'accepted')
})

test('trigger-runtime: submit ticks rejected counter on validation error', async () => {
  const metrics = createRunMetricsRegistry()
  const runtime = createTriggerRuntimeFromApi(makeDeps(), {
    metrics,
    supportedTriggers: ['cron'],
  })
  await runtime.submit({
    triggerKind: 'unknown',
    actor: principal,
    scopeId: 'personal:ada',
    text: 'hi',
    fireKey: 'k-4',
  }).catch(() => undefined)
  const snap = metrics.snapshot().find((s) => s.name === RUN_METRICS.TRIGGER_SUBMIT_TOTAL)
  assert.ok(snap)
  assert.equal(snap?.byLabels[0]?.labels?.outcome, 'rejected')
})