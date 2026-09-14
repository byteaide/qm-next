/**
 * In-memory CronStore: dev/test twin of the Postgres implementation.
 * `claimSlot` is the read-transform-write of the pg conditional UPDATE;
 * both must claim a slot exactly once (parity tests).
 */
import type {
  CronFireLogEntry,
  CronPatch,
  CronRecord,
  CronStore,
  CreateCronInput,
  DueCron,
} from './contract.ts'
import { advanceNextFireAt, isCalendarSchedule, normalizeSchedule, recoverNextFireAt } from './schedule.ts'
import { hashId } from './util.ts'

function normalizeTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim().replace(/\s+/g, ' ')
  if (!trimmed) return undefined
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}...` : trimmed
}

export function createMemoryCronStore(): CronStore {
  const crons = new Map<string, CronRecord>()
  const fires = new Map<string, Map<string, CronFireLogEntry>>()

  function transform(id: string, fn: (cron: CronRecord) => CronRecord | null): CronRecord | null {
    const current = crons.get(id)
    if (!current) return null
    const next = fn(current)
    if (next) crons.set(id, next)
    else crons.delete(id)
    return next
  }

  return {
    async create(input: CreateCronInput): Promise<CronRecord> {
      const now = Date.now()
      const title = normalizeTitle(input.title)
      const { schedule, nextFireAt } = normalizeSchedule(input.schedule, now)
      const id = hashId([
        input.scopeId,
        input.ownerId,
        input.ownerType ?? 'internal',
        input.schedule,
        input.action,
        input.message,
        input.destination,
        title,
      ])
      const existing = crons.get(id)
      if (existing) return existing
      const record: CronRecord = {
        id,
        scopeId: input.scopeId,
        ownerId: input.ownerId,
        ownerType: input.ownerType ?? 'internal',
        createdBy: input.createdBy,
        schedule,
        ...(nextFireAt !== undefined ? { nextFireAt } : {}),
        ...(title ? { title } : {}),
        ...(input.action !== undefined ? { action: input.action } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.destination ? { destination: input.destination } : {}),
        ...(input.recipientConsent ? { recipientConsent: input.recipientConsent } : {}),
        enabled: true,
        archived: false,
        createdAt: now,
      }
      crons.set(id, record)
      return record
    },
    async get(id) {
      return crons.get(id) ?? null
    },
    async list() {
      return [...crons.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    },
    async update(id, patch: CronPatch) {
      return transform(id, (cron) => {
        const next: CronRecord = { ...cron }
        if (patch.title !== undefined) {
          const title = normalizeTitle(patch.title)
          if (title) next.title = title
          else delete next.title
        }
        if (patch.action !== undefined) next.action = patch.action
        if (patch.message !== undefined) next.message = patch.message
        if (patch.schedule !== undefined) {
          const normalized = normalizeSchedule(patch.schedule, Date.now())
          next.schedule = normalized.schedule
          if (normalized.nextFireAt !== undefined) next.nextFireAt = normalized.nextFireAt
          else delete next.nextFireAt
        }
        if (patch.enabled !== undefined) next.enabled = patch.enabled
        if (patch.archived !== undefined) next.archived = patch.archived
        if (patch.destination !== undefined) {
          if (patch.destination) next.destination = patch.destination
          else delete next.destination
        }
        if (patch.archived === true) next.enabled = false
        return next
      })
    },
    async delete(id) {
      crons.delete(id)
      fires.delete(id)
    },
    async setRecipientConsent(id, consent) {
      return transform(id, (cron) => {
        const { recipientConsent: _dropped, ...rest } = cron
        return { ...rest, ...(consent ? { recipientConsent: consent } : {}) }
      })
    },
    async setEnabled(id, enabled) {
      transform(id, (cron) => ({ ...cron, enabled, ...(enabled ? { archived: false } : {}) }))
    },
    async due(now) {
      const due: DueCron[] = []
      for (const cron of crons.values()) {
        if (cron.archived || !cron.enabled) continue
        const scheduledAt = recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt)
        if (scheduledAt !== undefined && now >= scheduledAt) due.push({ ...cron, nextFireAt: scheduledAt, scheduledAt })
      }
      return due.sort((a, b) => a.scheduledAt - b.scheduledAt || a.id.localeCompare(b.id))
    },
    async claimSlot(id, scheduledAt, at) {
      let claimed = false
      transform(id, (cron) => {
        claimed = false
        if (cron.archived || !cron.enabled) return cron
        if (recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt) !== scheduledAt) return cron
        claimed = true
        const advanceFrom = isCalendarSchedule(cron.schedule) ? scheduledAt : at
        const next = advanceNextFireAt(cron.schedule, advanceFrom)
        const { nextFireAt: _dropped, ...rest } = cron
        return { ...rest, lastFiredAt: at, ...(next !== undefined ? { nextFireAt: next } : {}) }
      })
      return claimed
    },
    async unclaimSlot(id, scheduledAt, at, priorLastFiredAt) {
      transform(id, (cron) => {
        if (cron.lastFiredAt !== at) return cron
        const { lastFiredAt: _dropped, ...rest } = cron
        return {
          ...rest,
          ...(priorLastFiredAt !== undefined ? { lastFiredAt: priorLastFiredAt } : {}),
          nextFireAt: scheduledAt,
        }
      })
    },
    async markAttempted(id, at) {
      transform(id, (cron) => ({ ...cron, lastAttemptAt: at }))
    },
    async recordFire(id, entry) {
      let entries = fires.get(id)
      if (!entries) {
        entries = new Map()
        fires.set(id, entries)
      }
      entries.set(entry.fireKey, { ...entries.get(entry.fireKey), ...entry })
    },
    async getFires(id, limit) {
      const all = [...(fires.get(id)?.values() ?? [])].sort((a, b) => a.firedAt - b.firedAt || a.fireKey.localeCompare(b.fireKey))
      return { runs: limit === undefined ? all : all.slice(-limit), total: all.length }
    },
    async close() {},
  }
}
