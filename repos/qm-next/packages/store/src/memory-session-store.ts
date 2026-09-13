/**
 * In-memory SessionStore for the frozen M1 contract subset: thread-keyed
 * sessions, TTL leases, seq-monotonic entry log, participant windows, and
 * the P1 tape / LLM request record groups. Translated from qm's
 * memory-session-store (search and admin listings remain deferred).
 */
import { createHash, randomUUID } from 'node:crypto'
import type {
  GetEntriesOptions,
  GetTapeOptions,
  Lease,
  LeaseAttempt,
  LeaseHolder,
  LlmRequestRecord,
  ListLlmRequestsOptions,
  NewEntry,
  NewLlmRequest,
  NewTapeRecord,
  ScopeId,
  Session,
  SessionEntry,
  SessionStore,
  TapeRecord,
} from '@qm/types'

export interface MemoryStoreOptions {
  now?: () => number
  leaseTtlMs?: number
}

interface HeldLease {
  token: string
  expiresAt: number
  acquiredAt: number
  holder?: LeaseHolder
}

interface ParticipantWindow {
  validFrom: number
  validTo: number | null
  validFromSeq: number
  validToSeq: number | null
}

export function createMemorySessionStore(opts: MemoryStoreOptions = {}): SessionStore {
  const now = opts.now ?? (() => Date.now())
  const leaseTtlMs = opts.leaseTtlMs ?? 5 * 60_000
  const sessions = new Map<string, Session>()
  const entries = new Map<string, SessionEntry[]>()
  const tape = new Map<string, TapeRecord[]>()
  const llmRequests = new Map<string, LlmRequestRecord[]>()
  const byThread = new Map<string, string>()
  const participants = new Map<string, Map<string, ParticipantWindow>>()
  const leases = new Map<string, HeldLease>()

  const promptHashOf = (request: unknown): string | null =>
    request === undefined || request === null
      ? null
      : createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 16)

  return {
    async getOrCreateByThread(threadRef, type, scopeId, surface, channelName) {
      const existingId = byThread.get(threadRef)
      if (existingId) {
        const s = sessions.get(existingId)
        if (s) {
          if (channelName && s.channelName !== channelName) s.channelName = channelName
          if (!s.surface) s.surface = surface
          return s
        }
      }
      const session: Session = {
        id: randomUUID(),
        type,
        scopeId,
        threadRef,
        surface,
        createdAt: now(),
        ...(channelName ? { channelName } : {}),
      }
      sessions.set(session.id, session)
      entries.set(session.id, [])
      byThread.set(threadRef, session.id)
      return session
    },

    async getByThread(threadRef) {
      const id = byThread.get(threadRef)
      return (id && sessions.get(id)) || null
    },

    async get(id) {
      return sessions.get(id) ?? null
    },

    async updateTitle(sessionId, title) {
      const s = sessions.get(sessionId)
      if (s) s.title = title
    },

    async acquireLease(sessionId, holder): Promise<LeaseAttempt> {
      if (!sessions.has(sessionId)) return { lease: null }
      const held = leases.get(sessionId)
      if (held && now() < held.expiresAt) {
        return {
          lease: null,
          ...(held.holder ? { heldBy: held.holder } : {}),
          heldSince: held.acquiredAt,
          heldUntil: held.expiresAt,
        }
      }
      const token = randomUUID()
      leases.set(sessionId, {
        token,
        expiresAt: now() + leaseTtlMs,
        acquiredAt: now(),
        ...(holder ? { holder } : {}),
      })
      return { lease: { sessionId, token } }
    },

    async releaseLease(lease: Lease) {
      if (leases.get(lease.sessionId)?.token === lease.token) leases.delete(lease.sessionId)
    },

    async forceReleaseLease(sessionId) {
      leases.delete(sessionId)
    },

    async append(lease, entry: NewEntry): Promise<SessionEntry> {
      const held = leases.get(lease.sessionId)
      if (!held || held.token !== lease.token) {
        throw new Error('append without a valid session lease')
      }
      held.expiresAt = now() + leaseTtlMs
      const log = entries.get(lease.sessionId)
      if (!log) throw new Error(`unknown session: ${lease.sessionId}`)
      const seq = log.length
      const full: SessionEntry = {
        sessionId: lease.sessionId,
        seq,
        parentSeq: seq === 0 ? null : seq - 1,
        type: entry.type,
        payload: entry.payload,
        scopeLabel: entry.scopeLabel as ScopeId,
        createdAt: now(),
      }
      log.push(full)
      return full
    },

    async getEntries(sessionId, opts?: GetEntriesOptions) {
      const log = entries.get(sessionId) ?? []
      const since = opts?.sinceSeq ?? 0
      const filtered = log.filter((e) => e.seq >= since)
      return opts?.limit !== undefined ? filtered.slice(-opts.limit) : filtered
    },

    async appendTape(lease, rec: NewTapeRecord): Promise<TapeRecord> {
      const held = leases.get(lease.sessionId)
      if (!held || held.token !== lease.token) {
        throw new Error('appendTape without a valid session lease')
      }
      const rows = tape.get(lease.sessionId) ?? []
      tape.set(lease.sessionId, rows)
      const full: TapeRecord = {
        sessionId: lease.sessionId,
        seq: rows.length,
        createdAt: now(),
        kind: rec.kind,
        payload: rec.payload,
        scopeLabel: rec.scopeLabel as ScopeId,
        ...(rec.harness ? { harness: rec.harness } : {}),
        ...(rec.meta ? { meta: rec.meta } : {}),
        ...(rec.entrySeq !== undefined ? { entrySeq: rec.entrySeq } : {}),
        ...(rec.coversEntrySeq !== undefined ? { coversEntrySeq: rec.coversEntrySeq } : {}),
      }
      rows.push(full)
      return full
    },

    async getTape(sessionId, opts?: GetTapeOptions) {
      const rows = tape.get(sessionId) ?? []
      const since = opts?.sinceSeq ?? 0
      const filtered = rows.filter((r) => r.seq >= since)
      return opts?.limit !== undefined ? filtered.slice(-opts.limit) : filtered
    },

    async recordLlmRequest(sessionId, rec: NewLlmRequest, _signal?: AbortSignal): Promise<LlmRequestRecord> {
      const rows = llmRequests.get(sessionId) ?? []
      llmRequests.set(sessionId, rows)
      const full: LlmRequestRecord = {
        id: randomUUID(),
        sessionId,
        turnSeq: rec.turnSeq,
        step: rec.step,
        model: rec.model,
        scopeLabel: rec.scopeLabel as ScopeId,
        createdAt: now(),
        request: rec.promptEnvelope ?? null,
        promptHash: promptHashOf(rec.promptEnvelope),
        truncated: rec.truncated ?? false,
        ttftMs: rec.ttftMs ?? null,
        durationMs: rec.durationMs ?? null,
        stepGapMs: rec.stepGapMs ?? null,
        toolWallMs: rec.toolWallMs ?? null,
        gapPhases: rec.gapPhases ?? null,
        usage: rec.usage ?? null,
        transport: rec.transport ?? null,
      }
      rows.push(full)
      return full
    },

    async listLlmRequests(sessionId, opts?: ListLlmRequestsOptions) {
      let rows = llmRequests.get(sessionId) ?? []
      if (opts?.turnSeqs !== undefined) {
        const wanted = new Set(opts.turnSeqs)
        rows = rows.filter((r) => r.turnSeq !== null && wanted.has(r.turnSeq))
      }
      if (opts?.orphans) rows = rows.filter((r) => r.turnSeq === null)
      if (opts?.omitRequest) rows = rows.map((r) => ({ ...r, request: null }))
      return rows
    },

    async addParticipant(sessionId, principalId) {
      let windows = participants.get(sessionId)
      if (!windows) {
        windows = new Map()
        participants.set(sessionId, windows)
      }
      const existing = windows.get(principalId)
      if (!existing || existing.validTo !== null) {
        windows.set(principalId, {
          validFrom: now(),
          validTo: null,
          validFromSeq: entries.get(sessionId)?.length ?? 0,
          validToSeq: null,
        })
      }
    },

    async removeParticipant(sessionId, principalId) {
      const win = participants.get(sessionId)?.get(principalId)
      if (win && win.validTo === null) {
        win.validTo = now()
        win.validToSeq = entries.get(sessionId)?.length ?? 0
      }
    },

    async participantsOf(sessionId) {
      const windows = participants.get(sessionId)
      if (!windows) return []
      return [...windows.entries()].filter(([, w]) => w.validTo === null).map(([principalId]) => principalId)
    },
  }
}
