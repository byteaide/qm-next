/**
 * Intake fan-out (plan §Phase 5, ADR-0008, ADR-0015): accepted intake is
 * dispatched to every explicit Intake Subscriber, each holding an
 * independent durable Subscriber Cursor. A failing subscriber retries the
 * same record with exponential backoff — it never blocks the other
 * subscribers — and dead-letters after exhaustion without losing the
 * failed record. Dead letters carry an admin-only `redelivery_url` and a
 * secret-free `last_error`; replay is admin-only, audited, and never
 * automatic.
 */
import type { InboundEvent } from '../inbound.ts'
import type {
  ImIntakeCursorStore,
  ImIntakeDeadLetterStore,
  ImIntakeInbox,
  IntakeDeadLetter,
  IntakeReplayAuditEntry,
  IntakeRecord,
  IntakeSubscriber,
  IntakeSubscriberContext,
} from '../intake.ts'
import { redeliveryUrlFor } from '../intake.ts'
import type { ImLogger } from '../provider.ts'
import {
  bumpImIntakeDedup,
  bumpImSubscriberDeadLetter,
  bumpImSubscriberRetry,
  redactSecrets,
  setImSubscriberLag,
  type RunMetricsRegistry,
} from '@qm/runs'

const DEFAULT_TICK_MS = 50
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_BACKOFF_MS = 250
const DEFAULT_MAX_PER_TICK = 100

export interface IntakeFanoutOptions {
  inbox: ImIntakeInbox
  cursors: ImIntakeCursorStore
  deadLetters: ImIntakeDeadLetterStore
  subscribers: readonly IntakeSubscriber[]
  /** In-process counter registry (plan §5.5 metric families). */
  metrics?: RunMetricsRegistry
  logger?: ImLogger
  /** Poll cadence in ms (drain passes also run on ingest wakeup). */
  tickMs?: number
  /** Give up on a record for one subscriber after this many attempts. */
  maxAttempts?: number
  /** Base delay for exponential backoff (`backoffMs * 2^(attempt-1)`). */
  backoffMs?: number
  /** Records one subscriber may process per drain pass. */
  maxPerTick?: number
  /** Injectable clock (fake clock in tests). Defaults to `Date.now`. */
  now?: () => number
  /** Admin redelivery URL template; `{id}` is replaced with the letter id. */
  redeliveryUrlTemplate?: string
  /** Audit hook for admin replays (never called for automatic delivery). */
  audit?: (entry: IntakeReplayAuditEntry) => void
}

export interface IntakeIngestResult {
  record: IntakeRecord
  duplicate: boolean
}

export type IntakeReplayResult =
  | { ok: true; record: IntakeRecord }
  | { ok: false; reason: 'not_found' | 'already_redelivered' | 'record_missing' | 'subscriber_missing' | 'replay_failed'; error?: string }

export interface IntakeFanout {
  ingest(event: InboundEvent, at?: number): Promise<IntakeIngestResult>
  ingestAll(events: readonly InboundEvent[], at?: number): Promise<IntakeIngestResult[]>
  start(): Promise<void>
  stop(): Promise<void>
  /** One dispatch pass for every subscriber; resolves when all settle. */
  drain(): Promise<void>
  /** Events a subscriber still owes (latest accepted seq minus cursor). */
  lag(subscriber: string): Promise<number>
  listDeadLetters(options?: { subscriber?: string; limit?: number }): Promise<IntakeDeadLetter[]>
  inspectDeadLetter(id: string): Promise<IntakeDeadLetter | null>
  /**
   * Admin-only replay of one dead letter. Audited via `options.audit`,
   * never scheduled automatically, and each letter replays once — a
   * second call returns `already_redelivered`.
   */
  replayDeadLetter(id: string, opts: { actor: string; at?: number }): Promise<IntakeReplayResult>
}

function errorToMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error), 'log')
}

export function createIntakeFanout(options: IntakeFanoutOptions): IntakeFanout {
  const logger: ImLogger = options.logger ?? console
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS
  const maxPerTick = options.maxPerTick ?? DEFAULT_MAX_PER_TICK
  const now = options.now ?? Date.now
  const ctx: IntakeSubscriberContext = { inbox: options.inbox }

  const attemptsBySubscriber = new Map<string, number>()
  const nextAttemptAt = new Map<string, number>()
  const inFlight = new Set<Promise<void>>()
  let running = false
  let draining = false
  let timer: NodeJS.Timeout | undefined

  function setLag(subscriber: string, value: number): void {
    setImSubscriberLag(options.metrics, subscriber, value)
  }

  async function tickSubscriber(subscriber: IntakeSubscriber): Promise<void> {
    let cursor = (await options.cursors.get(subscriber.name)) ?? 0
    const latest = await options.inbox.latestSeq()
    setLag(subscriber.name, Math.max(0, latest - cursor))
    if (now() < (nextAttemptAt.get(subscriber.name) ?? 0)) return
    let processed = 0
    while (processed < maxPerTick) {
      const next = await options.inbox.listAfterSeq(cursor, 1)
      const record: IntakeRecord | undefined = next[0]
      if (!record) return
      try {
        await subscriber.handle(record, ctx)
        bumpImSubscriberRetry(options.metrics, subscriber.name, 'ok')
        attemptsBySubscriber.set(subscriber.name, 0)
        nextAttemptAt.set(subscriber.name, 0)
        await options.cursors.advance(subscriber.name, record.seq)
        cursor = record.seq
      } catch (error: unknown) {
        const attempts = (attemptsBySubscriber.get(subscriber.name) ?? 0) + 1
        attemptsBySubscriber.set(subscriber.name, attempts)
        bumpImSubscriberRetry(options.metrics, subscriber.name, 'fail')
        const message = errorToMessage(error)
        if (attempts >= maxAttempts) {
          const letter: IntakeDeadLetter = {
            id: crypto.randomUUID(),
            subscriber: subscriber.name,
            intakeId: record.id,
            provider: record.provider,
            eventId: record.eventId,
            seq: record.seq,
            attempts,
            lastError: message,
            failedAt: now(),
            redeliveryUrl: redeliveryUrlFor(options.redeliveryUrlTemplate, record.id),
          }
          await options.deadLetters.record(letter)
          bumpImSubscriberDeadLetter(options.metrics, subscriber.name)
          logger.warn(
            `im: intake ${record.eventId} dead-lettered for subscriber "${subscriber.name}" after ${attempts} attempts: ${message}`,
          )
          await options.cursors.advance(subscriber.name, record.seq)
          cursor = record.seq
          attemptsBySubscriber.set(subscriber.name, 0)
          nextAttemptAt.set(subscriber.name, 0)
        } else {
          const retryInMs = backoffMs * 2 ** (attempts - 1)
          nextAttemptAt.set(subscriber.name, now() + retryInMs)
          logger.warn(
            `im: intake ${record.eventId} failed for subscriber "${subscriber.name}" (attempt ${attempts}), retry in ${retryInMs}ms`,
          )
          return
        }
      }
      processed += 1
    }
  }

  async function tick(): Promise<void> {
    if (draining) return
    draining = true
    const tracked: Promise<void> = Promise.all(options.subscribers.map((s) => tickSubscriber(s)))
      .then(() => undefined)
      .catch((error: unknown) => logger.error('im: intake fan-out tick failed:', error))
      .finally(() => {
        draining = false
        inFlight.delete(tracked)
      })
    inFlight.add(tracked)
    return tracked
  }

  async function ingestOne(event: InboundEvent, at?: number): Promise<IntakeIngestResult> {
    const result = await options.inbox.accept(event, at)
    bumpImIntakeDedup(options.metrics, result.duplicate ? 'duplicate' : 'new')
    if (!result.duplicate && running) void tick()
    return result
  }

  const fanout: IntakeFanout = {
    ingest: ingestOne,
    async ingestAll(events, at) {
      const results: IntakeIngestResult[] = []
      for (const event of events) results.push(await ingestOne(event, at))
      return results
    },
    async start() {
      if (running) return
      running = true
      timer = setInterval(() => {
        void tick()
      }, tickMs)
      timer.unref?.()
      await tick()
    },
    async stop() {
      if (!running) return
      running = false
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight])
      }
    },
    drain: tick,
    async lag(subscriber) {
      const cursor = (await options.cursors.get(subscriber)) ?? 0
      const latest = await options.inbox.latestSeq()
      return Math.max(0, latest - cursor)
    },
    async listDeadLetters(listerOptions) {
      return options.deadLetters.list(listerOptions)
    },
    async inspectDeadLetter(id) {
      return options.deadLetters.get(id)
    },
    async replayDeadLetter(id, opts): Promise<IntakeReplayResult> {
      const letter = await options.deadLetters.get(id)
      if (!letter) return { ok: false, reason: 'not_found' }
      if (letter.redeliveredAt !== undefined) return { ok: false, reason: 'already_redelivered' }
      const record = await options.inbox.get(letter.intakeId)
      if (!record) return { ok: false, reason: 'record_missing' }
      const subscriber = options.subscribers.find((s) => s.name === letter.subscriber)
      if (!subscriber) return { ok: false, reason: 'subscriber_missing' }
      const at = opts.at ?? now()
      try {
        await subscriber.handle(record, ctx)
      } catch (error: unknown) {
        const message = errorToMessage(error)
        options.audit?.({ deadLetterId: id, subscriber: letter.subscriber, intakeId: letter.intakeId, actor: opts.actor, at, outcome: 'failed', ...(message ? { error: message } : {}) })
        return { ok: false, reason: 'replay_failed', error: message }
      }
      await options.deadLetters.markRedelivered(id, { actor: opts.actor, at })
      options.audit?.({ deadLetterId: id, subscriber: letter.subscriber, intakeId: letter.intakeId, actor: opts.actor, at, outcome: 'ok' })
      return { ok: true, record }
    },
  }
  return fanout
}

/**
 * Explicit subscriber factories for the documented fan-out targets
 * (plan slice 4): mirror and audit are thin durable-positioned consumers
 * over an injected sink; the bridge subscriber lives in `@qm/im-bridge`
 * (it owns Turn creation and must not be imported by core).
 */
export function createSinkIntakeSubscriber(name: string, sink: (record: IntakeRecord) => Promise<void>): IntakeSubscriber {
  return {
    name,
    async handle(record) {
      await sink(record)
    },
  }
}

export function createMirrorSubscriber(sink: (record: IntakeRecord) => Promise<void>): IntakeSubscriber {
  return createSinkIntakeSubscriber('mirror', sink)
}

export function createAuditSubscriber(sink: (record: IntakeRecord) => Promise<void>): IntakeSubscriber {
  return createSinkIntakeSubscriber('audit', sink)
}
