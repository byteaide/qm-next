/**
 * Phase 3 — Turn Admission Waterfall tests.
 *
 * Covers plan §3.1 waterfall order, plan §3.1.2 Admission Record tests,
 * and ADR-0007 short-circuit behavior. Slice 3.2 / 3.3 add Security Screen
 * and observability coverage; this file is the slice 3.1 surface.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRunMetricsRegistry } from '@qm/runs'
import {
  createMemoryAdmissionRecordStore,
  runAdmissionWaterfall,
  type StagePorts,
} from '@qm/admission'
import type { AdmissionInput, Principal, ScopeId } from '@qm/types'

const principal = (id: string): Principal => ({ id, type: 'internal' })
const scopeId: ScopeId = 'personal:test'

function makeInput(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    surface: 'web',
    actor: principal('person:ada'),
    ...(overrides.scopeId !== undefined ? { scopeId: overrides.scopeId } : {}),
    ...(overrides.commandRequest !== undefined ? { commandRequest: overrides.commandRequest } : {}),
  }
}

function allowPorts(overrides: Partial<StagePorts> = {}): StagePorts {
  return {
    identity: { async check() { return { decision: 'allow', latencyMs: 1 } } },
    rateLimit: {
      async check() {
        return { decision: 'allow', latencyMs: 1, limit: 100, remaining: 99, resetMs: 60_000 }
      },
    },
    session: {
      async resolveAndLease() {
        return {
          decision: 'allow',
          sessionId: 'session-A',
          scopeId,
          leaseToken: 'lease-token',
          systemPrompt: 'mock system prompt',
          orgScopeId: scopeId,
          latencyMs: 1,
        }
      },
    },
    dispatch: {
      async prepare() {
        return { decision: 'allow', latencyMs: 1 }
      },
    },
    ...(overrides.identity !== undefined ? { identity: overrides.identity } : {}),
    ...(overrides.rateLimit !== undefined ? { rateLimit: overrides.rateLimit } : {}),
    ...(overrides.budget !== undefined ? { budget: overrides.budget } : {}),
    ...(overrides.screen !== undefined ? { screen: overrides.screen } : {}),
    ...(overrides.session !== undefined ? { session: overrides.session } : {}),
    ...(overrides.dispatch !== undefined ? { dispatch: overrides.dispatch } : {}),
  }
}

test('waterfall: identity failure short-circuits before rate_limit', async () => {
  const store = createMemoryAdmissionRecordStore()
  let rateLimitCalls = 0
  const ports = allowPorts({
    identity: { async check() { return { decision: 'deny', reason: 'not internal', latencyMs: 1 } } },
    rateLimit: {
      async check() {
        rateLimitCalls += 1
        return { decision: 'allow', latencyMs: 1, limit: 100, remaining: 99, resetMs: 60_000 }
      },
    },
  })
  const outcome = await runAdmissionWaterfall({ ports, store }, makeInput())
  assert.equal(outcome.decision, 'rejected')
  if (outcome.decision !== 'rejected') throw new Error('unreachable')
  assert.equal(rateLimitCalls, 0)
  assert.equal(outcome.record.closingStage, 'identity')
  assert.equal(outcome.record.stages.length, 1)
  assert.equal(outcome.record.stages[0]?.stage, 'identity')
  assert.equal(outcome.record.stages[0]?.decision, 'deny')
})

test('waterfall: rate_limit failure short-circuits before budget and screen', async () => {
  const store = createMemoryAdmissionRecordStore()
  let budgetCalls = 0
  let screenCalls = 0
  const ports = allowPorts({
    rateLimit: { async check() { return { decision: 'deny', reason: 'rate', latencyMs: 1 } } },
    budget: {
      async check() {
        budgetCalls += 1
        return { decision: 'allow', latencyMs: 1 }
      },
    },
    screen: {
      async screen() {
        screenCalls += 1
        return { mode: 'off', decision: 'allow', ts: 0 }
      },
    },
  })
  const outcome = await runAdmissionWaterfall({ ports, store }, makeInput())
  assert.equal(outcome.decision, 'rejected')
  if (outcome.decision !== 'rejected') throw new Error('unreachable')
  assert.equal(budgetCalls, 0)
  assert.equal(screenCalls, 0)
  assert.equal(outcome.record.closingStage, 'rate_limit')
  assert.equal(outcome.record.stages.length, 2)
})

test('waterfall: budget failure short-circuits before screen', async () => {
  const store = createMemoryAdmissionRecordStore()
  let screenCalls = 0
  const ports = allowPorts({
    budget: { async check() { return { decision: 'deny', reason: 'budget', latencyMs: 1 } } },
    screen: {
      async screen() {
        screenCalls += 1
        return { mode: 'off', decision: 'allow', ts: 0 }
      },
    },
  })
  const outcome = await runAdmissionWaterfall({ ports, store }, makeInput())
  assert.equal(outcome.decision, 'rejected')
  if (outcome.decision !== 'rejected') throw new Error('unreachable')
  assert.equal(screenCalls, 0)
  assert.equal(outcome.record.closingStage, 'budget')
})

test('waterfall: session failure short-circuits before dispatch', async () => {
  const store = createMemoryAdmissionRecordStore()
  let dispatchCalls = 0
  const ports = allowPorts({
    session: {
      async resolveAndLease() {
        return { decision: 'deny', reason: 'no lease', latencyMs: 1 }
      },
    },
    dispatch: {
      async prepare() {
        dispatchCalls += 1
        return { decision: 'allow', latencyMs: 1 }
      },
    },
  })
  const outcome = await runAdmissionWaterfall({ ports, store }, makeInput())
  assert.equal(outcome.decision, 'rejected')
  if (outcome.decision !== 'rejected') throw new Error('unreachable')
  assert.equal(dispatchCalls, 0)
  assert.equal(outcome.record.closingStage, 'session')
})

test('waterfall: dispatch failure rejects but still records full history', async () => {
  const store = createMemoryAdmissionRecordStore()
  const ports = allowPorts({
    dispatch: {
      async prepare() {
        return { decision: 'deny', reason: 'dispatch refused', latencyMs: 1 }
      },
    },
  })
  const outcome = await runAdmissionWaterfall({ ports, store }, makeInput())
  assert.equal(outcome.decision, 'rejected')
  if (outcome.decision !== 'rejected') throw new Error('unreachable')
  assert.equal(outcome.record.closingStage, 'dispatch')
  assert.equal(outcome.record.stages.length, 6)
})

test('waterfall: accepted outcome has full history and resolved context', async () => {
  const store = createMemoryAdmissionRecordStore()
  const ports = allowPorts()
  const outcome = await runAdmissionWaterfall({ ports, store }, makeInput())
  assert.equal(outcome.decision, 'accepted')
  if (outcome.decision !== 'accepted') throw new Error('unreachable')
  assert.equal(outcome.record.decision, 'accepted')
  assert.equal(outcome.record.stages.length, 6) // 4 ran + budget/screen skipped (skips are recorded)
  assert.equal(outcome.resolved.sessionId, 'session-A')
  assert.equal(outcome.resolved.scopeId, scopeId)
  assert.equal(outcome.resolved.rateLimit?.limit, 100)
})

test('Admission Record: rejected work has no commandRequest', async () => {
  const store = createMemoryAdmissionRecordStore()
  const ports = allowPorts({
    identity: { async check() { return { decision: 'deny', reason: 'not internal', latencyMs: 1 } } },
  })
  const outcome = await runAdmissionWaterfall({ ports, store }, makeInput())
  assert.equal(outcome.decision, 'rejected')
  if (outcome.decision !== 'rejected') throw new Error('unreachable')
  assert.equal('commandRequest' in outcome, false)
})

test('Admission Record: rejected work persists to store with closing stage', async () => {
  const store = createMemoryAdmissionRecordStore()
  const ports = allowPorts({
    rateLimit: { async check() { return { decision: 'deny', reason: 'rate', latencyMs: 1 } } },
  })
  await runAdmissionWaterfall({ ports, store }, makeInput())
  const records = await store.list()
  assert.equal(records.length, 1)
  assert.equal(records[0]?.decision, 'rejected')
  assert.equal(records[0]?.closingStage, 'rate_limit')
  assert.equal(records[0]?.actor.id, 'person:ada')
})

test('Admission Record: accepted work persists to store with stage history', async () => {
  const store = createMemoryAdmissionRecordStore()
  const ports = allowPorts()
  await runAdmissionWaterfall({ ports, store }, makeInput())
  const records = await store.list()
  assert.equal(records.length, 1)
  assert.equal(records[0]?.decision, 'accepted')
  assert.equal(records[0]?.stages.length, 6)
})

test('Admission Record: redaction removes bearer tokens from reasons', async () => {
  const store = createMemoryAdmissionRecordStore()
  const ports = allowPorts({
    rateLimit: { async check() { return { decision: 'deny', reason: 'rate, see Bearer sk-ant-abcdefghijklmnop1234', latencyMs: 1 } } },
  })
  await runAdmissionWaterfall({ ports, store }, makeInput())
  const records = await store.list()
  const reason = records[0]?.reason ?? ''
  assert.ok(!reason.includes('sk-ant-'))
  assert.ok(reason.includes('[redacted-credential]'))
})

test('waterfall: stage ordering is identity → rate_limit → budget → screen → session → dispatch', async () => {
  const order: string[] = []
  const ports: StagePorts = {
    identity: { async check() { order.push('identity'); return { decision: 'allow', latencyMs: 1 } } },
    rateLimit: { async check() { order.push('rate_limit'); return { decision: 'allow', latencyMs: 1, limit: 100, remaining: 99, resetMs: 60_000 } } },
    budget: { async check() { order.push('budget'); return { decision: 'allow', latencyMs: 1 } } },
    screen: { async screen() { order.push('screen'); return { mode: 'off', decision: 'allow', ts: 0 } } },
    session: {
      async resolveAndLease() {
        order.push('session')
        return { decision: 'allow', sessionId: 's', scopeId, leaseToken: 'l', systemPrompt: '', orgScopeId: scopeId, latencyMs: 1 }
      },
    },
    dispatch: { async prepare() { order.push('dispatch'); return { decision: 'allow', latencyMs: 1 } } },
  }
  await runAdmissionWaterfall({ ports, store: createMemoryAdmissionRecordStore() }, makeInput())
  assert.deepEqual(order, ['identity', 'rate_limit', 'budget', 'screen', 'session', 'dispatch'])
})

test('waterfall: skipped budget/screen still appear in history', async () => {
  const store = createMemoryAdmissionRecordStore()
  const ports = allowPorts() // no budget, no screen
  const outcome = await runAdmissionWaterfall({ ports, store }, makeInput())
  if (outcome.decision !== 'accepted') throw new Error('expected accepted')
  const stages = outcome.record.stages.map((s) => s.stage)
  assert.deepEqual(stages, ['identity', 'rate_limit', 'budget', 'screen', 'session', 'dispatch'])
  const budget = outcome.record.stages.find((s) => s.stage === 'budget')
  const screen = outcome.record.stages.find((s) => s.stage === 'screen')
  assert.equal(budget?.decision, 'skipped')
  assert.equal(screen?.decision, 'skipped')
})

test('waterfall: metrics tick on every stage decision', async () => {
  const store = createMemoryAdmissionRecordStore()
  const metrics = createRunMetricsRegistry()
  const ports = allowPorts({
    rateLimit: { async check() { return { decision: 'deny', reason: 'rate', latencyMs: 1 } } },
  })
  await runAdmissionWaterfall({ ports, store, options: { metrics } }, makeInput())
  const snap = metrics.snapshot()
  const identity = snap.find(
    (s) => s.name === 'admission_decision_total' && s.byLabels.some((b) => b.labels.stage === 'identity' && b.labels.decision === 'allow'),
  )
  const rateLimit = snap.find(
    (s) => s.name === 'admission_decision_total' && s.byLabels.some((b) => b.labels.stage === 'rate_limit' && b.labels.decision === 'deny'),
  )
  const record = snap.find(
    (s) => s.name === 'admission_record_total' && s.byLabels.some((b) => b.labels.outcome === 'rejected'),
  )
  assert.ok(identity)
  assert.ok(rateLimit)
  assert.ok(record)
})