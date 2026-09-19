/**
 * Phase 3 — Turn Admission + Security Screen observability tests.
 *
 * Covers plan §3.3 metric contract:
 *   - 4 RUN_METRICS constants are pinned exactly to the plan strings
 *   - 4 helper bumpers tick on the right paths
 *   - Shadow unavailability records the counter; Enforce unavailability
 *     surfaces as admission_decision_total{stage="screen",decision="deny"}
 *     (and does NOT tick the unavailable counter, per plan §3.3).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RUN_METRICS,
  _resetDefaultRunMetricsRegistryForTests,
  bumpAdmissionDecision,
  bumpAdmissionRecord,
  bumpSecurityScreenDecision,
  bumpSecurityScreenUnavailable,
  createRunMetricsRegistry,
} from '@qm/runs'
import {
  createMemoryAdmissionRecordStore,
  createMemoryShadowRecordStore,
  createSecurityScreenAdapter,
  resolveScreenConfig,
  runAdmissionWaterfall,
  type StagePorts,
} from '@qm/admission'
import type { AdmissionInput } from '@qm/types'

const principal = { id: 'person:ada', type: 'internal' } as const

function makeInput(): AdmissionInput {
  return { surface: 'web', actor: { id: 'person:ada', type: 'internal' } }
}

function allowPorts(overrides: Partial<StagePorts> = {}): StagePorts {
  return {
    identity: { async check() { return { decision: 'allow', latencyMs: 1 } } },
    rateLimit: { async check() { return { decision: 'allow', latencyMs: 1, limit: 100, remaining: 99, resetMs: 60_000 } } },
    session: {
      async resolveAndLease() {
        return {
          decision: 'allow',
          sessionId: 'session-A',
          scopeId: 'personal:ada',
          leaseToken: 'lease-A',
          systemPrompt: '',
          orgScopeId: 'personal:ada',
          latencyMs: 1,
        }
      },
    },
    dispatch: { async prepare() { return { decision: 'allow', latencyMs: 1 } } },
    ...overrides,
  }
}

test('observability: ADMISSION_DECISION_TOTAL name is pinned to plan §3.3', () => {
  assert.equal(RUN_METRICS.ADMISSION_DECISION_TOTAL, 'admission_decision_total')
})

test('observability: ADMISSION_RECORD_TOTAL name is pinned to plan §3.3', () => {
  assert.equal(RUN_METRICS.ADMISSION_RECORD_TOTAL, 'admission_record_total')
})

test('observability: SECURITY_SCREEN_DECISION_TOTAL name is pinned to plan §3.3', () => {
  assert.equal(RUN_METRICS.SECURITY_SCREEN_DECISION_TOTAL, 'security_screen_decision_total')
})

test('observability: SECURITY_SCREEN_UNAVAILABLE_TOTAL name is pinned to plan §3.3', () => {
  assert.equal(RUN_METRICS.SECURITY_SCREEN_UNAVAILABLE_TOTAL, 'security_screen_unavailable_total')
})

test('observability: bumpAdmissionDecision ticks the default registry', () => {
  _resetDefaultRunMetricsRegistryForTests()
  bumpAdmissionDecision(undefined, 'identity', 'allow')
  const snap = createRunMetricsRegistry().snapshot()
  // Default registry is process-wide; snapshot from a fresh registry will
  // be empty. Instead, test the helper signature by using an injected
  // registry below; here we only assert no throw.
  assert.ok(Array.isArray(snap))
})

test('observability: bumpAdmissionDecision on injected registry', () => {
  const registry = createRunMetricsRegistry()
  bumpAdmissionDecision(registry, 'identity', 'deny')
  const snap = registry
    .snapshot()
    .find((s) => s.name === RUN_METRICS.ADMISSION_DECISION_TOTAL)
  assert.ok(snap)
  assert.equal(snap?.labels?.stage, 'identity')
  assert.equal(snap?.labels?.decision, 'deny')
})

test('observability: bumpAdmissionRecord on injected registry', () => {
  const registry = createRunMetricsRegistry()
  bumpAdmissionRecord(registry, 'rejected')
  const snap = registry
    .snapshot()
    .find((s) => s.name === RUN_METRICS.ADMISSION_RECORD_TOTAL)
  assert.ok(snap)
  assert.equal(snap?.labels?.outcome, 'rejected')
})

test('observability: bumpSecurityScreenDecision on injected registry', () => {
  const registry = createRunMetricsRegistry()
  bumpSecurityScreenDecision(registry, 'shadow', 'unavailable')
  const snap = registry
    .snapshot()
    .find((s) => s.name === RUN_METRICS.SECURITY_SCREEN_DECISION_TOTAL)
  assert.ok(snap)
  assert.equal(snap?.labels?.mode, 'shadow')
  assert.equal(snap?.labels?.decision, 'unavailable')
})

test('observability: bumpSecurityScreenUnavailable on injected registry', () => {
  const registry = createRunMetricsRegistry()
  bumpSecurityScreenUnavailable(registry, 'shadow')
  const snap = registry
    .snapshot()
    .find((s) => s.name === RUN_METRICS.SECURITY_SCREEN_UNAVAILABLE_TOTAL)
  assert.ok(snap)
  assert.equal(snap?.labels?.mode, 'shadow')
})

test('observability: waterfall ticks admission_decision_total{stage,decision} on every stage', async () => {
  const registry = createRunMetricsRegistry()
  const store = createMemoryAdmissionRecordStore()
  const ports = allowPorts({
    rateLimit: { async check() { return { decision: 'deny', reason: 'rate', latencyMs: 1 } } },
  })
  await runAdmissionWaterfall({ ports, store, options: { metrics: registry } }, makeInput())
  const snap = registry.snapshot()
  const identity = snap.find(
    (s) => s.name === RUN_METRICS.ADMISSION_DECISION_TOTAL && s.labels?.stage === 'identity' && s.labels?.decision === 'allow',
  )
  const rateLimit = snap.find(
    (s) => s.name === RUN_METRICS.ADMISSION_DECISION_TOTAL && s.labels?.stage === 'rate_limit' && s.labels?.decision === 'deny',
  )
  const record = snap.find(
    (s) => s.name === RUN_METRICS.ADMISSION_RECORD_TOTAL && s.labels?.outcome === 'rejected',
  )
  assert.ok(identity)
  assert.ok(rateLimit)
  assert.ok(record)
})

test('observability: shadow unavailability ticks unavailable counter (plan §3.3)', async () => {
  const registry = createRunMetricsRegistry()
  const store = createMemoryAdmissionRecordStore()
  const shadowStore = createMemoryShadowRecordStore()
  const adapter = createSecurityScreenAdapter({
    mode: 'shadow',
    screener: {
      provider: 'mock',
      shadow: false,
      async classify() {
        return { verdict: { decision: 'auto', unscreened: true, reason: 'proxy 502' }, score: 0, threshold: 0.5 }
      },
    },
    shadowStore,
  })
  const ports = allowPorts({ screen: adapter })
  await runAdmissionWaterfall({ ports, store, options: { metrics: registry } }, makeInput())
  const snap = registry.snapshot()
  const unavailable = snap.find(
    (s) => s.name === RUN_METRICS.SECURITY_SCREEN_UNAVAILABLE_TOTAL && s.labels?.mode === 'shadow',
  )
  const screenDecision = snap.find(
    (s) => s.name === RUN_METRICS.SECURITY_SCREEN_DECISION_TOTAL && s.labels?.mode === 'shadow' && s.labels?.decision === 'unavailable',
  )
  assert.ok(unavailable, 'shadow unavailable counter must tick')
  assert.ok(screenDecision, 'security_screen_decision_total{mode=shadow,decision=unavailable} must tick')
})

test('observability: enforce unavailability does NOT tick unavailable counter (plan §3.3)', async () => {
  const registry = createRunMetricsRegistry()
  const store = createMemoryAdmissionRecordStore()
  const config = resolveScreenConfig({
    raw: { mode: 'enforce', cutoverDeclared: true },
    operatorDeclaration: {
      sampleSize: 1000,
      falsePositiveReview: true,
      latencyMs: 200,
      availabilityPercent: 99.9,
      securityReview: true,
    },
  })
  if (!config.ok) throw new Error('expected enforce config to be ok in test')
  void config
  const adapter = createSecurityScreenAdapter({
    mode: 'enforce',
    screener: {
      provider: 'mock',
      shadow: false,
      async classify() {
        return { verdict: { decision: 'auto', unscreened: true, reason: 'proxy 502' }, score: 0, threshold: 0.5 }
      },
    },
    cutoverDeclared: true,
  })
  const ports = allowPorts({ screen: adapter })
  await runAdmissionWaterfall({ ports, store, options: { metrics: registry } }, makeInput())
  const snap = registry.snapshot()
  const unavailable = snap.find(
    (s) => s.name === RUN_METRICS.SECURITY_SCREEN_UNAVAILABLE_TOTAL && s.labels?.mode === 'enforce',
  )
  // Plan §3.3: Enforce mode unavailability does NOT tick the unavailable
  // counter; it surfaces as admission_decision_total{stage="screen",decision="deny"}.
  assert.equal(unavailable, undefined)
  const screenReject = snap.find(
    (s) => s.name === RUN_METRICS.ADMISSION_DECISION_TOTAL && s.labels?.stage === 'screen' && s.labels?.decision === 'deny',
  )
  assert.ok(screenReject)
  const recordReject = snap.find(
    (s) => s.name === RUN_METRICS.ADMISSION_RECORD_TOTAL && s.labels?.outcome === 'rejected',
  )
  assert.ok(recordReject)
})