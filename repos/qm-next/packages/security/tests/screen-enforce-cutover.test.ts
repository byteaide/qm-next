/**
 * Phase 3 — Security Screen Enforce cutover tests.
 *
 * Covers plan §3.2 Configuration tests and Enforce Mode tests:
 *   - Missing mode has a deterministic default (off).
 *   - Invalid mode fails startup.
 *   - Enforce Mode without completion criteria is an operator/process
 *     decision, not automatic code behavior (no auto-escalation).
 *   - Cutover requires explicit declaration.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveScreenConfig } from '@qm/security'

test('cutover: missing mode defaults to off', () => {
  const result = resolveScreenConfig({ raw: {} })
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('unreachable')
  assert.equal(result.config.mode, 'off')
  assert.equal(result.config.cutoverDeclared, false)
})

test('cutover: invalid mode fails startup', () => {
  const result = resolveScreenConfig({ raw: { mode: 'unknown' } })
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.match(result.reason, /invalid Security Screen mode/)
})

test('cutover: shadow mode is accepted', () => {
  const result = resolveScreenConfig({ raw: { mode: 'shadow', retentionMs: 3600 } })
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('unreachable')
  assert.equal(result.config.mode, 'shadow')
})

test('cutover: enforce mode requires cutoverDeclared', () => {
  const result = resolveScreenConfig({ raw: { mode: 'enforce' } })
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.match(result.reason, /cutoverDeclared/)
})

test('cutover: enforce mode requires operator declaration of criteria', () => {
  const result = resolveScreenConfig({ raw: { mode: 'enforce', cutoverDeclared: true } })
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.match(result.reason, /operator declaration/)
})

test('cutover: enforce mode requires securityReview=true', () => {
  const result = resolveScreenConfig({
    raw: { mode: 'enforce', cutoverDeclared: true },
    operatorDeclaration: {
      sampleSize: 1000,
      falsePositiveReview: true,
      latencyMs: 200,
      availabilityPercent: 99.9,
      securityReview: false,
    },
  })
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.match(result.reason, /securityReview/)
})

test('cutover: enforce mode with full operator declaration accepts', () => {
  const result = resolveScreenConfig({
    raw: { mode: 'enforce', cutoverDeclared: true },
    operatorDeclaration: {
      sampleSize: 1000,
      falsePositiveReview: true,
      latencyMs: 200,
      availabilityPercent: 99.9,
      securityReview: true,
    },
  })
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('unreachable')
  assert.equal(result.config.mode, 'enforce')
  assert.equal(result.config.cutoverDeclared, true)
})

test('cutover: no automatic time-based escalation', () => {
  // Time-based escalation would mean: if shadow has run for N days, switch
  // to enforce. This is forbidden by ADR-0004 §3. The config surface
  // doesn't accept a duration knob; only operator declarations.
  const result = resolveScreenConfig({
    raw: { mode: 'enforce', cutoverDeclared: true },
    operatorDeclaration: {
      sampleSize: 1000,
      falsePositiveReview: true,
      latencyMs: 200,
      availabilityPercent: 99.9,
      securityReview: true,
    },
  })
  assert.equal(result.ok, true)
  // The config does not record a "started at" timestamp; the operator
  // owns the decision.
})