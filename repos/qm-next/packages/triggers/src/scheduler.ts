/**
 * The cron scheduler: leader-leased ticks over the durable due set, one
 * claim per scheduled slot (`claimSlot`), fire → turn via the fire engine,
 * and reply routing to the IM delivery queue. Also hosts the event-driven
 * trigger sink (`fireTrigger(key, destination, text)` → turn), which skips
 * the slot machinery: its idempotency is the fire key itself.
 */
import { randomUUID } from 'node:crypto'
import type { DirectoryStore } from '@qm/directory'
import type { ImDeliveryQueue, ImLogger } from '@qm/im-core'
import type { Principal } from '@qm/types'
import {
  CRON_SURFACE,
  TRIGGER_SURFACE,
  cronFireKey,
  manualFireKey,
  type CronFireLogEntry,
  type CronRecord,
  type CronStore,
  type DueCron,
  type LeaderLease,
  type TriggerEngineDeps,
  type TriggerFireInput,
  type TriggerSink,
  type TriggerSubmission,
} from './contract.ts'
import { createFireEngine, destinationVisibleToOwner, renderCronFireInput, type FireEngine } from './fire.ts'
import { isCalendarSchedule } from './schedule.ts'
import { errMessage, truncate } from './util.ts'

const TICK_LEASE_KEY = 'cron:scheduler:tick'
export const DEFAULT_TICK_INTERVAL_MS = 30_000
export const DEFAULT_MAX_FIRES_PER_TICK = 100

export interface CronSchedulerDeps extends TriggerEngineDeps {
  crons: CronStore
  deliveries?: ImDeliveryQueue
  directory?: DirectoryStore
  lease?: LeaderLease
  identity?: { isInternal(principal: Principal): boolean }
  replyAs?: 'markdown' | 'text'
  now?: () => number
  maxFiresPerTick?: number
  logger?: ImLogger
}

export interface CronScheduler {
  /** Fire everything due at `now` (defaults to the injected clock). */
  tick(now?: number): Promise<void>
  /** Fire one cron immediately under a unique manual key; no slot claim. */
  runNow(cronId: string): Promise<TriggerSubmission | null>
  start(intervalMs?: number): void
  stop(): void
}

export function createCronScheduler(deps: CronSchedulerDeps): CronScheduler {
  const now = deps.now ?? (() => Date.now())
  const maxFiresPerTick = deps.maxFiresPerTick ?? DEFAULT_MAX_FIRES_PER_TICK
  const logger: ImLogger = deps.logger ?? console
  const lease = deps.lease ?? { hold: async <T>(_key: string, fn: () => Promise<T>) => fn() }
  const engine: FireEngine = createFireEngine(deps)

  function isOneShot(cron: Pick<CronRecord, 'schedule'>): boolean {
    return !isCalendarSchedule(cron.schedule) && cron.schedule.everyMs === undefined
  }

  function disableAfterFire(cron: CronRecord): Promise<void> {
    return isOneShot(cron) ? deps.crons.setEnabled(cron.id, false) : Promise.resolve()
  }

  async function deliverMessage(cron: CronRecord, fireKey: string, at: number): Promise<void> {
    if (!cron.destination) {
      await deps.crons.recordFire(cron.id, {
        fireKey,
        firedAt: at,
        status: 'refused',
        note: 'message fire has no destination — dropped',
      })
      return
    }
    if (deps.directory && !(await destinationVisibleToOwner(deps.directory, cron.ownerId, cron.destination))) {
      await deps.crons.recordFire(cron.id, {
        fireKey,
        firedAt: at,
        status: 'refused',
        note: 'destination is no longer visible to the cron owner — delivery skipped',
      })
      return
    }
    if (!deps.deliveries) {
      await deps.crons.recordFire(cron.id, { fireKey, firedAt: at, status: 'refused', note: 'no delivery queue configured' })
      return
    }
    await deps.deliveries.enqueue({
      provider: cron.destination.type,
      op: { op: 'send', destination: cron.destination, body: deps.replyAs === 'text' ? { text: cron.message! } : { markdown: cron.message! } },
      idempotencyKey: `cron-fire:${fireKey}`,
      origin: { trigger: cron.id },
    })
    await deps.crons.recordFire(cron.id, { fireKey, firedAt: at, status: 'ok' })
  }

  async function fire(cron: DueCron, at: number): Promise<void> {
    const fireKey = cronFireKey(cron.id, cron.scheduledAt)
    if (cron.message !== undefined) {
      if (!(await deps.crons.claimSlot(cron.id, cron.scheduledAt, at))) return
      await deliverMessage(cron, fireKey, at)
      await disableAfterFire(cron)
      return
    }
    const actor: Principal = { id: cron.ownerId, type: cron.ownerType }
    if (deps.identity && !deps.identity.isInternal(actor)) {
      await deps.crons.setEnabled(cron.id, false)
      await deps.crons.recordFire(cron.id, {
        fireKey,
        firedAt: at,
        scheduledAt: cron.scheduledAt,
        status: 'refused',
        note: 'owner is no longer an internal principal — cron disabled',
      })
      return
    }
    if (!(await deps.crons.claimSlot(cron.id, cron.scheduledAt, at))) return
    try {
      await engine.submit({
        surface: CRON_SURFACE,
        fireKey,
        text: renderCronFireInput(cron.action ?? '', cron.id, cron.title),
        ownerId: cron.ownerId,
        ownerType: cron.ownerType,
        scopeId: cron.scopeId,
        ...(cron.destination ? { destination: cron.destination } : {}),
        ...(cron.title ? { title: cron.title } : {}),
        cronId: cron.id,
        firedAt: at,
        scheduledAt: cron.scheduledAt,
        onTerminal: (entry: CronFireLogEntry) => deps.crons.recordFire(cron.id, entry),
      })
    } catch (e) {
      await deps.crons.unclaimSlot(cron.id, cron.scheduledAt, at, cron.lastFiredAt)
      await deps.crons.recordFire(cron.id, {
        fireKey,
        firedAt: at,
        scheduledAt: cron.scheduledAt,
        status: 'failed',
        note: truncate(errMessage(e), 2000),
      })
      return
    }
    await disableAfterFire(cron)
  }

  async function fireDue(at: number): Promise<void> {
    const due = await deps.crons.due(at)
    let batch = due
    if (due.length > maxFiresPerTick) {
      const ordered = [...due].sort((a, b) => (a.lastAttemptAt ?? 0) - (b.lastAttemptAt ?? 0))
      batch = []
      for (const cron of ordered) {
        if (batch.length >= maxFiresPerTick) break
        try {
          await deps.crons.markAttempted(cron.id, at)
          batch.push(cron)
        } catch (e) {
          logger.error(`triggers: attempt mark failed for cron ${cron.id}, holding back:`, e)
        }
      }
      logger.warn(`triggers: fan-out capped — firing ${batch.length}/${due.length} due crons this tick`)
    }
    for (const cron of batch) {
      try {
        await fire(cron, at)
      } catch (e) {
        logger.error(`triggers: fire failed for cron ${cron.id}:`, e)
      }
    }
  }

  let timer: NodeJS.Timeout | null = null
  let ticking = false
  let stopped = false

  const scheduler: CronScheduler = {
    async tick(nowArg) {
      const at = nowArg ?? now()
      await lease.hold(TICK_LEASE_KEY, () => fireDue(at))
    },
    async runNow(cronId) {
      const cron = await deps.crons.get(cronId)
      if (!cron || cron.archived || !cron.enabled) return null
      return engine.submit({
        surface: CRON_SURFACE,
        fireKey: manualFireKey(cronId, randomUUID()),
        text: renderCronFireInput(cron.action ?? '', cron.id, cron.title),
        ownerId: cron.ownerId,
        ownerType: cron.ownerType,
        scopeId: cron.scopeId,
        ...(cron.destination ? { destination: cron.destination } : {}),
        ...(cron.title ? { title: cron.title } : {}),
        cronId,
        firedAt: now(),
        onTerminal: (entry) => deps.crons.recordFire(cronId, entry),
      })
    },
    start(intervalMs = DEFAULT_TICK_INTERVAL_MS) {
      if (timer) return
      stopped = false
      timer = setInterval(() => {
        if (ticking || stopped) return
        ticking = true
        void scheduler
          .tick()
          .catch((e: unknown) => logger.error('triggers: tick failed:', e))
          .finally(() => {
            ticking = false
          })
      }, intervalMs)
      timer.unref()
    },
    stop() {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
  return scheduler
}

/**
 * Event-driven trigger port: one turn per key, reply routed to the
 * destination when given. No schedule, no slot — the key is the
 * idempotency domain.
 */
export function createTriggerSink(
  deps: TriggerEngineDeps & {
    directory?: DirectoryStore
    deliveries?: ImDeliveryQueue
    replyAs?: 'markdown' | 'text'
    logger?: ImLogger
  },
): TriggerSink {
  const engine = createFireEngine(deps)
  return {
    fire(input: TriggerFireInput): Promise<TriggerSubmission> {
      return engine.submit({
        surface: TRIGGER_SURFACE,
        fireKey: input.key,
        text: input.text,
        ownerId: input.ownerId,
        ...(input.ownerType ? { ownerType: input.ownerType } : {}),
        ...(input.scopeId ? { scopeId: input.scopeId } : {}),
        ...(input.destination ? { destination: input.destination } : {}),
        ...(input.title ? { title: input.title } : {}),
        firedAt: Date.now(),
      })
    },
  }
}
