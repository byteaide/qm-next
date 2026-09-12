/**
 * @qm/im-bridge — the M2 convergence bridge between the IM contract
 * (`@qm/im-core`) and the turn pipeline (`@qm/api` composition root).
 */
export {
  APPROVAL_VALUE_KIND,
  approvalRequestCard,
  createImTurnBridge,
  imRunResultDelivery,
  parseApprovalValue,
} from './bridge.ts'
export type {
  ApprovalActionValue,
  ImReplyRoute,
  ImTurnBridge,
  ImTurnBridgeDeps,
  ImTurnBridgeLoopOptions,
  ImTurnBridgeOptions,
} from './bridge.ts'
export { Config, ImTurnBridgeService } from './service.ts'
export type { ImBridgeConfig } from './service.ts'
export { default } from './service.ts'
