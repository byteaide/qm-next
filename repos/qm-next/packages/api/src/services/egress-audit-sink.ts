/**
 * Lane-A egress audit sink: proxy egress records in memory (qm
 * egress-audit-sink contract). Feeds POST /v1/egress-audit and the admin
 * egress view; a Postgres swap lands behind the same interface.
 */
export interface EgressAuditRecord {
  ts: number
  source: string
  host: string
  allowed: boolean
  verdict: string
  scopeLabel: string
  via?: string
  peerIp?: string
  principalId?: string
  port?: number
}

export interface EgressAuditSink {
  record(rec: Omit<EgressAuditRecord, 'ts'>): void
  list(opts?: { limit?: number; scopeId?: string }): Promise<EgressAuditRecord[]>
}

export function createMemoryEgressAuditSink(): EgressAuditSink {
  const records: EgressAuditRecord[] = []
  return {
    record(rec) {
      records.push({ ...rec, ts: Date.now() })
    },
    async list(opts) {
      const scoped = opts?.scopeId ? records.filter((r) => r.scopeLabel === opts.scopeId) : records
      const limit = opts?.limit ?? 1000
      return scoped.slice(-limit).map((r) => ({ ...r }))
    },
  }
}
