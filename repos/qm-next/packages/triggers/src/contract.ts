/**
 * M3 triggers contract (13.0, lane-opening freeze): the durable cron store
 * (memory + Postgres parity), the pure schedule math, the tick-lease
 * scheduler, fire idempotency, and the trigger→turn sink.
 *
 * A cron fire is keyed `cron:{id}:{scheduledAt}` and claimed atomically on
 * the stored row, so two schedulers — or two ticks at the same instant —
 * enqueue at most one turn per slot. Fires submit turns with
 * `origin: { kind: 'automation' }` and surface "cron"; every fire lands in
 * a fresh thread. When a terminal run carries a reply and the cron has a
 * destination, the reply is enqueued on the injected IM delivery queue;
 * with a DirectoryStore configured, delivery is gated on the owner's
 * visibility of the destination space.
 *
 * OUT of M3: consent/keychain/edit-notice flows, provenance UI, and the
 * pg-boss style job queue (tick scheduling suffices at this scale).
 * Changes go back through the main session, never inside a parallel lane.
 */
import type { Destination, PrincipalType, RunStore, ScopeId, SessionStore, TurnStatus } from '@qm/types'
import type { ResolutionService } from '@qm/types'

/** Surface stamped on cron-originated turns. */
export const CRON_SURFACE = 'cron'

/** Surface stamped on event-trigger-originated turns. */
export const TRIGGER_SURFACE = 'trigger'

/**
 * Fire schedule: a calendar schedule (`cron` + IANA `timezone`) or an
 * interval schedule (`everyMs` anchored at `firstFireAt`). The two forms
 * are mutually exclusive; `everyMs >= 24h` is refused as a clock-time
 * schedule in disguise (use `{cron, timezone}` instead).
 */
export interface CronSchedule {
  cron?: string
  timezone?: string
  everyMs?: number
  firstFireAt?: number
}

/** One durable cron record. */
export interface CronRecord {
  id: string
  /** Resolution scope fires run in. */
  scopeId: ScopeId
  /** Principal id the fire runs as. */
  ownerId: string
  ownerType: PrincipalType
  createdBy: string
  schedule: CronSchedule
  /** Task text every fire submits as a turn. */
  action?: string
  /** Relay text delivered directly without a turn. */
  message?: string
  destination?: Destination
  title?: string
  enabled: boolean
  archived: boolean
  createdAt: number
  nextFireAt?: number
  lastFiredAt?: number
  lastAttemptAt?: number
}

export interface CreateCronInput {
  scopeId: ScopeId
  ownerId: string
  ownerType?: PrincipalType
  createdBy: string
  schedule: CronSchedule
  action?: string
  message?: string
  destination?: Destination
  title?: string
}

export interface CronPatch {
  title?: string
  action?: string
  message?: string
  schedule?: CronSchedule
  enabled?: boolean
  archived?: boolean
  destination?: Destination | null
}

/** One recorded fire outcome; `fireKey` is the log's dedup key. */
export interface CronFireLogEntry {
  fireKey: string
  firedAt: number
  scheduledAt?: number
  status?: TurnStatus
  note?: string
  reply?: string
  runId?: string
  sessionId?: string
}

export interface CronFirePage {
  runs: CronFireLogEntry[]
  total: number
}

/** A cron whose scheduled slot has arrived. */
export type DueCron = CronRecord & { scheduledAt: number }

/**
 * Durable cron registry. `claimSlot` is the fire idempotency gate: it
 * succeeds exactly once per scheduled slot (a conditional advance of
 * `lastFiredAt`/`nextFireAt`), so concurrent tickers cannot double-fire.
 * Both memory and Postgres implementations satisfy these semantics
 * identically (parity tests).
 */
export interface CronStore {
  create(input: CreateCronInput): Promise<CronRecord>
  get(id: string): Promise<CronRecord | null>
  list(): Promise<CronRecord[]>
  update(id: string, patch: CronPatch): Promise<CronRecord | null>
  delete(id: string): Promise<void>
  setEnabled(id: string, enabled: boolean): Promise<void>
  /** Enabled, non-archived crons whose recovered slot is at or before `now`. */
  due(now: number): Promise<DueCron[]>
  /**
   * Atomically claim the scheduled slot: only succeeds when
   * `recoverNextFireAt(schedule, …) === scheduledAt`, advancing
   * `lastFiredAt = at` and `nextFireAt` past the slot. Returns false when
   * disabled/archived or already claimed.
   */
  claimSlot(id: string, scheduledAt: number, at: number): Promise<boolean>
  /** Restore a claimed slot (fire setup failed before the turn was enqueued). */
  unclaimSlot(id: string, scheduledAt: number, at: number, priorLastFiredAt?: number): Promise<void>
  markAttempted(id: string, at: number): Promise<void>
  /** Record one fire outcome; re-recording a fireKey merges into the first entry. */
  recordFire(id: string, entry: CronFireLogEntry): Promise<void>
  getFires(id: string, limit?: number): Promise<CronFirePage>
  close?(): Promise<void>
}

/**
 * Tick lease: only one `hold` per key runs at a time; concurrent holders
 * get null. Backs the scheduler tick so multiple scheduler instances
 * coordinate without double-firing (the durable gate is `claimSlot`).
 */
export interface LeaderLease {
  hold<T>(key: string, fn: () => Promise<T>): Promise<T | null>
  close?(): Promise<void>
}

/** Canonical fire key for a scheduled slot. */
export function cronFireKey(cronId: string, scheduledAt: number): string {
  return `cron:${cronId}:${scheduledAt}`
}

/** Canonical fire key for a manual run. */
export function manualFireKey(cronId: string, nonce: string): string {
  return `cron:${cronId}:manual:${nonce}`
}

export interface TriggerSubmission {
  runId: string
  /** True when an in-flight run with the same key already existed. */
  deduped: boolean
}

/** Input for one event-driven trigger fire. */
export interface TriggerFireInput {
  /** Idempotency key (usually the event id); one in-flight turn per key. */
  key: string
  text: string
  ownerId: string
  ownerType?: PrincipalType
  scopeId?: ScopeId
  destination?: Destination
  title?: string
}

/**
 * Event-driven trigger port: `fire` submits exactly one turn per key
 * (duplicate keys while the run is in flight dedupe) and routes the
 * terminal reply to `destination` when one is given.
 */
export interface TriggerSink {
  fire(input: TriggerFireInput): Promise<TriggerSubmission>
}

/** Deps shared by the cron scheduler and the trigger sink. */
export interface TriggerEngineDeps {
  sessions: SessionStore
  runs: RunStore
  resolution: ResolutionService
}
