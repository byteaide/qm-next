/**
 * The audit log lives in `@qm/admin` (the 12.0 sink home, qm
 * `src/audit/audit-log.ts`); re-exported here for the api services surface.
 */
import { createAuditLog } from '@qm/admin'

export { createAuditLog, type AuditEvent, type AuditLog } from '@qm/admin'

export const createMemoryAuditLog = createAuditLog
