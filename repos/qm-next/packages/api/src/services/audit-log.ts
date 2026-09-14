/**
 * Lane-A audit log: in-memory ring of qm AuditEvent rows. Feeds the admin
 * audit view and security flags; the Postgres audit sinks land with 12.0.
 */
export interface AuditEvent {
  at: number
  principalId?: string
  action: string
  resource: string
  scopeLabel?: string
  status?: string
  detail?: string
}

export interface AuditLog {
  record(event: AuditEvent): void
  tail(opts?: { limit?: number }): Promise<AuditEvent[]>
}

const MAX_EVENTS = 5000

export function createMemoryAuditLog(): AuditLog {
  const events: AuditEvent[] = []
  return {
    record(event) {
      events.push({ ...event })
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
    },
    async tail(opts) {
      const limit = opts?.limit ?? 200
      return events.slice(-limit).map((e) => ({ ...e }))
    },
  }
}
