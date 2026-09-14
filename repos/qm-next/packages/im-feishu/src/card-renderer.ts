/**
 * Lark card approval renderer (provider-native `OutboundBody.card`),
 * migrated from the M3 bridge built-in so card payloads live with their
 * provider. Button values carry the structured `ApprovalActionValue`
 * object — the Feishu SDK round-trips card values verbatim, and
 * `parseApprovalValue` accepts the object form.
 */
import {
  AGENT_REQUEST_VALUE_KIND,
  APPROVAL_VALUE_KIND,
  encodeAgentRequestValue,
  encodeApprovalValue,
  type AgentRequestActionValue,
  type AgentRequestDecision,
  type ApprovalActionValue,
  type ApprovalDecision,
} from '@qm/approvals'
import type { ImApprovalCardRenderer, ImApprovalCardSpec } from '@qm/im-core'

export function larkApprovalCard(spec: ImApprovalCardSpec): Record<string, unknown> {
  const primary = spec.approvals[0]
  const command = primary?.command ?? 'turn'
  const reason = primary?.reason ?? 'requires approval'
  const detail = spec.approvals.length > 1 ? ` (+${spec.approvals.length - 1} more)` : ''
  const value = (decision: ApprovalDecision): ApprovalActionValue => ({
    kind: APPROVAL_VALUE_KIND,
    runId: spec.runId,
    sessionId: spec.sessionId,
    ...(primary ? { requestId: primary.requestId } : { requestId: '' }),
    command,
    decision,
  })
  return {
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: 'Approval needed' }, template: 'orange' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**${command}** — ${reason}${detail}` } },
      {
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: 'Approve' }, type: 'primary', value: encodeApprovalValue(value('approve')) },
          { tag: 'button', text: { tag: 'plain_text', content: 'Reject' }, type: 'danger', value: encodeApprovalValue(value('reject')) },
        ],
      },
    ],
  }
}

export function larkAgentRequestCard(spec: {
  requestId: string
  originLabel: string
  targetLabel: string
  task: string
}): Record<string, unknown> {
  const value = (decision: AgentRequestDecision): AgentRequestActionValue => ({
    kind: AGENT_REQUEST_VALUE_KIND,
    requestId: spec.requestId,
    decision,
  })
  const task = spec.task.replace(/\s+/g, ' ').trim()
  return {
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: 'Personal agent request' }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**${spec.originLabel} → ${spec.targetLabel}**\n${task}` } },
      {
        tag: 'context',
        elements: [{ tag: 'plain_text', content: 'This runs in your personal agent context. The result can be posted back to the original thread.' }],
      },
      {
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: 'Run with my setup' }, type: 'primary', value: encodeAgentRequestValue(value('approve')) },
          { tag: 'button', text: { tag: 'plain_text', content: 'Decline' }, type: 'danger', value: encodeAgentRequestValue(value('reject')) },
        ],
      },
    ],
  }
}

export function createLarkApprovalCardRenderer(): ImApprovalCardRenderer {
  return { render: larkApprovalCard, renderAgentRequest: larkAgentRequestCard }
}
