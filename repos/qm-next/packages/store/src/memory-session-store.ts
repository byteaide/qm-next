/**
 * In-memory SessionStore for the frozen M1 contract subset: thread-keyed
 * sessions, TTL leases, seq-monotonic entry log, participant windows.
 * Translated from qm's memory-session-store (tape, LLM records, search and
 * admin listings are M3 extensions, not part of the frozen surface).
 */
import { randomUUID } from 'node:crypto'
import type {
  GetEntriesOptions,
  Lease,
  LeaseAttempt,
  LeaseHolder,
  NewEntry,
  ScopeId,
  Session,
  SessionEntry,
  SessionStore,
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
  const byThread = new Map<string, string>()
  const participants = new Map<string, Map<string, ParticipantWindow>>()
  const leases = new Map<string, HeldLease>()

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
