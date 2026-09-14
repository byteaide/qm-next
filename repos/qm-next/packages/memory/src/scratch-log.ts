/**
 * Scratch-tier storage for the scratch-promote strategy. qm keeps dated
 * log files under the workspace (`memory/log/YYYY-MM-DD.md`); qm-next has
 * no workspace store, so the tier is a port: per-scope dated note bodies
 * with normalize-based dedupe on append. Memory (Map) and Postgres
 * (DurableMap) implementations.
 */
import type { ScopeId } from '@qm/types'
import { createPgPool, createPostgresMap, type DurableMap, type PgPool } from '@qm/store'
import { bullets, dateStr, normalize } from './notebook.ts'

export interface ScratchLogStore {
  /** Log body for a date, '' when absent. */
  read(scopeId: ScopeId, date: string): Promise<string>
  /** Dedupes by normalized text, appends `- (date) fact` bullets, returns the added count. */
  appendFacts(scopeId: ScopeId, date: string, facts: string[], at: number): Promise<number>
  /** Dates that currently have a log, ascending. */
  listDates(scopeId: ScopeId): Promise<string[]>
  remove(scopeId: ScopeId, date: string): Promise<void>
  close?(): Promise<void>
}

/** JSON-encoded pair key: scope ids may contain any characters, and jsonb keys strip NULs. */
function logKey(scopeId: ScopeId, date: string): string {
  return JSON.stringify([scopeId, date])
}

function foldLog(existing: string, facts: string[], date: string): { body: string; added: number } {
  const clean = facts.map((f) => f.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const seen = new Set(bullets(existing).map(normalize))
  const added: string[] = []
  for (const f of clean) {
    const key = normalize(f)
    if (!key || seen.has(key)) continue
    seen.add(key)
    added.push(`- (${date}) ${f}`)
  }
  if (!added.length) return { body: existing, added: 0 }
  const body = existing.trim()
    ? `${existing.replace(/\s+$/, '')}\n${added.join('\n')}`
    : `# Scratch log ${date}\n\n${added.join('\n')}`
  return { body: `${body}\n`, added: added.length }
}

function keyScopeDate(key: string): [ScopeId, string] | null {
  try {
    const parsed = JSON.parse(key) as unknown
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return [parsed[0], parsed[1]]
    }
  } catch {}
  return null
}

export function createMemoryScratchLogStore(): ScratchLogStore {
  const logs = new Map<string, string>()
  return {
    read: async (scopeId, date) => logs.get(logKey(scopeId, date)) ?? '',
    appendFacts: async (scopeId, date, facts) => {
      const key = logKey(scopeId, date)
      const { body, added } = foldLog(logs.get(key) ?? '', facts, date)
      if (added) logs.set(key, body)
      return added
    },
    listDates: async (scopeId) => {
      const out: string[] = []
      for (const key of logs.keys()) {
        const pair = keyScopeDate(key)
        if (pair && pair[0] === scopeId) out.push(pair[1])
      }
      return out.sort()
    },
    remove: async (scopeId, date) => {
      logs.delete(logKey(scopeId, date))
    },
  }
}

interface ScratchLogRow {
  scopeId: ScopeId
  date: string
  body: string
}

const SCRATCH_LOGS_TABLE = 'memory_scratch_logs'

export function createPostgresScratchLogStore(connectionString: string): ScratchLogStore {
  const pool: PgPool = createPgPool(connectionString, [])
  const logs: DurableMap<ScratchLogRow> = createPostgresMap<ScratchLogRow>(pool, SCRATCH_LOGS_TABLE)
  return {
    read: async (scopeId, date) => (await logs.get(logKey(scopeId, date)))?.body ?? '',
    appendFacts: async (scopeId, date, facts) => {
      const key = logKey(scopeId, date)
      const existing = (await logs.get(key))?.body ?? ''
      const { body, added } = foldLog(existing, facts, date)
      if (added) await logs.put(key, { scopeId, date, body })
      return added
    },
    listDates: async (scopeId) => {
      const out: string[] = []
      for (const [key] of await logs.entries()) {
        const pair = keyScopeDate(key)
        if (pair && pair[0] === scopeId) out.push(pair[1])
      }
      return out.sort()
    },
    remove: async (scopeId, date) => {
      await logs.delete(logKey(scopeId, date))
    },
    close: () => pool.close(),
  }
}

export function scratchLogDate(at: number): string {
  return dateStr(at)
}
