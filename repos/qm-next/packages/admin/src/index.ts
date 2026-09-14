/**
 * @qm/admin — admin control plane ported from qm `src/admin/` +
 * `src/audit/`: org-admin grants and service, scoped event sinks (turn
 * metrics, error log, credential usage, egress audit, operator audit log)
 * with memory and Postgres implementations, retention/attribution/users
 * analytics and the invite-email renderer.
 */
export {
  createAuditLog,
  type AuditEvent,
  type AuditLog,
} from './audit-log.ts'
export {
  createMapAdminGrantPersistence,
  createMemoryAdminGrantPersistence,
  createAdminGrantStore,
  grantKey,
  type AdminGrant,
  type AdminGrantPersistence,
  type AdminGrantStore,
  type AdminGrantStoreOptions,
  type AdminRole,
} from './admin-grant-store.ts'
export {
  AdminError,
  adminStatusFromGrants,
  bootAdminGrantSeed,
  createAdminService,
  parseAdminGrants,
  type AdminService,
  type AdminServiceOptions,
  type AdminStatus,
} from './admin-service.ts'
export { samePerson, personKey } from './person-key.ts'
export {
  createPostgresEventSink,
  createScopedEventSink,
  createTimestampedEventSink,
  type EventColumn,
  type PostgresEventSink,
  type PostgresEventSinkConfig,
  type ScopedEvent,
  type ScopedEventSink,
  type ScopedEventSinkOptions,
  type TimestampedEventSink,
} from './scoped-event-sink.ts'
export {
  cacheHitRatio,
  createMetricsSink,
  isStablePrefixMiss,
  type MetricsSink,
  type TurnMetricSample,
} from './metrics-sink.ts'
export { createPostgresMetricsSink } from './postgres-metrics-sink.ts'
export { createErrorLog, type ErrorEvent, type ErrorLog } from './error-log.ts'
export { createPostgresErrorLog } from './postgres-error-log.ts'
export {
  createCredentialUsageSink,
  type CredentialUsageSample,
  type CredentialUsageSink,
} from './credential-usage-sink.ts'
export { createPostgresCredentialUsageSink } from './postgres-credential-usage-sink.ts'
export {
  createEgressAuditSink,
  type EgressAuditRecord,
  type EgressAuditSink,
} from './egress-audit-sink.ts'
export { createPostgresEgressAuditSink } from './postgres-egress-audit-sink.ts'
export { createPostgresAdminGrantStore } from './postgres-admin-grant-store.ts'
export {
  createPostgresAuditLog,
} from './postgres-audit-log.ts'
export {
  forEachAttributedTurn,
  type AttributionInput,
  type AttributedTurn,
  type ParticipantWindow,
} from './attribution.ts'
export { computeRetention, type RetentionInput, type RetentionReport } from './retention.ts'
export { computeUsers, type AdminUserRow, type UsersInput } from './users.ts'
export {
  INVITE_EMAIL_NOT_CONFIGURED,
  createResendMailer,
  renderInviteEmail,
  type InviteMailer,
} from './invite-email.ts'
