/**
 * In-memory intake stores: tests and single-process dev. Durable
 * deployments swap in the Postgres implementation (`postgres-intake-store`)
 * without touching callers; both twins must satisfy the same contract
 * suite (plan §Phase 5 gate, ADR-0008).
 */
import type { InboundEvent } from '../inbound.ts'
import type {
  ImIntakeCursorStore,
  ImIntakeDeadLetterStore,
  ImIntakeInbox,
  IntakeAcceptResult,
  IntakeDeadLetter,
  IntakeRecord,
} from '../intake.ts'

/** Composite dedup key; the separator never appears in provider ids or
 * event ids in a way that could conflate distinct deliveries. */
function dedupKey(provider: string, eventId: string): string {
  return `${provider}\u0000${eventId}`
}

export type MemoryIntakeInbox = ImIntakeInbox & { readonly size: number }

export function createMemoryIntakeInbox(): MemoryIntakeInbox {
  const records = new Map<string, IntakeRecord>()
  const byKey = new Map<string, string>()
  let nextSeq = 0
  const inbox: MemoryIntakeInbox = {
    get size() {
      return records.size
    },
    async accept(event: InboundEvent, at?: number): Promise<IntakeAcceptResult> {
      const key = dedupKey(event.provider, event.eventId)
      const existingId = byKey.get(key)
      if (existingId) {
        const existing = records.get(existingId)
        if (existing) return { record: existing, duplicate: true }
      }
      nextSeq += 1
      const record: IntakeRecord = {
        id: crypto.randomUUID(),
        provider: event.provider,
        eventId: event.eventId,
        seq: nextSeq,
        event,
        acceptedAt: at ?? Date.now(),
      }
      records.set(record.id, record)
      byKey.set(key, record.id)
      return { record, duplicate: false }
    },
    async get(id) {
      return records.get(id) ?? null
    },
    async latestSeq() {
      return nextSeq
    },
    async listAfterSeq(after, limit) {
      const out = [...records.values()].filter((r) => r.seq > after).sort((a, b) => a.seq - b.seq)
      return limit !== undefined ? out.slice(0, limit) : out
    },
    async list(options) {
      const all = [...records.values()].sort((a, b) => b.seq - a.seq)
      return options?.limit !== undefined ? all.slice(0, options.limit) : all
    },
    async markTurn(id, turnId) {
      const record = records.get(id)
      if (!record || record.turnId !== undefined) return false
      record.turnId = turnId
      return true
    },
  }
  return inbox
}

export function createMemoryIntakeCursorStore(): ImIntakeCursorStore {
  const cursors = new Map<string, number>()
  return {
    async get(subscriber) {
      return cursors.has(subscriber) ? (cursors.get(subscriber) ?? null) : null
    },
    async advance(subscriber, seq) {
      const current = cursors.get(subscriber) ?? 0
      if (seq > current) cursors.set(subscriber, seq)
    },
  }
}

export function createMemoryIntakeDeadLetterStore(): ImIntakeDeadLetterStore {
  const letters = new Map<string, IntakeDeadLetter>()
  const bySubscriberIntake = new Map<string, string>()
  return {
    async record(letter) {
      const key = dedupKey(letter.subscriber, letter.intakeId)
      if (bySubscriberIntake.has(key)) return
      letters.set(letter.id, letter)
      bySubscriberIntake.set(key, letter.id)
    },
    async get(id) {
      return letters.get(id) ?? null
    },
    async list(options) {
      let all = [...letters.values()].sort((a, b) => b.failedAt - a.failedAt)
      if (options?.subscriber !== undefined) all = all.filter((l) => l.subscriber === options.subscriber)
      return options?.limit !== undefined ? all.slice(0, options.limit) : all
    },
    async markRedelivered(id, opts) {
      const letter = letters.get(id)
      if (!letter || letter.redeliveredAt !== undefined) return false
      letter.redeliveredAt = opts.at ?? Date.now()
      letter.redeliveredBy = opts.actor
      return true
    },
  }
}
