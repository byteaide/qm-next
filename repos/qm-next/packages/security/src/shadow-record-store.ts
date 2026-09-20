/**
 * Phase 3 — Security Screen Shadow Record store.
 *
 * Linked ADR-0004: Shadow Mode records structured decision metadata
 * (stage, decision, reason, rule identity, redacted excerpt, actor/session
 * references) without secrets. Shadow Records are NOT Run Events; they
 * are a separate retention surface (Phase 3 §3.2 Shadow Mode tests).
 */
import { randomUUID } from 'node:crypto'
import type { Principal, ScopeId } from '@qm/types'

export type ShadowScreenMode = 'off' | 'shadow' | 'enforce'

export type ShadowScreenDecision = 'allow' | 'deny' | 'unavailable'

export interface ShadowRecord {
  id: string
  mode: ShadowScreenMode
  decision: ShadowScreenDecision
  reason?: string
  /** Stable rule identity; absent when no rule fired. */
  ruleId?: string
  /** Redacted excerpt; the adapter MUST redact before persisting. */
  redactedExcerpt?: string
  actor: Principal
  scopeId?: ScopeId
  sessionRef?: string
  runRef?: string
  /** Latency of the screener call, in milliseconds. */
  latencyMs: number
  ts: number
}

export interface ShadowRecordStore {
  create(record: ShadowRecord): Promise<void>
  get(id: string): Promise<ShadowRecord | undefined>
  list(opts?: { mode?: ShadowScreenMode; since?: number; limit?: number }): Promise<ShadowRecord[]>
  /** Default TTL window in milliseconds. Records older than this are eligible for eviction. */
  retentionMs: number
  evict(now: number): Promise<number>
}

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 7 days, per ADR-0004
const DEFAULT_CAPACITY = 5_000

export interface MemoryShadowRecordStoreOptions {
  retentionMs?: number
  capacity?: number
  now?: () => number
}

export function createMemoryShadowRecordStore(
  opts: MemoryShadowRecordStoreOptions = {},
): ShadowRecordStore {
  const records = new Map<string, ShadowRecord>()
  const now = opts.now ?? Date.now
  const capacity = opts.capacity ?? DEFAULT_CAPACITY
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS

  return {
    retentionMs,
    async create(record) {
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
    },
    async get(id) {
      return records.get(id)
    },
    async list({ mode, since, limit } = {}) {
      const all = Array.from(records.values()).sort((a, b) => b.ts - a.ts)
      const filtered = all.filter((r) => {
        if (mode !== undefined && r.mode !== mode) return false
        if (since !== undefined && r.ts < since) return false
        return true
      })
      return limit === undefined ? filtered : filtered.slice(0, limit)
    },
    async evict(nowValue) {
      const cutoff = nowValue - retentionMs
      let evicted = 0
      // Keep-newest guarantee: the reviewable sample store never evicts
      // its most recent record, so a retention sweep cannot empty it.
      let newestKey: string | undefined
      let newestTs = Number.NEGATIVE_INFINITY
      for (const [key, value] of records) {
        if (value.ts > newestTs) {
          newestTs = value.ts
          newestKey = key
        }
      }
      for (const [key, value] of records) {
        if (key === newestKey) continue
        if (value.ts < cutoff) {
          records.delete(key)
          evicted += 1
        }
      }
      return evicted
    },
  }
}

export function allocateShadowRecordId(): string {
  return randomUUID()
}