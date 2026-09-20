/**
 * Phase 5 — durable IM intake (plan §Phase 5, ADR-0008, ADR-0015).
 *
 * The Intake Inbox is the durable authority for recognizing repeated
 * external deliveries. Records are keyed by an Intake Key — the provider
 * plus the provider delivery identity (`eventId` on the inbound envelope).
 * Accepted intake fans out to explicit Intake Subscribers (`bridge`,
 * `mirror`, `audit`), each holding an independent durable Subscriber
 * Cursor. Delivery is at-least-once: subscribers deduplicate idempotently,
 * and a failed subscriber retries with backoff, then dead-letters without
 * erasing the intake or blocking the other subscribers.
 *
 * Linked ADRs: ADR-0008 (intake is durable fan-out), ADR-0015
 * (independent subscriber cursors).
 */
import type { InboundEvent } from './inbound.ts'

/**
 * The durable identity of one external delivery: provider plus the
 * provider delivery identity. The composite — never a flattened string —
 * is the dedup key, so distinct providers (or distinct provider events
 * whose ids contain separator characters) are never conflated.
 */
export interface IntakeKey {
  provider: string
  eventId: string
}

/** One accepted external delivery, durably recorded in the inbox. */
export interface IntakeRecord {
  id: string
  provider: string
  /** Provider delivery identity (`InboundEnvelope.eventId`). */
  eventId: string
  /** Monotonic inbox position; subscribers order on it. Starts at 1. */
  seq: number
  /** The full inbound event; subscribers receive it verbatim. */
  event: InboundEvent
  acceptedAt: number
  /**
   * Run id of the Turn created from this record (bridge subscriber).
   * First writer wins: a redelivery that observes it set skips Turn
   * creation so the same intake maps to the same Turn identity.
   */
  turnId?: string
}

/** Canonical display form for admin surfaces (not the dedup key). */
export function formatIntakeKey(key: IntakeKey): string {
  return `${key.provider}:${key.eventId}`
}

export interface IntakeAcceptResult {
  record: IntakeRecord
  /** True when the Intake Key was already accepted (no new record). */
  duplicate: boolean
}

/**
 * Durable Intake Inbox. Implementations: memory (tests/dev) and Postgres
 * (production) must satisfy the same contract suite.
 */
export interface ImIntakeInbox {
  /**
   * Record one external delivery. Idempotent on the Intake Key: the
   * first accept returns `duplicate: false`, every later accept of the
   * same key returns the original record with `duplicate: true`.
   */
  accept(event: InboundEvent, at?: number): Promise<IntakeAcceptResult>
  get(id: string): Promise<IntakeRecord | null>
  /** Highest allocated seq (0 when the inbox is empty). */
  latestSeq(): Promise<number>
  /** Records with `seq > after`, oldest first. */
  listAfterSeq(after: number, limit?: number): Promise<IntakeRecord[]>
  /**
   * Most recent records, newest first (admin observability). Optional:
   * memory implements it; durable backends may defer until the admin
   * surface needs it.
   */
  list?(options?: { limit?: number }): Promise<IntakeRecord[]>
  /**
   * Attach the Turn identity to a record. First writer wins: returns
   * `true` when this call set it, `false` when a Turn id was already
   * recorded (or the record is gone).
   */
  markTurn(id: string, turnId: string): Promise<boolean>
}

/**
 * Subscriber Cursor: a durable position held independently by one
 * Intake Subscriber (ADR-0015). `advance` is monotonic — a stale write
 * never moves a cursor backwards.
 */
export interface ImIntakeCursorStore {
  /** Current cursor; `null` before the subscriber's first advance. */
  get(subscriber: string): Promise<number | null>
  /** Move the cursor forward to `seq`; backwards writes are ignored. */
  advance(subscriber: string, seq: number, at?: number): Promise<void>
}

/** One exhausted subscriber delivery, kept observable (ADR-0015). */
export interface IntakeDeadLetter {
  id: string
  subscriber: string
  intakeId: string
  provider: string
  eventId: string
  seq: number
  attempts: number
  /** Final error, secret-free (redacted at record time). */
  lastError: string
  failedAt: number
  /**
   * Admin-only operator URL for redelivery. Never exposed to end users;
   * replay itself is admin-only and audited.
   */
  redeliveryUrl: string
  redeliveredAt?: number
  /** Actor that performed the admin replay. */
  redeliveredBy?: string
}

export interface IntakeReplayAuditEntry {
  deadLetterId: string
  subscriber: string
  intakeId: string
  actor: string
  at: number
  outcome: 'ok' | 'failed'
  /** Secret-free failure message when `outcome` is `'failed'`. */
  error?: string
}

/**
 * Durable dead-letter store. `record` is idempotent per
 * (subscriber, intakeId); the store never auto-replays.
 */
export interface ImIntakeDeadLetterStore {
  record(letter: IntakeDeadLetter): Promise<void>
  get(id: string): Promise<IntakeDeadLetter | null>
  list(options?: { subscriber?: string; limit?: number }): Promise<IntakeDeadLetter[]>
  /** Mark an admin replay done. First writer wins. */
  markRedelivered(id: string, opts: { actor: string; at?: number }): Promise<boolean>
}

/** What a subscriber can touch while handling one record. */
export interface IntakeSubscriberContext {
  inbox: ImIntakeInbox
}

/**
 * An explicit durable consumer of accepted intake (bridge, mirror,
 * audit). `handle` must be idempotent: delivery is at-least-once and a
 * redelivery after a crash re-runs it for the same record.
 */
export interface IntakeSubscriber {
  name: string
  handle(record: IntakeRecord, ctx: IntakeSubscriberContext): Promise<void>
}

/** Default admin redelivery URL template (operator tool, admin-only). */
export const DEFAULT_REDELIVERY_URL_TEMPLATE = '/admin/im/intake/dead-letters/{id}/replay'

export function redeliveryUrlFor(template: string | undefined, id: string): string {
  return (template ?? DEFAULT_REDELIVERY_URL_TEMPLATE).replace('{id}', encodeURIComponent(id))
}
