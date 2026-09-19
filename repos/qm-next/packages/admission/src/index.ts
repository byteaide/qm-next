/**
 * @qm/admission — Phase 3 Turn Admission orchestrator seam.
 *
 * Linked ADRs: 0004 (Security Screen Shadow Mode), 0006 (rejections do
 * not create Runs), 0007 (Admission is an orchestrator seam with a fixed
 * waterfall).
 */
export {
  runAdmissionWaterfall,
  __reset,
} from './waterfall.ts'

export {
  createMemoryAdmissionRecordStore,
  allocateAdmissionRecordId,
  type AdmissionRecordStore,
  type MemoryAdmissionRecordStoreOptions,
} from './admission-record-store.ts'

export {
  redactSecrets,
  redactAdmissionStageReason,
  redactAdmissionReason,
  redactExcerpt,
} from './redaction.ts'

export {
  WATERFALL_ORDER,
  type StagePorts,
  type StageDecision,
  type IdentityStagePort,
  type RateLimitStagePort,
  type BudgetStagePort,
  type ScreenStagePort,
  type SessionStagePort,
  type DispatchStagePort,
  type WaterfallOptions,
  type WaterfallOutcome,
  type AcceptedAdmission,
  type RejectedAdmission,
  type ResolvedContext,
} from './types.ts'