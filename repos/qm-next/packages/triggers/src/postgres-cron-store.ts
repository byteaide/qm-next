/**
 * Postgres CronStore: restart-safe twin of the memory implementation.
 * `claimSlot` is one conditional UPDATE guarding every recoverable-slot
 * input (`enabled`, `archived`, `next_fire_at`, `last_fired_at`), so two
 * concurrent tickers can never both claim a slot — the loser's WHERE
 * fails after the winner advanced `next_fire_at`. Fire outcomes persist
 * in `cron_fire_log` keyed `(cron_id, fire_key)` with first-entry merge.
 */
import type { CronFireLogEntry, CronPatch, CronRecord, CronStore, CreateCronInput, DueCron } from './contract.ts'
import type { Destination, PrincipalType, RecipientConsent, ScopeId } from '@qm/types'
import { createPgPool, type PgPool } from '@qm/store'
import { advanceNextFireAt, isCalendarSchedule, normalizeSchedule, recoverNextFireAt } from './schedule.ts'
import { hashId } from './util.ts'

export const CRONS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS crons(
      id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_type TEXT NOT NULL,
      created_by TEXT NOT NULL, title TEXT, action TEXT, message TEXT,
      schedule JSONB NOT NULL, destination TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE, archived BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL, next_fire_at BIGINT, last_fired_at BIGINT, last_attempt_at BIGINT,
      recipient_consent JSONB,
      seq BIGSERIAL)`,
  // Upgrades for stores created before recipient consent (14.0).
  `ALTER TABLE crons ADD COLUMN IF NOT EXISTS recipient_consent JSONB`,
  `CREATE INDEX IF NOT EXISTS idx_crons_enabled ON crons(enabled, archived)`,
  `CREATE TABLE IF NOT EXISTS cron_fire_log(
      cron_id TEXT NOT NULL, fire_key TEXT NOT NULL, fired_at BIGINT NOT NULL, json JSONB NOT NULL,
      PRIMARY KEY (cron_id, fire_key),
      FOREIGN KEY (cron_id) REFERENCES crons(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS idx_cron_fire_log_cron ON cron_fire_log (cron_id, fired_at, fire_key)`,
]

function row(r: Record<string, unknown>): CronRecord {
  const consent = r.recipient_consent
  return {
    id: r.id as string,
    scopeId: r.scope_id as ScopeId,
    ownerId: r.owner_id as string,
    ownerType: r.owner_type as PrincipalType,
    createdBy: r.created_by as string,
    schedule: r.schedule as CronRecord['schedule'],
    ...(r.title != null ? { title: r.title as string } : {}),
    ...(r.action != null ? { action: r.action as string } : {}),
    ...(r.message != null ? { message: r.message as string } : {}),
    ...(r.destination != null ? { destination: JSON.parse(String(r.destination)) as Destination } : {}),
    ...(consent != null
      ? { recipientConsent: (typeof consent === 'object' ? consent : JSON.parse(String(consent))) as RecipientConsent }
      : {}),
    enabled: r.enabled === true,
    archived: r.archived === true,
    createdAt: Number(r.created_at),
    ...(r.next_fire_at != null ? { nextFireAt: Number(r.next_fire_at) } : {}),
    ...(r.last_fired_at != null ? { lastFiredAt: Number(r.last_fired_at) } : {}),
    ...(r.last_attempt_at != null ? { lastAttemptAt: Number(r.last_attempt_at) } : {}),
  }
}

function normalizeTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim().replace(/\s+/g, ' ')
  if (!trimmed) return undefined
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}...` : trimmed
}

function buildRecord(input: CreateCronInput, id: string, now: number): CronRecord {
  const title = normalizeTitle(input.title)
  const { schedule, nextFireAt } = normalizeSchedule(input.schedule, now)
  return {
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
}

export function createPostgresCronStore(connectionString: string, statements: string[] = CRONS_SCHEMA_STATEMENTS): CronStore {
  const store: PgPool = createPgPool(connectionString, statements)
  const { q, close } = store

  async function fetch(id: string): Promise<CronRecord | null> {
    const rows = await q('SELECT * FROM crons WHERE id = $1', [id])
    return rows[0] ? row(rows[0]) : null
  }

  return {
    async create(input) {
      const now = Date.now()
      const draft = buildRecord(input, '', now)
      const id = hashId([
        input.scopeId,
        input.ownerId,
        input.ownerType ?? 'internal',
        input.schedule,
        input.action,
        input.message,
        input.destination,
        draft.title,
      ])
      const inserted = await q(
        `INSERT INTO crons(id, scope_id, owner_id, owner_type, created_by, title, action, message, schedule, destination, enabled, archived, created_at, next_fire_at, recipient_consent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,FALSE,$11,$12,$13)
         ON CONFLICT (id) DO NOTHING RETURNING *`,
        [
          id,
          draft.scopeId,
          draft.ownerId,
          draft.ownerType,
          draft.createdBy,
          draft.title ?? null,
          draft.action ?? null,
          draft.message ?? null,
          JSON.stringify(draft.schedule),
          draft.destination ? JSON.stringify(draft.destination) : null,
          now,
          draft.nextFireAt ?? null,
          draft.recipientConsent ? JSON.stringify(draft.recipientConsent) : null,
        ],
      )
      if (inserted[0]) return row(inserted[0])
      const existing = await fetch(id)
      if (!existing) throw new Error(`crons: record ${id} vanished between insert and select`)
      return existing
    },
    async get(id) {
      return fetch(id)
    },
    async list() {
      const rows = await q('SELECT * FROM crons ORDER BY created_at, seq')
      return rows.map(row)
    },
    async update(id, patch: CronPatch) {
      const current = await fetch(id)
      if (!current) return null
      const next: CronRecord = { ...current }
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
      const updated = await q(
        `UPDATE crons SET title = $2, action = $3, message = $4, schedule = $5, destination = $6,
           enabled = $7, archived = $8, next_fire_at = $9, recipient_consent = $10
         WHERE id = $1 RETURNING *`,
        [
          id,
          next.title ?? null,
          next.action ?? null,
          next.message ?? null,
          JSON.stringify(next.schedule),
          next.destination ? JSON.stringify(next.destination) : null,
          next.enabled,
          next.archived,
          next.nextFireAt ?? null,
          next.recipientConsent ? JSON.stringify(next.recipientConsent) : null,
        ],
      )
      return updated[0] ? row(updated[0]) : null
    },
    async setRecipientConsent(id, consent) {
      const updated = await q(
        `UPDATE crons SET recipient_consent = $2 WHERE id = $1 RETURNING *`,
        [id, consent ? JSON.stringify(consent) : null],
      )
      return updated[0] ? row(updated[0]) : null
    },
    async delete(id) {
      await q('DELETE FROM crons WHERE id = $1', [id])
    },
    async setEnabled(id, enabled) {
      await q('UPDATE crons SET enabled = $2, archived = CASE WHEN $2 THEN FALSE ELSE archived END WHERE id = $1', [id, enabled])
    },
    async due(now) {
      const rows = await q('SELECT * FROM crons WHERE enabled AND NOT archived')
      const due: DueCron[] = []
      for (const raw of rows) {
        const cron = row(raw)
        const scheduledAt = recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt)
        if (scheduledAt !== undefined && now >= scheduledAt) due.push({ ...cron, nextFireAt: scheduledAt, scheduledAt })
      }
      return due.sort((a, b) => a.scheduledAt - b.scheduledAt || a.id.localeCompare(b.id))
    },
    async claimSlot(id, scheduledAt, at) {
      const cron = await fetch(id)
      if (!cron || cron.archived || !cron.enabled) return false
      if (recoverNextFireAt(cron.schedule, cron.createdAt, cron.lastFiredAt, cron.nextFireAt) !== scheduledAt) return false
      const advanceFrom = isCalendarSchedule(cron.schedule) ? scheduledAt : at
      const next = advanceNextFireAt(cron.schedule, advanceFrom)
      const updated = await q(
        `UPDATE crons SET last_fired_at = $3, next_fire_at = $4
         WHERE id = $1 AND enabled AND NOT archived
           AND COALESCE(next_fire_at, $2) = $2 AND last_fired_at IS NOT DISTINCT FROM $5
         RETURNING id`,
        [id, scheduledAt, at, next ?? null, cron.lastFiredAt ?? null],
      )
      return updated.length > 0
    },
    async unclaimSlot(id, scheduledAt, at, priorLastFiredAt) {
      await q(
        `UPDATE crons SET last_fired_at = $3, next_fire_at = $4
         WHERE id = $1 AND last_fired_at = $2`,
        [id, at, priorLastFiredAt ?? null, scheduledAt],
      )
    },
    async markAttempted(id, at) {
      await q('UPDATE crons SET last_attempt_at = $2 WHERE id = $1', [id, at])
    },
    async recordFire(id, entry) {
      await q(
        `INSERT INTO cron_fire_log (cron_id, fire_key, fired_at, json)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cron_id, fire_key) DO UPDATE
         SET fired_at = EXCLUDED.fired_at, json = cron_fire_log.json || EXCLUDED.json`,
        [id, entry.fireKey, entry.firedAt, JSON.stringify(entry)],
      )
    },
    async getFires(id, limit) {
      const rows =
        limit === undefined
          ? await q(
              `SELECT json, COUNT(*) OVER()::BIGINT AS total
               FROM cron_fire_log WHERE cron_id = $1 ORDER BY fired_at, fire_key`,
              [id],
            )
          : await q(
              `SELECT json, total FROM (
                 SELECT fired_at, fire_key, json, COUNT(*) OVER()::BIGINT AS total
                 FROM cron_fire_log
                 WHERE cron_id = $1 ORDER BY fired_at DESC, fire_key DESC LIMIT $2
               ) recent ORDER BY fired_at, fire_key`,
              [id, limit],
            )
      return { runs: rows.map((r) => r.json as CronFireLogEntry), total: Number(rows[0]?.total ?? 0) }
    },
    close,
  }
}
