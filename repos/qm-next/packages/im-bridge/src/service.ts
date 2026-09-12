/**
 * Cordis assembly for the M2 convergence: owns the IM registry (`ctx.im`)
 * with this bridge as the inbound sink, plus the memory delivery queue and
 * claim loop. Turn storage comes from the ApiService composition root via
 * injection; production deployments swap each piece independently.
 */
import { Service, type Context } from '@qm/cordis'
import { ImRegistryService } from '@qm/im-core/runtime'
import Schema from '@qm/schemastery'
import { createImTurnBridge, type ImTurnBridge, type ImTurnBridgeLoopOptions } from './bridge.ts'

export interface ImBridgeConfig {
  /** Principal type assigned to IM actors. */
  actorType?: 'internal' | 'guest'
  /** Reply body shape. */
  replyAs?: 'markdown' | 'text'
  /** Delivery-loop poll cadence in ms. */
  tickMs?: number
  /** Delivery claim lease duration in ms. */
  claimTtlMs?: number
  /** Maximum deliveries per claim. */
  maxPerClaim?: number
  /** Give up a delivery after this many attempts. */
  maxAttempts?: number
  /** Base backoff for failed deliveries in ms. */
  backoffMs?: number
}

export const Config = Schema.object({
  actorType: Schema.union(['internal', 'guest']).default('internal').description('Principal type assigned to IM actors'),
  replyAs: Schema.union(['markdown', 'text']).default('markdown').description('Reply body shape'),
  tickMs: Schema.number().default(25).description('Delivery-loop poll cadence in ms'),
  claimTtlMs: Schema.number().default(30_000).description('Delivery claim lease duration in ms'),
  maxPerClaim: Schema.number().default(10).description('Maximum deliveries per claim'),
  maxAttempts: Schema.number().default(5).description('Give up a delivery after this many attempts'),
  backoffMs: Schema.number().default(1_000).description('Base backoff for failed deliveries in ms'),
})

export class ImTurnBridgeService extends Service<ImBridgeConfig> {
  static Config = Config

  static inject = ['api']

  private bridge: ImTurnBridge | undefined

  constructor(ctx: Context, public config: ImBridgeConfig) {
    super(ctx, 'im-bridge')
  }

  async [Service.init]() {
    const loop: ImTurnBridgeLoopOptions = {
      ...(this.config.tickMs !== undefined ? { tickMs: this.config.tickMs } : {}),
      ...(this.config.claimTtlMs !== undefined ? { claimTtlMs: this.config.claimTtlMs } : {}),
      ...(this.config.maxPerClaim !== undefined ? { maxPerClaim: this.config.maxPerClaim } : {}),
      ...(this.config.maxAttempts !== undefined ? { maxAttempts: this.config.maxAttempts } : {}),
      ...(this.config.backoffMs !== undefined ? { backoffMs: this.config.backoffMs } : {}),
    }
    const registry = new ImRegistryService(this.ctx, {
      onEvent: (events) => (this.bridge ? this.bridge.sink(events) : Promise.resolve()),
    })
    this.bridge = createImTurnBridge(
      {
        runs: this.ctx.api.runs,
        sessions: this.ctx.api.sessions,
        resolution: this.ctx.api.resolution,
        im: registry,
      },
      {
        ...(this.config.actorType ? { actorType: this.config.actorType } : {}),
        ...(this.config.replyAs ? { replyAs: this.config.replyAs } : {}),
        loop,
      },
    )
    await this.bridge.start()
    return async () => {
      await this.bridge?.stop()
    }
  }
}

declare module '@qm/cordis' {
  interface Context {
    'im-bridge': ImTurnBridgeService
  }
}

export default ImTurnBridgeService
