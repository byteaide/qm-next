/**
 * Target concurrency primitive ports — implements ADR-0001 (Run owns
 * terminal state via leases), ADR-0010 (Approval suspends the same Run
 * via Session Continuation Reservation), and the Phase 0 concurrency
 * primitive contract suite (§Phase 0 scope).
 *
 * Phase 0 freeze: ports compile. Concrete memory + Postgres
 * implementations live in `packages/concurrency`. Both implementations
 * MUST satisfy the same contract suite — the architecture gate enforces
 * bit-identical behavior given the same seed.
 *
 * Token discipline: every mutation on these ports carries the token the
 * caller received at acquisition. Calling `acquire` without supplying the
 * returned token on the next call is an architecture violation (§Phase 0
 * boundary checks). Acquire-without-token is rejected.
 */

/** Monotonic identifier for a Run; consumed by `SequenceAllocator`. */
export type RunId = string

/** Opaque token returned at lease acquisition. Never exposed to logs. */
export type LeaseToken = string

/** Outcome of a lease acquisition. */
export type LeaseAcquireResult =
  | { ok: true; token: LeaseToken; expiresAt: number }
  | { ok: false; reason: 'held_by_other'; currentExpiresAt?: number }
  | { ok: false; reason: 'not_found' }

/** Outcome of a renewal attempt. */
export type LeaseRenewResult =
  | { ok: true; expiresAt: number }
  | { ok: false; reason: 'expired' }
  | { ok: false; reason: 'token_mismatch' }
  | { ok: false; reason: 'not_found' }

/** Outcome of a release attempt. */
export type LeaseReleaseResult =
  | { ok: true }
  | { ok: false; reason: 'token_mismatch' }
  | { ok: false; reason: 'not_found' }

/**
 * Per-Run lease store. A Run may hold at most one active lease; the
 * token identifies the owning executor. Expired leases are reaped but a
 * newer lease acquired after observation must NOT be released by an
 * older reap (§1.3 of `docs/implementation-plan.md`).
 */
export interface LeaseStore {
  /** Acquire the lease for `runId`. Returns the token the caller must keep. */
  acquire(runId: RunId, ttlMs: number, now?: number): Promise<LeaseAcquireResult>
  /** Extend an existing lease using its token. */
  renew(runId: RunId, token: LeaseToken, ttlMs: number, now?: number): Promise<LeaseRenewResult>
  /** Release an existing lease using its token. */
  release(runId: RunId, token: LeaseToken, now?: number): Promise<LeaseReleaseResult>
  /**
   * Reap expired leases for `runId`. Returns `released` when a stale
   * lease was actually released; `newer_session` when a newer Session
   * has already acquired a lease that the reaper must NOT touch;
   * `not_expired` otherwise.
   */
  reapExpired(runId: RunId, now?: number): Promise<LeaseReapResult>
  /** Inspect the current lease for `runId` without mutating it. */
  inspect(runId: RunId): Promise<LeaseSnapshot | null>
}

export type LeaseReapResult =
  | { outcome: 'released' }
  | { outcome: 'newer_session'; currentExpiresAt: number }
  | { outcome: 'not_expired' }
  | { outcome: 'not_found' }

export interface LeaseSnapshot {
  token: LeaseToken
  expiresAt: number
  acquiredAt: number
  /** Session id that acquired the lease, used to detect newer-session overlap. */
  sessionId: string
}

/**
 * Monotonic `(run_id, seq)` allocator. Phase 0 boundary check: any
 * `(run_id, seq)` generated outside this port is an architecture
 * violation. Implementations MUST reject duplicate allocations.
 */
export interface SequenceAllocator {
  /** Allocate the next monotonic seq for `runId`. */
  next(runId: RunId): Promise<SequenceAllocation>
  /**
   * Read the current maximum allocated seq without allocating. Returns
   * `null` when the Run has no allocation history.
   */
  current(runId: RunId): Promise<number | null>
}

export type SequenceAllocation =
  | { ok: true; seq: number }
  | { ok: false; reason: 'conflict' }
  | { ok: false; reason: 'run_not_found' }

/**
 * Session Continuation Reservation. While a Run awaits Approval, the
 * Session is reserved so a new Run on the same Session cannot leave
 * `queued` (§2.3 of the plan). Reservation releases only after the
 * owning Run reaches durable terminal state — release-before-terminal
 * is a Phase 2 boundary check.
 */
export interface SessionReservationStore {
  /** Reserve a Session for a Run awaiting Approval. Idempotent on `runId`. */
  reserve(sessionId: string, runId: RunId, ttlMs: number, now?: number): Promise<ReservationResult>
  /** Inspect the reservation for a Session, if any. */
  inspect(sessionId: string): Promise<ReservationSnapshot | null>
  /**
   * Release the reservation. MUST reject when the owning Run has not
   * reached durable terminal state — callers are expected to verify
   * terminal state and pass `terminalStateConfirmed: true`.
   */
  release(sessionId: string, runId: RunId, opts?: { terminalStateConfirmed?: boolean; now?: number }): Promise<ReservationReleaseResult>
  /**
   * List Runs whose reservations overlap this Session. Used by Run
   * admission to block a new same-Session Run from leaving queued.
   */
  listActiveForSession(sessionId: string): Promise<readonly RunId[]>
}

export type ReservationResult =
  | { ok: true; acquired: true; expiresAt: number }
  | { ok: true; acquired: false; currentRunId: RunId; expiresAt: number }
  | { ok: false; reason: 'ttl_invalid' }

export type ReservationReleaseResult =
  | { ok: true }
  | { ok: false; reason: 'run_mismatch' }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'terminal_not_confirmed' }

export interface ReservationSnapshot {
  runId: RunId
  expiresAt: number
  acquiredAt: number
}

/**
 * Rollout flag port. Reading a rollout flag from anywhere other than
 * this port is an architecture violation (§Phase 0 boundary checks).
 * Each flag is registered at startup with a default value, an owner,
 * and a removal task reference so unowned flags cannot survive Phase 7.
 */
export interface RolloutFlag {
  /** Stable flag key (e.g. `target.run-observation`). */
  readonly key: string
  /** Read the current effective value. */
  read(): boolean
  /** Inspect the registered metadata. */
  meta(): RolloutFlagMeta
}

export interface RolloutFlagMeta {
  key: string
  /** Code owner (GitHub handle). */
  owner: string
  /** Default value at startup when no environment override is present. */
  default: boolean
  /** Environment variable name that overrides `default` (e.g. `QM_ROLLOUT_RUN_OBSERVATION`). */
  envOverride?: string
  /** Reference to the PR/issue that removes the flag. */
  removalTask: string
  /** When the flag was introduced (phase/ADR reference). */
  introducedIn: string
}

/**
 * Central registry of RolloutFlags. Construction of `RolloutFlag` outside
 * this port is forbidden — readers call `read()` and the registry is the
 * only authoritative source.
 */
export interface RolloutFlagRegistry {
  /** Register a flag; throws on duplicate key. */
  register(meta: RolloutFlagMeta): RolloutFlag
  /** Look up a registered flag by key. */
  get(key: string): RolloutFlag | null
  /** Enumerate registered flags (used by the architecture gate). */
  list(): readonly RolloutFlag[]
}

/**
 * Thrown by ports when the caller violates token discipline or any
 * Phase 0 boundary rule. Production surfaces map this to HTTP 500 with
 * no token disclosure.
 */
export class ArchitectureViolation extends Error {
  readonly rule: string
  constructor(rule: string, message: string) {
    super(message)
    this.name = 'ArchitectureViolation'
    this.rule = rule
  }
}
