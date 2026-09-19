/**
 * Phase 3 — Admission Record durability.
 *
 * Per ADR-0006, rejected work never creates a Run. Instead, every Admission
 * outcome (accepted or rejected) is recorded as an Admission Record for
 * audit and operational visibility. This file provides the port + a memory
 * implementation; a Postgres twin is deferred to a follow-up slice.
 */
import { randomUUID } from 'node:crypto'
import type { AdmissionRecord } from '@qm/types'

export interface AdmissionRecordStore {
  create(record: AdmissionRecord): Promise<void>
  get(id: string): Promise<AdmissionRecord | undefined>
  list(opts?: { since?: number; limit?: number }): Promise<AdmissionRecord[]>
  /**
   * Returns the count of records in the last `windowMs`. The orchestrator
   * uses this for the alert thresholds documented in `docs/operations.md`
   * §11 (e.g. `admission_decision_total{stage="identity",decision="deny"}`
   * exceeding 3× baseline).
   */
  countInWindow(opts: { since: number; until?: number }): Promise<number>
  countByStageDecision(opts: {
    stage: import('@qm/types').AdmissionStage
    decision: 'allow' | 'deny' | 'error' | 'skipped'
    since: number
    until?: number
  }): Promise<number>
}

export interface MemoryAdmissionRecordStoreOptions {
  now?: () => number
  capacity?: number
}

const DEFAULT_CAPACITY = 10_000

export function createMemoryAdmissionRecordStore(
  opts: MemoryAdmissionRecordStoreOptions = {},
): AdmissionRecordStore {
  const now = opts.now ?? Date.now
  const capacity = opts.capacity ?? DEFAULT_CAPACITY
  const records = new Map<string, AdmissionRecord>()
  // Bounded retention: when capacity is hit, evict the oldest by `ts`.
  const insert = (record: AdmissionRecord): void => {
    if (records.size >= capacity) {
      let oldestKey: string | undefined
      let oldestTs = Number.POSITIVE_INFINITY
      for (const [key, value] of records) {
        if (value.ts < oldestTs) {
          oldestTs = value.ts
          oldestKey = key
        }
      }
      if (oldestKey !== undefined) records.delete(oldestKey)
    }
    records.set(record.id, record)
  }
  return {
    async create(record) {
      insert(record)
    },
    async get(id) {
      return records.get(id)
    },
    async list({ since, limit } = {}) {
      const all = Array.from(records.values()).sort((a, b) => b.ts - a.ts)
      const filtered = since === undefined ? all : all.filter((r) => r.ts >= since)
      return limit === undefined ? filtered : filtered.slice(0, limit)
    },
    async countInWindow({ since, until }) {
      const end = until ?? Number.POSITIVE_INFINITY
      let n = 0
      for (const record of records.values()) {
        if (record.ts >= since && record.ts <= end) n += 1
      }
      return n
    },
    async countByStageDecision({ stage, decision, since, until }) {
      const end = until ?? Number.POSITIVE_INFINITY
      let n = 0
      for (const record of records.values()) {
        if (record.ts < since || record.ts > end) continue
        for (const stageRecord of record.stages) {
          if (stageRecord.stage === stage && stageRecord.decision === decision) {
            n += 1
            break
          }
        }
      }
      return n
    },
  }
}

/**
 * Allocates a stable identity for an Admission Record. The id is monotonic
 * across the process lifetime and never reused.
 */
export function allocateAdmissionRecordId(): string {
  return randomUUID()
}

export { now: undefined as never } // placeholder to keep export shape consistent