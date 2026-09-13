/**
 * Lark approval card: the renderer migrated from the M3 bridge keeps
 * request context and both decisions on the button values, and those
 * values round-trip through `parseApprovalValue`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { APPROVAL_VALUE_KIND, parseApprovalValue, type ApprovalActionValue } from '@qm/approvals'
import { larkApprovalCard } from '../src/index.ts'

test('larkApprovalCard keeps request context and both decisions on the buttons', () => {
  const card = larkApprovalCard({
    runId: 'run-1',
    sessionId: 'session-1',
    approvals: [{ requestId: 'session-1:deploy', command: 'deploy', reason: 'needs sign-off' }],
  })
  const elements = card['elements'] as Array<{ tag: string; actions?: Array<{ value: ApprovalActionValue }> }>
  const actions = elements.find((element) => element.tag === 'action')?.actions
  assert.equal(actions?.length, 2)
  assert.deepEqual(actions?.[0]?.value, {
    kind: APPROVAL_VALUE_KIND,
    runId: 'run-1',
    sessionId: 'session-1',
    requestId: 'session-1:deploy',
    command: 'deploy',
    decision: 'approve',
  })
  assert.equal(actions?.[1]?.value.decision, 'reject')
})

test('lark card button values parse back through parseApprovalValue', () => {
  const card = larkApprovalCard({
    runId: 'run-2',
    sessionId: 'session-2',
    approvals: [{ requestId: 'session-2:migrate', command: 'migrate', reason: 'destructive' }],
  })
  const elements = card['elements'] as Array<{ tag: string; actions?: Array<{ value: unknown }> }>
  const actions = elements.find((element) => element.tag === 'action')?.actions ?? []
  for (const action of actions) {
    const parsed = parseApprovalValue(action.value)
    assert.ok(parsed)
    assert.equal(parsed.runId, 'run-2')
    assert.equal(parsed.requestId, 'session-2:migrate')
    assert.ok(parsed.decision === 'approve' || parsed.decision === 'reject')
  }
})
