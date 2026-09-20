/**
 * Cordis mount for the cron/triggers runtime (Phase 4 refactor):
 * the cron store, the tick-lease scheduler, and the event-driven trigger
 * sink. Phase 4 removes the `@qm/api` import: triggers depend only on
 * the minimal `TriggerRuntime` contract (ADR-0003).
 *
 * The composition root wires the runtime impl into `ctx['trigger-runtime']`;
 * this service injects it via Cordis and never touches `ApiService`.
 *
 * `ctx['trigger-runtime']` is typed structurally as a holder of the
 * minimal `TriggerRuntime` contract; this service does NOT import any
 * API-side implementation. The architecture gate verifies the absence
 * of `@qm/api` imports.
 */
import { Service, type Context } from '@qm/cordis'
import type { ImDeliveryQueue } from '@qm/im-core'
import Schema from '@qm/schemastery'
import { ImTurnBridgeService } from '@qm/im-bridge'
import { createMemoryLeaderLease } from '@qm/concurrency'
import {
  createCronScheduler,
  createMemoryCronStore,
  createPostgresCronStore,
  createPostgresLeaderLease,
  createTriggerSink,
  DEFAULT_TICK_INTERVAL_MS,
  type CronScheduler,
  type CronStore,
  type TriggerSink,
} from './index.ts'
import type { TriggerRuntime } from '@qm/types'

/** Structural shape of the runtime holder exposed by `@qm/api`. */
interface TriggerRuntimeHolder {
  runtime: TriggerRuntime
  opts?: { databaseUrl?: string }
  /** Stores behind the runtime; composition supplies them so the
   * scheduler + fire engine consume the contracts (ADR-0003: Triggers
   * import the ports from `@qm/types`, never `@qm/api`). */
  runs?: import('@qm/types').RunStore
  sessions?: import('@qm/types').SessionStore
  resolution?: import('@qm/types').ResolutionService
}

export interface TriggersConfig {
  /** Tick interval in ms; the scheduler claims due slots each tick. */
  intervalMs?: number
  /** Reply body shape for delivered fire replies. */
  replyAs?: 'markdown' | 'text'
}

export const Config = Schema.object({
  intervalMs: Schema.number().default(DEFAULT_TICK_INTERVAL_MS).description('Scheduler tick interval in ms'),
  replyAs: Schema.union(['markdown', 'text']).default('markdown').description('Fire reply body shape'),
})

export class TriggersService extends Service<TriggersConfig> {
  static Config = Config

  /**
   * Phase 4 — inject the runtime contract, not ApiService. The runtime
   * is exposed by `@qm/api` as a Cordis service (`'trigger-runtime'`);
   * Triggers never sees ApiService internals.
   */
  static inject = ['trigger-runtime', 'im-bridge'] as const

  /** Durable cron registry; the memory store until a Postgres root swaps in. */
  crons!: CronStore

  /** Tick-lease scheduler; started on init, stopped on dispose. */
  scheduler!: CronScheduler

  /** Event-driven trigger sink keyed per fire event. */
  triggers!: TriggerSink

  constructor(ctx: Context, public config: TriggersConfig) {
    super(ctx, 'triggers')
  }

  async [Service.init]() {
    const runtimeService = this.ctx['trigger-runtime'] as TriggerRuntimeHolder
    const runtime: TriggerRuntime = runtimeService.runtime
    const runs = runtimeService.runs
    const sessions = runtimeService.sessions
    const resolution = runtimeService.resolution
    if (!runs || !sessions || !resolution) {
      throw new Error(
        'triggers requires runs/sessions/resolution from the trigger-runtime composition — mount TriggerRuntimeCordisService (or an equivalent holder) first',
      )
    }
    const bridge: ImTurnBridgeService = this.ctx['im-bridge']
    const deliveries: ImDeliveryQueue | undefined = bridge.queue
    if (!deliveries) throw new Error('triggers requires the im-bridge delivery queue — load @qm/im-bridge first')

    // Cron store + leader lease stay behind the Trigger boundary (plan §4.6).
    // Phase 4 keeps the same bootstrap semantics as before (memory until
    // databaseUrl is set) but routes the config through the runtime
    // service opts rather than reading API internals directly.
    const databaseUrl = runtimeService.opts?.databaseUrl
    this.crons = databaseUrl ? createPostgresCronStore(databaseUrl) : createMemoryCronStore()
    const pgCrons: { close(): Promise<void> } | undefined = databaseUrl ? (this.crons as { close(): Promise<void> }) : undefined
    const lease = databaseUrl ? createPostgresLeaderLease(databaseUrl) : createMemoryLeaderLease()
    const replyAs = this.config.replyAs ?? 'markdown'

    const deps = {
      runtime,
      crons: this.crons,
      lease,
      deliveries,
      replyAs,
      runs,
      sessions,
      resolution,
    }
    this.scheduler = createCronScheduler(deps)
    this.triggers = createTriggerSink(deps)
    this.scheduler.start(this.config.intervalMs)
    return async () => {
      this.scheduler.stop()
      await pgCrons?.close().catch(() => undefined)
    }
  }
}

declare module '@qm/cordis' {
  interface Context {
    triggers: TriggersService
  }
}

export default TriggersService