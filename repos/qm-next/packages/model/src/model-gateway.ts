/**
 * Model gateway: per-turn usage recording for audit and admin sinks
 * (memory ring buffer, same semantics as qm's gateway).
 */
import type { ModelGateway, ModelCallRecord } from '@qm/types'

const DEFAULT_MAX_RECORDS = 1_000

export function createModelGateway(opts: { maxRecords?: number } = {}): ModelGateway {
  const max = Math.max(1, opts.maxRecords ?? DEFAULT_MAX_RECORDS)
  const records: ModelCallRecord[] = []
  return {
    recordCall: (rec) => {
      records.push(rec)
      if (records.length > max) records.splice(0, records.length - max)
    },
    audit: () => [...records],
  }
}
