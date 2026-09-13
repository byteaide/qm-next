/**
 * Block Kit approval card (provider-native `OutboundBody.card`), ported
 * from qm `src/slack/approval-cards.ts` onto the `@qm/approvals` codec.
 * Button values carry the JSON-encoded `ApprovalActionValue`; clicks come
 * back as `block_actions` interactions whose string values
 * `parseApprovalValue` decodes.
 */
import { APPROVAL_VALUE_KIND, encodeApprovalValue, type ApprovalActionValue, type ApprovalDecision } from '@qm/approvals'
import type { ImApprovalCardRenderer, ImApprovalCardSpec } from '@qm/im-core'

export const SLACK_APPROVAL_ACTION = {
  approve: 'qm:approval:approve',
  reject: 'qm:approval:reject',
} as const

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function button(text: string, actionId: string, value: ApprovalActionValue, style: 'primary' | 'danger'): Record<string, unknown> {
  return {
    type: 'button',
    text: { type: 'plain_text', text },
    action_id: actionId,
    value: JSON.stringify(encodeApprovalValue(value)),
    style,
  }
}

export function slackApprovalCard(spec: ImApprovalCardSpec): Record<string, unknown> {
  const primary = spec.approvals[0]
  const command = primary?.command ?? 'turn'
  const reason = primary?.reason ?? 'requires approval'
  const detail = spec.approvals.length > 1 ? `\n_${spec.approvals.length - 1} more approval(s) pending._` : ''
  const value = (decision: ApprovalDecision): ApprovalActionValue => ({
    kind: APPROVAL_VALUE_KIND,
    runId: spec.runId,
    sessionId: spec.sessionId,
    ...(primary ? { requestId: primary.requestId } : { requestId: '' }),
    command,
    decision,
  })
  return {
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: clip(`:lock: *Approval needed.*\n*Command:* \`${command}\` — ${clip(reason, 200)}${detail}`, 2900) },
      },
      {
        type: 'actions',
        elements: [
          button('Approve', SLACK_APPROVAL_ACTION.approve, value('approve'), 'primary'),
          button('Reject', SLACK_APPROVAL_ACTION.reject, value('reject'), 'danger'),
        ],
      },
    ],
  }
}

export function createSlackApprovalCardRenderer(): ImApprovalCardRenderer {
  return { render: slackApprovalCard }
}
