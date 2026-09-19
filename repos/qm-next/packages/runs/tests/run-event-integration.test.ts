/**
 * Phase 1 run-event integration helpers — unit tests.
 *
 * Asserts that `buildTerminalEventDraft` produces a draft whose
 * target-state and outcome fields are coherent (a `failed` outcome
 * always carries a `failureReason`; `succeeded` and `cancelled` do
 * not). The transaction-level tests for `appendTerminalEvent` live
 * in `packages/store/tests/run-event-log.test.ts` because they
 * require a real Postgres pool.
 *
 * Linked ADRs: ADR-0001, ADR-0013.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTerminalEventDraft } from '../src/run-event-integration.ts'

test('buildTerminalEventDraft: succeeded carries no failureReason', () => {
  const draft = buildTerminalEventDraft({
    run: {
      id: 'r1',
      sessionId: 's1',
      targetState: 'succeeded',
      runSource: 'target',
      attempts: 1,
    },
    outcome: 'succeeded',
  })
  assert.equal(draft.kind, 'run.finished')
  assert.equal(draft.outcome, 'succeeded')
  assert.equal((draft as { failureReason?: string }).failureReason, undefined)
})

test('buildTerminalEventDraft: failed carries the closed-set FailureReason', () => {
  const draft = buildTerminalEventDraft({
    run: {
      id: 'r1',
      sessionId: 's1',
      targetState: 'failed',
      runSource: 'target',
      attempts: 1,
    },
    outcome: 'failed',
    failureReason: 'command_refused',
  })
  assert.equal(draft.kind, 'run.finished')
  assert.equal(draft.outcome, 'failed')
  assert.equal((draft as { failureReason?: string }).failureReason, 'command_refused')
})

test('buildTerminalEventDraft: cancelled has no failureReason', () => {
  const draft = buildTerminalEventDraft({
    run: {
      id: 'r1',
      sessionId: 's1',
      targetState: 'cancelled',
      runSource: 'target',
      attempts: 1,
    },
    outcome: 'cancelled',
  })
  assert.equal(draft.outcome, 'cancelled')
  assert.equal((draft as { failureReason?: string }).failureReason, undefined)
})