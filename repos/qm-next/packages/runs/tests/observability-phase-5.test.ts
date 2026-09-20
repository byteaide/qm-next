/**
 * Phase 5 §5.5 observability baseline extension: the gauge `set`
 * operation and the im_* metric name constants. The fanout contract
 * suite asserts the counters tick on real code paths.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRunMetricsRegistry, RUN_METRICS, setImSubscriberLag } from '@qm/runs'

test('set() replaces the gauge value instead of accumulating', () => {
  const metrics = createRunMetricsRegistry()
  setImSubscriberLag(metrics, 'bridge', 5)
  setImSubscriberLag(metrics, 'bridge', 2)
  setImSubscriberLag(metrics, 'audit', 9)
  const snapshot = metrics.snapshot()
  const lag = snapshot.find((s) => s.name === RUN_METRICS.IM_SUBSCRIBER_LAG)
  assert.ok(lag)
  const bridge = lag.byLabels.find((b) => b.labels.subscriber === 'bridge')
  const audit = lag.byLabels.find((b) => b.labels.subscriber === 'audit')
  assert.equal(bridge?.value, 2, 'latest value wins')
  assert.equal(audit?.value, 9)
  assert.equal(lag.total, 11, 'snapshot totals reflect current gauge values')
})

test('Phase 5 metric family constants are registered', () => {
  assert.equal(RUN_METRICS.IM_INTAKE_DEDUP_TOTAL, 'im_intake_dedup_total')
  assert.equal(RUN_METRICS.IM_SUBSCRIBER_LAG, 'im_subscriber_lag')
  assert.equal(RUN_METRICS.IM_SUBSCRIBER_RETRY_TOTAL, 'im_subscriber_retry_total')
  assert.equal(RUN_METRICS.IM_SUBSCRIBER_DEAD_LETTER_TOTAL, 'im_subscriber_dead_letter_total')
})
