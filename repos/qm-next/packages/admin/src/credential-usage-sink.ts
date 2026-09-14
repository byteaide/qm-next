/**
 * Credential-usage sink (qm `src/admin/credential-usage-sink.ts`): brokered
 * credential calls, consumed by the admin egress view.
 */
import { createTimestampedEventSink } from './scoped-event-sink.ts'

export interface CredentialUsageSample {
  ts: number
  slug: string
  host: string
  status: string
  upstreamStatus?: number
  scopeLabel: string
  principalId: string
}

interface CredentialUsageQuery {
  scopeId?: string
  slug?: string
  since?: number
  limit?: number
}

export interface CredentialUsageSink {
  record(s: Omit<CredentialUsageSample, 'ts'>): void
  list(opts?: CredentialUsageQuery): Promise<CredentialUsageSample[]>
}

export function createCredentialUsageSink(): CredentialUsageSink {
  return createTimestampedEventSink<CredentialUsageSample>({
    max: 10000,
    defaultLimit: 5000,
    equalityFields: ['slug'],
  })
}
