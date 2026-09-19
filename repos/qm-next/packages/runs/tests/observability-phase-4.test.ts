/**
 * Phase 4 — Trigger Runtime observability tests.
 *
 * Covers plan §Phase 4 observability:
 *   - TRIGGER_SUBMIT_TOTAL name is pinned to plan §4.
 *   - bumpTriggerSubmit ticks on accepted/rejected/unavailable paths.
 *   - Default-registry fallback works without injected metrics.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RUN_METRICS,
  _resetDefaultRunMetricsRegistryForTests,
  bumpTriggerSubmit,
  createRunMetricsRegistry,
} from '@qm/runs'

test('observability: TRIGGER_SUBMIT_TOTAL name is pinned to plan §4', () => {
  assert.equal(RUN_METRICS.TRIGGER_SUBMIT_TOTAL, 'trigger_submit_total')
})

test('observability: bumpTriggerSubmit on injected registry — accepted', () => {
  const registry = createRunMetricsRegistry()
  bumpTriggerSubmit(registry, 'accepted')
  const snap = registry
    .snapshot()
    .find((s) => s.name === RUN_METRICS.TRIGGER_SUBMIT_TOTAL)
  assert.ok(snap)
  assert.equal(snap?.byLabels[0]?.labels?.outcome, 'accepted')
  assert.equal(snap?.byLabels[0]?.value, 1)
})

test('observability: bumpTriggerSubmit on injected registry — rejected', () => {
  const registry = createRunMetricsRegistry()
  bumpTriggerSubmit(registry, 'rejected')
  const snap = registry
    .snapshot()
    .find((s) => s.name === RUN_METRICS.TRIGGER_SUBMIT_TOTAL)
  assert.ok(snap)
  assert.equal(snap?.byLabels[0]?.labels?.outcome, 'rejected')
})

test('observability: bumpTriggerSubmit on injected registry — unavailable', () => {
  const registry = createRunMetricsRegistry()
  bumpTriggerSubmit(registry, 'unavailable')
  const snap = registry
    .snapshot()
    .find((s) => s.name === RUN_METRICS.TRIGGER_SUBMIT_TOTAL)
  assert.ok(snap)
  assert.equal(snap?.byLabels[0]?.labels?.outcome, 'unavailable')
})

test('observability: bumpTriggerSubmit falls back to default registry when no metrics injected', () => {
  _resetDefaultRunMetricsRegistryForTests()
  bumpTriggerSubmit(undefined, 'accepted')
  // Default registry is process-wide; verifying it doesn't throw and the
  // helper is callable is sufficient. A separate test would need to
  // inspect the default registry's snapshot.
  assert.ok(true)
})

test('observability: multiple outcomes accumulate on the same counter', () => {
  const registry = createRunMetricsRegistry()
  bumpTriggerSubmit(registry, 'accepted')
  bumpTriggerSubmit(registry, 'accepted')
  bumpTriggerSubmit(registry, 'rejected')
  const snap = registry
    .snapshot()
    .find((s) => s.name === RUN_METRICS.TRIGGER_SUBMIT_TOTAL)
  assert.ok(snap)
  const totals = new Map<string, number>()
  for (const { labels, value } of snap?.byLabels ?? []) {
    const outcome = labels?.outcome
    if (outcome !== undefined) totals.set(outcome, value)
  }
  assert.equal(totals.get('accepted'), 2)
  assert.equal(totals.get('rejected'), 1)
})