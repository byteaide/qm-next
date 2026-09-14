/**
 * Egress audit sink (qm `src/admin/egress-audit-sink.ts`): sandbox egress
 * decisions, consumed by the admin egress view and the /v1/egress-audit
 * ingest route.
 */
import { createTimestampedEventSink } from './scoped-event-sink.ts'

export interface EgressAuditRecord {
  ts: number
  source: string
  host: string
  allowed: boolean
  scopeLabel: string
  port?: number
  verdict?: string
  via?: string
  peerIp?: string
  principalId?: string
}

interface EgressAuditQuery {
  scopeId?: string
  source?: string
  since?: number
  limit?: number
}

export interface EgressAuditSink {
  record(r: Omit<EgressAuditRecord, 'ts'>): void
  list(opts?: EgressAuditQuery): Promise<EgressAuditRecord[]>
}

export function createEgressAuditSink(): EgressAuditSink {
  return createTimestampedEventSink<EgressAuditRecord>({ max: 10000, defaultLimit: 5000, equalityFields: ['source'] })
}
