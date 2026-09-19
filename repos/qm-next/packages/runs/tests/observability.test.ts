/**
 * Phase 1 observability counters — unit tests.
 *
 * Asserts the metric names match §1.6 of the implementation plan and
 * that the redaction scanner flags the patterns documented in
 * `packages/runs/src/observability.ts`. The contract suite that
 * ticks the counters on real code paths lives in
 * `packages/store/tests/run-event-log.test.ts` and
 * `packages/runs/tests/run-observation.test.ts`.
 *
 * Linked ADRs: ADR-0013, ADR-0014.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RUN_METRICS,
  createRunMetricsRegistry,
  isSecretShaped,
  redactSecrets,
} from '../src/observability.ts'

test('RUN_METRICS: every canonical name is present', () => {
  assert.equal(typeof RUN_METRICS.EVENT_COMMIT_TOTAL, 'string')
  assert.equal(RUN_METRICS.EVENT_COMMIT_TOTAL, 'run_event_commit_total')
  assert.equal(RUN_METRICS.EVENT_TX_FAILURES_TOTAL, 'run_event_transaction_failures_total')
  assert.equal(RUN_METRICS.SEQ_CONFLICT_TOTAL, 'run_seq_conflict_total')
  assert.equal(RUN_METRICS.LEASE_OWNERSHIP_CONFLICT_TOTAL, 'run_lease_ownership_conflict_total')
})

test('createRunMetricsRegistry: inc/add accumulate per-label-set', () => {
  const reg = createRunMetricsRegistry()
  reg.inc(RUN_METRICS.EVENT_COMMIT_TOTAL, { outcome: 'terminal' })
  reg.inc(RUN_METRICS.EVENT_COMMIT_TOTAL, { outcome: 'terminal' })
  reg.inc(RUN_METRICS.EVENT_COMMIT_TOTAL, { outcome: 'non_terminal' })
  reg.add(RUN_METRICS.SEQ_CONFLICT_TOTAL, 5)
  const snap = reg.snapshot()
  const commit = snap.find((s) => s.name === RUN_METRICS.EVENT_COMMIT_TOTAL)
  const conflict = snap.find((s) => s.name === RUN_METRICS.SEQ_CONFLICT_TOTAL)
  assert.ok(commit)
  assert.ok(conflict)
  if (commit && conflict) {
    assert.equal(commit.total, 3)
    assert.equal(conflict.total, 5)
  }
})

test('createRunMetricsRegistry: reset clears all counters', () => {
  const reg = createRunMetricsRegistry()
  reg.inc(RUN_METRICS.EVENT_COMMIT_TOTAL)
  reg.reset()
  assert.equal(reg.snapshot().length, 0)
})

test('isSecretShaped: bearer tokens and PEM blocks are flagged', () => {
  assert.equal(isSecretShaped('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'), true)
  assert.equal(isSecretShaped('-----BEGIN RSA PRIVATE KEY-----\nxyz\n-----END RSA PRIVATE KEY-----'), true)
  assert.equal(isSecretShaped('hello world'), false)
  assert.equal(isSecretShaped('short token'), false)
})

test('redactSecrets: secret-shaped matches are replaced; non-secrets pass through', () => {
  const redacted = redactSecrets('Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEF hi')
  assert.equal(redacted.includes('Bearer '), false)
  assert.equal(redacted.includes('[redacted]'), true)
  assert.equal(redactSecrets('plain text').includes('plain text'), true)
})