/**
 * The M1 composition root: memory stores, mock harness, dev admission
 * defaults, the orchestrator, the async run loop and the HTTP server wired
 * into one cordis service. This is assembly, not policy — production
 * deployments swap each piece without touching the others.
 */
import { Context, Service } from '@qm/cordis'
import { createHarnessRouter, createMockHarness, OrchestratorService } from '@qm/orchestrator'
import Schema from '@qm/schemastery'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { IdentityService, RateLimiter, ResolutionService, ScopeId } from '@qm/types'
import { createApiServer } from './server.ts'
import { createTurnRunner } from './runner.ts'

export interface ApiConfig {
  /** Listen port; 0 picks a free port. */
  port?: number
  /** Listen host. */
  host?: string
  /** Signing secrets; the first mints, every entry verifies. */
  secrets: string[]
  /** Async run-queue poll interval in ms. */
  tickMs?: number
  /** Harness id used when a turn does not name one. */
  defaultHarness?: string
  /** Dev default system prompt. */
  systemPrompt?: string
  /** Dev default scope for API turns. */
  scopeId?: ScopeId
}

export const Config = Schema.object({
  port: Schema.number().default(0).description('Listen port; 0 picks a random free port'),
  host: Schema.string().default('127.0.0.1').description('Listen host'),
  secrets: Schema.array(Schema.string()).required().description('Signing secrets; the first mints, every entry verifies'),
  tickMs: Schema.number().default(25).description('Async run-queue poll interval in ms'),
  defaultHarness: Schema.string().default('mock').description('Harness id used when a turn does not name one'),
  systemPrompt: Schema.string().default('You are qm-next.').description('Dev default system prompt'),
  scopeId: Schema.string().default('org:default').description('Dev default scope for API turns'),
})

function devIdentity(): IdentityService {
  return {
    isInternal: (p) => p.type === 'internal',
    audienceIsAllInternal: (audience) => audience.every((p) => p.type === 'internal'),
  }
}

function devResolution(config: ApiConfig): ResolutionService {
  const systemPrompt = config.systemPrompt ?? 'You are qm-next.'
  const scope = config.scopeId ?? 'org:default'
  return {
    resolve: async () => ({ systemPrompt, orgScopeId: scope }),
    scopeFor: () => scope,
  }
}

function allowLimiter(): RateLimiter {
  return { check: async () => ({ allowed: true }) }
}

export class ApiService extends Service<ApiConfig> {
  static Config = Config

  /** Listen address; available once the plugin fiber is active. */
  address = { port: 0, host: '' }

  constructor(ctx: Context, public config: ApiConfig) {
    super(ctx, 'api')
  }

  async [Service.init]() {
    if (!this.config.secrets?.length) throw new Error('api requires at least one signing secret')
    const sessions = createMemorySessionStore()
    const runs = createMemoryRunStore()
    const registry = createHarnessRouter({ defaultId: this.config.defaultHarness ?? 'mock' })
    registry.register(createMockHarness())
    const resolution = devResolution(this.config)
    const orchestrator = new OrchestratorService(this.ctx, {
      sessions,
      runs,
      harness: registry,
      identity: devIdentity(),
      resolution,
      rateLimiter: allowLimiter(),
    })
    const runner = createTurnRunner(
      { orchestrator, runs },
      this.config.tickMs !== undefined ? { tickMs: this.config.tickMs } : {},
    )
    runner.start()
    const app = createApiServer({ orchestrator, sessions, runs, resolution }, { secrets: this.config.secrets })
    await app.listen({ port: this.config.port ?? 0, host: this.config.host ?? '127.0.0.1' })
    const addr = app.server.address()
    if (typeof addr === 'object' && addr !== null) this.address = { port: addr.port, host: addr.address }
    return async () => {
      await runner.stop()
      await app.close()
    }
  }
}

export default ApiService

declare module '@qm/cordis' {
  interface Context {
    api: ApiService
  }
}
