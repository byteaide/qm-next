/**
 * Cordis mount for the cron/triggers runtime (17.x convergence): a cron
 * store, the tick-lease scheduler and the event-driven trigger sink, with
 * terminal replies delivered over the im-bridge delivery queue (same
 * claim loop the IM replies ride). Production deployments swap the store
 * (memory → Postgres) without touching the scheduler.
 */
import { ApiService } from '@qm/api'
import { Service, type Context } from '@qm/cordis'
import { resolveProviderDm } from '@qm/directory'
import type { ImDeliveryQueue } from '@qm/im-core'
import Schema from '@qm/schemastery'
import { ImTurnBridgeService } from '@qm/im-bridge'
import {
  createCronScheduler,
  createMemoryCronStore,
  createTriggerSink,
  DEFAULT_TICK_INTERVAL_MS,
  type CronScheduler,
  type CronStore,
  type TriggerSink,
} from './index.ts'

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

  static inject = ['api', 'im-bridge']

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
    const api: ApiService = this.ctx.api
    const bridge: ImTurnBridgeService = this.ctx['im-bridge']
    const deliveries: ImDeliveryQueue | undefined = bridge.queue
    if (!deliveries) throw new Error('triggers requires the im-bridge delivery queue — load @qm/im-bridge first')
    this.crons = createMemoryCronStore()
    const replyAs = this.config.replyAs ?? 'markdown'
    const directory = api.directory
    const resolveDm = directory
      ? async (provider: string, userId: string) =>
          (await resolveProviderDm(directory, provider, userId))?.destination ?? null
      : undefined
    const deps = {
      sessions: api.sessions,
      runs: api.runs,
      resolution: api.resolution,
      deliveries,
      replyAs,
      ...(resolveDm ? { resolveDm } : {}),
      ...(directory ? { directory } : {}),
    }
    this.scheduler = createCronScheduler({ ...deps, crons: this.crons })
    this.triggers = createTriggerSink(deps)
    // Parity surface (11.0): expose the registry + scheduler to the API's
    // cron routes; cleared on dispose so late requests 404 cleanly. The
    // delivery queue rides along for consent/edit notices and the admin
    // provenance view (14.0).
    api.cronsRuntime = { crons: this.crons, scheduler: this.scheduler, deliveries }
    this.scheduler.start(this.config.intervalMs)
    return async () => {
      api.cronsRuntime = undefined
      this.scheduler.stop()
    }
  }
}

declare module '@qm/cordis' {
  interface Context {
    triggers: TriggersService
  }
}

export default TriggersService
