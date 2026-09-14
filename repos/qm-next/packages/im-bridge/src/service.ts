/**
 * Cordis assembly for the M2 convergence: owns the IM registry (`ctx.im`)
 * with this bridge as the inbound sink, plus the memory delivery queue and
 * claim loop. Turn storage comes from the ApiService composition root via
 * injection; production deployments swap each piece independently.
 *
 * Ambient (14.0): `ambientJudgeMode` picks the judge — `keyword` uses the
 * deterministic stub with `ambientKeyword` (smokes, e2e), `model` uses the
 * api's harness judge port (qm's real-model ambient mind). Judgment and
 * cursor stores ride in from the api when its `ambient` observability is
 * on; `ambientPolicySource: 'api'` shares the context-policy-managed
 * store instead of a boot-local one. All modes stay fully inert when
 * their ingredients are missing, so a half-configured deployment cannot
 * silence the bot.
 */
import { Service, type Context } from '@qm/cordis'
import {
  createKeywordAmbientJudge,
  createMemoryChannelPolicyStore,
  createModelAmbientJudge,
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
  /** Stub judge keyword (`*` engages all); required with keyword mode. */
  ambientKeyword?: string
  /** Ambient judge flavor: the deterministic keyword stub or the api's harness judge. */
  ambientJudgeMode?: 'keyword' | 'model'
  /** Policy source: boot-local memory store or the api's context-policy store. */
  ambientPolicySource?: 'boot' | 'api'
  /** Reaction-as-ack (default on; inert on providers without react). */
  ackReactions?: boolean
  /** Delay before the ack reaction fires (qm default 2000ms). */
  ackDelayMs?: number
  /** Candidate emoji override; qm's defaults when absent. */
  ackEmojiCandidates?: string[]
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
  ambientJudgeMode: Schema.union(['keyword', 'model']).default('keyword').description('Ambient judge flavor: keyword stub or the api harness judge'),
  ambientPolicySource: Schema.union(['boot', 'api']).default('boot').description('Ambient policy store: boot-local memory or the api context-policy store'),
  ackReactions: Schema.boolean().default(true).description('Reaction-as-ack while a run is in flight (providers without react stay inert)'),
  ackDelayMs: Schema.number().default(2_000).description('Delay before the ack reaction fires'),
  ackEmojiCandidates: Schema.array(Schema.string()).description('Candidate emoji override; qm defaults when absent'),
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
    const mode = this.config.ambientJudgeMode ?? 'keyword'
    const api = this.ctx.api
    const sharedPolicy = this.config.ambientPolicySource === 'api' ? api.channelPolicy : undefined
    if (this.config.ambientPolicySource === 'api' && !sharedPolicy) {
      this.ctx.logger.warn('im-bridge: ambientPolicySource "api" but the api exposes no channel policy — using a boot-local store')
    }
    const policy: ChannelPolicyStore = sharedPolicy ?? createMemoryChannelPolicyStore()
    let ambient: ImTurnBridgeOptions['ambient'] | undefined
    const modelJudge = mode === 'model' ? api.ambientJudge : undefined
    if (mode === 'model' && !modelJudge) {
      this.ctx.logger.warn('im-bridge: ambientJudgeMode "model" but the api exposes no harness judge — ambient stays inert')
    } else if (mode === 'model' && modelJudge) {
      ambient = {
        policy,
        judge: createModelAmbientJudge({ judge: modelJudge.judge }),
        ...(api.ambientCursors ? { cursors: api.ambientCursors } : {}),
        ...(api.ambientJudgments ? { judgments: api.ambientJudgments } : {}),
        ...(modelJudge.model ? { judgeModel: modelJudge.model } : {}),
      }
      this.ambientPolicy = policy
    } else if (this.config.ambientKeyword) {
      // With a judge keyword the policy store exists even with no
      // containers preloaded: absent entries stay inert, and tooling can
      // enable containers after boot via `ambientPolicy`.
      for (const container of containers) await policy.setAmbient(container, true)
      ambient = {
        policy,
        judge: createKeywordAmbientJudge(this.config.ambientKeyword),
        ...(api.ambientCursors ? { cursors: api.ambientCursors } : {}),
        ...(api.ambientJudgments ? { judgments: api.ambientJudgments } : {}),
      }
      this.ambientPolicy = policy
    } else if (containers.length > 0) {
      this.ctx.logger.warn('im-bridge: ambientContainers set without a judge — ambient stays inert')
    }
    const registry = new ImRegistryService(this.ctx, {
      onEvent: (events) => (this.bridge ? this.bridge.sink(events) : Promise.resolve()),
    })
    let ack: ImTurnBridgeOptions['ack'] | undefined
    if (this.config.ackReactions !== false) {
      ack = {
        ...(this.config.ackDelayMs !== undefined ? { delayMs: this.config.ackDelayMs } : {}),
        ...(this.config.ackEmojiCandidates?.length ? { candidates: this.config.ackEmojiCandidates } : {}),
        ...(api.ackEmoji ? { pick: api.ackEmoji.pick } : {}),
        ...(api.ackPicks
          ? {
              onPick: (rec) => {
                void api.ackPicks!.record(rec).catch((err) => this.ctx.logger.error('im-bridge: ack pick record failed:', err))
              },
            }
          : {}),
      }
    }
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
        ...(ack ? { ack } : {}),
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
