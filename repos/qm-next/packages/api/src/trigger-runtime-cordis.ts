/**
 * Phase 4 — Trigger Runtime Cordis wrapper.
 *
 * ADR-0003: API supplies the runtime during composition; Triggers
 * consume the contract via Cordis DI without importing API.
 *
 * This file owns the runtime impl + the Cordis registration. Triggers
 * accesses `ctx['trigger-runtime'].runtime` and never sees `ApiService`.
 */
import { Service, type Context } from '@qm/cordis'
import type { TriggerRuntimeImpl } from './trigger-runtime-impl.ts'
import { createTriggerRuntimeFromApi, type TriggerRuntimeImplOptions } from './trigger-runtime-impl.ts'

export class TriggerRuntimeCordisService extends Service {
  /** The runtime impl; constructed on `[Service.init]`. */
  runtime!: TriggerRuntimeImpl

  /** Stores the runtime wraps; composition exposes them so the cron
   * scheduler and fire engine can consume the same contracts without
   * importing `@qm/api` (ADR-0003). */
  runs!: import('@qm/types').RunStore
  sessions!: import('@qm/types').SessionStore
  resolution!: import('@qm/types').ResolutionService

  /** API-internal: the runtime impl wraps ApiService surfaces. */
  static inject = ['api'] as const

  constructor(ctx: Context, public opts: TriggerRuntimeImplOptions = {}) {
    super(ctx, 'trigger-runtime')
  }

  async [Service.init]() {
    // `inject = ['api']` declares the dep via Cordis DI. The runtime
    // impl reads from api but exposes only the minimal TriggerRuntime
    // contract — Triggers never see ApiService internals.
    const api = this.ctx.api as unknown as {
      runs: import('@qm/types').RunStore
      sessions: import('@qm/types').SessionStore
      resolution: import('@qm/types').ResolutionService
    }
    this.runs = api.runs
    this.sessions = api.sessions
    this.resolution = api.resolution
    this.runtime = createTriggerRuntimeFromApi(
      {
        runs: api.runs,
        sessions: api.sessions,
        resolution: api.resolution,
      },
      this.opts,
    )
  }
}

declare module '@qm/cordis' {
  interface Context {
    'trigger-runtime': TriggerRuntimeCordisService
  }
}

export default TriggerRuntimeCordisService