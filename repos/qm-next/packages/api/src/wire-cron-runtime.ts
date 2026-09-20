/**
 * Phase 4 — Cron Runtime composition seam.
 *
 * After `TriggersService` initializes, copy the cron registry +
 * scheduler + deliveries into `api.cronsRuntime` so existing API cron
 * routes can continue to read it. This is a COMPOSITION-TIME wire, not
 * a late write from Triggers: the Triggers package no longer mutates
 * API. The architecture gate verifies this seam is the only writer.
 *
 * Why a separate service: TriggersService lives in `@qm/triggers` and
 * must NOT import `@qm/api`. The composition service lives in `@qm/api`
 * and may legitimately depend on `@qm/triggers` for the type of the
 * TriggersService surface (one-way dep, no cycle).
 */
import { Service, type Context } from '@qm/cordis'
import type { CronScheduler, CronStore } from '@qm/triggers'
import type { ImDeliveryQueue } from '@qm/im-core'

export interface TriggersServiceSurface {
  crons: CronStore
  scheduler: CronScheduler
  /** The TriggerSink may also be useful to API (event-driven fire). */
  triggers: unknown
}

export interface WireCronRuntimeServiceDeps {
  api: { cronsRuntime?: { crons: CronStore; scheduler?: CronScheduler; deliveries?: ImDeliveryQueue } }
  triggers: TriggersServiceSurface
  /** Delivery queue from im-bridge; same source the TriggersService reads. */
  deliveries: ImDeliveryQueue
}

export class WireCronRuntimeService extends Service {
  static inject = ['api', 'triggers', 'im-bridge'] as const

  constructor(ctx: Context) {
    super(ctx, 'wire-cron-runtime')
  }

  async [Service.init]() {
    const deps = this.ctx as unknown as WireCronRuntimeServiceDeps
    deps.api.cronsRuntime = {
      crons: deps.triggers.crons,
      scheduler: deps.triggers.scheduler,
      deliveries: deps.deliveries,
    }
    return async () => {
      delete deps.api.cronsRuntime
    }
  }
}

declare module '@qm/cordis' {
  interface Context {
    'wire-cron-runtime': WireCronRuntimeService
  }
}

export default WireCronRuntimeService