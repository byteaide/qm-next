/**
 * @qm/im-bridge — the M2 convergence bridge between the IM contract
 * (`@qm/im-core`) and the turn pipeline (`@qm/api` composition root).
 * Since 12.0 approval semantics are owned by `@qm/approvals`; the bridge
 * records pending approvals durably and routes clicks through the decision
 * state machine.
 */
export { APPROVAL_VALUE_KIND, parseApprovalValue } from '@qm/approvals'
export type { ApprovalActionValue } from '@qm/approvals'
export {
  approvalRequestCard,
  createImTurnBridge,
  defaultApprovalCardRenderer,
  imRunResultDelivery,
  isPendingApprovalResult,
} from './bridge.ts'
export type {
  ImReplyRoute,
  ImTurnBridge,
  ImTurnBridgeDeps,
  ImTurnBridgeLoopOptions,
  ImTurnBridgeOptions,
} from './bridge.ts'
export { Config, ImTurnBridgeService } from './service.ts'
export type { ImBridgeConfig } from './service.ts'
export { default } from './service.ts'
