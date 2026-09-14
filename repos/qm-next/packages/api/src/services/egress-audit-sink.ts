/**
 * The egress audit sink lives in `@qm/admin` (the 12.0 sink home, qm
 * `src/admin/egress-audit-sink.ts`); re-exported here for the api services
 * surface.
 */
import { createEgressAuditSink } from '@qm/admin'

export { createEgressAuditSink, type EgressAuditRecord, type EgressAuditSink } from '@qm/admin'

export const createMemoryEgressAuditSink = createEgressAuditSink
