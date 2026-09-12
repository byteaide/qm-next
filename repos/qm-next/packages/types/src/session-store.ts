/**
 * Session persistence contract (M1 core subset of qm's SessionStore).
 *
 * Lease semantics: a turn acquires the session lease before appending, so
 * concurrent runs over one thread serialize. Extension method groups (tape,
 * LLM request records, participant views, search, admin listings) are
 * deliberately deferred; additions must be additive.
 */
import type { ScopeId } from './identity.ts'
import type { GetEntriesOptions, NewEntry, Session, SessionEntry, SessionType } from './session.ts'

export type LeaseHolder = 'turn' | 'compaction' | 'fork' | 'backfill'

export interface Lease {
  sessionId: string
  token: string
}

export interface LeaseAttempt {
  lease: Lease | null
  heldBy?: LeaseHolder
  heldSince?: number
  heldUntil?: number
}

export interface SessionStore {
  getOrCreateByThread(
    threadRef: string,
    type: SessionType,
    scopeId: ScopeId,
    surface: string,
    channelName?: string,
  ): Promise<Session>
  getByThread(threadRef: string): Promise<Session | null>
  get(sessionId: string): Promise<Session | null>

  updateTitle(sessionId: string, title: string): Promise<void>

  acquireLease(sessionId: string, holder?: LeaseHolder): Promise<LeaseAttempt>
  releaseLease(lease: Lease): Promise<void>
  forceReleaseLease(sessionId: string): Promise<void>

  append(lease: Lease, entry: NewEntry): Promise<SessionEntry>
  getEntries(sessionId: string, opts?: GetEntriesOptions): Promise<SessionEntry[]>

  addParticipant(sessionId: string, principalId: string): Promise<void>
  removeParticipant(sessionId: string, principalId: string): Promise<void>
  participantsOf(sessionId: string): Promise<string[]>
}
