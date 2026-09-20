/**
 * Phase 6 §6.5 observability baseline extension: the oauth_* metric
 * name constants and the bumper helpers. The vault and OAuth flow
 * service contract suites assert the counters tick on real code paths.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { bumpOAuthFlow, bumpOAuthRedactionHit, bumpOAuthTokenDecrypt, createRunMetricsRegistry, RUN_METRICS } from '@qm/runs'

test('Phase 6 metric family constants are registered', () => {
  assert.equal(RUN_METRICS.OAUTH_FLOW_TOTAL, 'oauth_flow_total')
  assert.equal(RUN_METRICS.OAUTH_TOKEN_DECRYPT_TOTAL, 'oauth_token_decrypt_total')
  assert.equal(RUN_METRICS.OAUTH_REDACTION_HIT_TOTAL, 'oauth_redaction_hit_total')
})

test('bumpOAuthFlow ticks per step and outcome', () => {
  const metrics = createRunMetricsRegistry()
  bumpOAuthFlow(metrics, 'start', 'ok')
  bumpOAuthFlow(metrics, 'callback', 'ok')
  bumpOAuthFlow(metrics, 'complete', 'fail')
  const snapshot = metrics.snapshot().find((s) => s.name === RUN_METRICS.OAUTH_FLOW_TOTAL)
  assert.ok(snapshot)
  assert.equal(snapshot.total, 3)
  assert.ok(snapshot.byLabels.some((b) => b.labels.step === 'complete' && b.labels.outcome === 'fail'))
})

test('bumpOAuthTokenDecrypt ticks per provider and outcome', () => {
  const metrics = createRunMetricsRegistry()
  bumpOAuthTokenDecrypt(metrics, 'p6-mock', 'ok')
  bumpOAuthTokenDecrypt(metrics, 'p6-mock', 'error')
  const snapshot = metrics.snapshot().find((s) => s.name === RUN_METRICS.OAUTH_TOKEN_DECRYPT_TOTAL)
  assert.ok(snapshot)
  assert.equal(snapshot.total, 2)
  assert.ok(snapshot.byLabels.some((b) => b.labels.provider === 'p6-mock' && b.labels.outcome === 'error'))
})

test('bumpOAuthRedactionHit defaults to the log boundary and is distinct from redaction_hit_total', () => {
  const metrics = createRunMetricsRegistry()
  bumpOAuthRedactionHit(metrics)
  bumpOAuthRedactionHit(metrics, 'observation')
  const oauth = metrics.snapshot().find((s) => s.name === RUN_METRICS.OAUTH_REDACTION_HIT_TOTAL)
  assert.ok(oauth)
  assert.equal(oauth.total, 2)
  assert.ok(oauth.byLabels.some((b) => b.labels.boundary === 'observation'))
  assert.equal(metrics.snapshot().find((s) => s.name === RUN_METRICS.REDACTION_HIT_TOTAL), undefined, 'Phase 6 family is a distinct counter')
})
