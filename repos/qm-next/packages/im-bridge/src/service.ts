/**
 * Cordis assembly for the M2 convergence: owns the IM registry (`ctx.im`)
 * with this bridge as the inbound sink, plus the memory delivery queue and
 * claim loop. Turn storage comes from the ApiService composition root via
 * injection; production deployments swap each piece independently.
 *
 * Ambient (M3 minimal slice): `ambientContainers` + `ambientKeyword`
 * build a memory channel policy and the keyword stub judge. Both must be
 * provided for ambient to activate — containers without a judge stay
 * fully inert so a half-configured deployment cannot silence the bot.
 */
import { Service, type Context } from '@qm/cordis'
import {
  createKeywordAmbientJudge,
  createMemoryChannelPolicyStore,
  type ChannelPolicyStore,
} from '@qm/approvals'
import type { ImDeliveryQueue } from '@qm/im-core'
import { ImRegistryService } from '@qm/im-core/runtime'
import Schema from '@qm/schemastery'
import { createImTurnBridge, type ImTurnBridge, type ImTurnBridgeLoopOptions, type ImTurnBridgeOptions } from './bridge.ts'

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
  /** Containers (`provider:target`) with ambient enabled at boot. */
  ambientContainers?: string[]
  /** Stub judge keyword (`*` engages all); required with ambientContainers. */
  ambientKeyword?: string
}

export const Config = Schema.object({
  actorType: Schema.union(['internal', 'guest']).default('internal').description('Principal type assigned to IM actors'),
  replyAs: Schema.union(['markdown', 'text']).default('markdown').description('Reply body shape'),
  tickMs: Schema.number().default(25).description('Delivery-loop poll cadence in ms'),
  claimTtlMs: Schema.number().default(30_000).description('Delivery claim lease duration in ms'),
  maxPerClaim: Schema.number().default(10).description('Maximum deliveries per claim'),
  maxAttempts: Schema.number().default(5).description('Give up a delivery after this many attempts'),
  backoffMs: Schema.number().default(1_000).description('Base backoff for failed deliveries in ms'),
  ambientContainers: Schema.array(Schema.string()).default([]).description('Containers (provider:target) with ambient enabled'),
  ambientKeyword: Schema.string().description('Ambient stub judge keyword; * engages all'),
})

export class ImTurnBridgeService extends Service<ImBridgeConfig> {
  static Config = Config

  static inject = ['api']

  private bridge: ImTurnBridge | undefined

  /** The delivery queue the bridge drains; cron/trigger deliveries share it. */
  queue!: ImDeliveryQueue

  /**
   * The ambient container policy this service built, when ambient is
   * active. Exposed so tooling can enable containers after boot (the e2e
   * boot arms ambient from the first observed chat).
   */
  ambientPolicy?: ChannelPolicyStore

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
    const containers = this.config.ambientContainers ?? []
    let ambient: ImTurnBridgeOptions['ambient'] | undefined
    if (this.config.ambientKeyword) {
      // With a judge keyword the policy store exists even with no
      // containers preloaded: absent entries stay inert, and tooling can
      // enable containers after boot via `ambientPolicy`.
      const policy = createMemoryChannelPolicyStore()
      for (const container of containers) await policy.setAmbient(container, true)
      ambient = { policy, judge: createKeywordAmbientJudge(this.config.ambientKeyword) }
      this.ambientPolicy = policy
    } else if (containers.length > 0) {
      this.ctx.logger.warn('im-bridge: ambientContainers set without ambientKeyword — ambient stays inert')
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
        ...(ambient ? { ambient } : {}),
        loop,
      },
    )
    this.queue = this.bridge.queue
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
