/**
 * Phase 3 — Admission Record redaction tests.
 *
 * Mirrors the Phase 1 run-event redaction tests, scoped to Admission Record
 * surfaces (ADR-0016: tokens stay out of Run Events, Observation, and
 * Admission Records).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  redactAdmissionReason,
  redactAdmissionStageReason,
  redactExcerpt,
  redactSecrets,
} from '@qm/admission'

test('redactSecrets: Bearer token is masked', () => {
  const out = redactSecrets('Auth header: Bearer sk-ant-abcdefghijklmnop1234')
  assert.ok(!out.includes('sk-ant-abcdefghijklmnop1234'))
  assert.ok(out.includes('[redacted-credential]'))
})

test('redactSecrets: OpenAI API key is masked', () => {
  const out = redactSecrets('using key sk-or-abcdefghijklmnop1234 today')
  assert.ok(out.includes('[redacted-credential]'))
})

test('redactSecrets: PEM block is masked', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nABCDEF\n-----END PRIVATE KEY-----'
  const out = redactSecrets(pem)
  assert.ok(!out.includes('ABCDEF'))
  assert.ok(out.includes('[redacted-credential]'))
})

test('redactSecrets: api_key=... value is masked', () => {
  const out = redactSecrets('api_key=sk_live_abcdefghijklmnop1234')
  assert.ok(out.includes('[redacted-credential]'))
})

test('redactSecrets: passes through benign text', () => {
  const out = redactSecrets('rate limit exceeded — try again in 30s')
  assert.equal(out, 'rate limit exceeded — try again in 30s')
})

test('redactAdmissionStageReason: undefined passes through', () => {
  assert.equal(redactAdmissionStageReason(undefined), undefined)
})

test('redactAdmissionStageReason: redaction applied', () => {
  const out = redactAdmissionStageReason('token Bearer sk-ant-abcdefghijklmnop1234 leaked')
  assert.ok(out?.includes('[redacted-credential]'))
})

test('redactAdmissionReason: redaction applied', () => {
  const out = redactAdmissionReason('password=abc123passwordValue123')
  assert.ok(out?.includes('[redacted-credential]'))
})

test('redactExcerpt: redaction applied', () => {
  const out = redactExcerpt('excerpt: xoxb-fake-token-1234567890abcdef')
  assert.ok(out?.includes('[redacted-credential]'))
})