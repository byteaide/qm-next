/**
 * The composition root: memory stores, harness registry (mock echo and, when
 * configured, the real pi engine over the model registry), dev admission
 * defaults, the orchestrator, the async run loop and the HTTP server wired
 * into one cordis service. This is assembly, not policy — production
 * deployments swap each piece without touching the others.
 */
import { Context, Service } from '@qm/cordis'
import { createClaudeHarness } from '@qm/harness-claude'
import { createCodexHarness } from '@qm/harness-codex'
import { createOpenCodeHarness } from '@qm/harness-opencode'
import { createPiHarness } from '@qm/harness-pi'
import { createModelGateway, setCustomProviders, validateCustomProviderSpec, type CustomProviderSpec } from '@qm/model'
import type { RuntimeRouteConfig } from '@qm/orchestrator'
import { createHarnessRouter, createMockHarness, createSandboxToolContext, OrchestratorService } from '@qm/orchestrator'
import Schema from '@qm/schemastery'
import { createLocalSandbox } from '@qm/sandbox'
import { createMemoryRunEventBus, createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type {
  Harness,
  IdentityService,
  OrchestratorDeps,
  RateLimiter,
  ResolutionService,
  RunEventBus,
  RunStore,
  Sandbox,
  SandboxHandle,
  ScopeId,
  SessionStore,
} from '@qm/types'
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
  /** Harness id used when a turn does not name one; 'pi' boots the real engine. */
  defaultHarness?: 'mock' | 'pi' | 'claude' | 'codex' | 'opencode'
  /** Engines instantiated beside mock at boot; defaults to defaultHarness when it names a real engine. */
  engines?: Array<'mock' | 'pi' | 'claude' | 'codex' | 'opencode'>
  /** Routing config: approved harnesses, deployment default, per-scope overrides (per-surface/per-model choice). */
  harnessRoutes?: RuntimeRouteConfig
  /** Base model id for the pi harness (a model registry entry). */
  modelId?: string
  /** Provider keys handed to the pi harness (env/config injection; keychain-backed resolution arrives with the control plane). */
  anthropicApiKey?: string
  openaiApiKey?: string
  openrouterApiKey?: string
  /** Custom model providers (OpenAI-/Anthropic-compatible) registered before the pi harness boots; specs validated at boot. */
  customProviders?: CustomProviderSpec[]
  /** Keys for custom providers, by provider id. */
  customProviderKeys?: Record<string, string>
  /** Sandbox-backed tool execution; presence gives every turn a ToolContext (docker local backend). */
  sandbox?: {
    image?: string
    dockerBin?: string
    cpus?: number
    memoryMb?: number
    /** Per-command exec timeout in seconds (ceiling-capped). */
    defaultTimeoutSec?: number
    /** Hard ceiling for per-command exec timeouts in seconds. */
    defaultTimeoutCeilingSec?: number
  }
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
  defaultHarness: Schema.union(['mock', 'pi', 'claude', 'codex', 'opencode'])
    .default('mock')
    .description("Harness id used when a turn does not name one; 'pi' boots the real engine"),
  engines: Schema.array(Schema.union(['mock', 'pi', 'claude', 'codex', 'opencode'])).description(
    'Engines instantiated beside mock at boot; defaults to defaultHarness when it names a real engine',
  ),
  harnessRoutes: Schema.any().description(
    'Routing config: approved harnesses, deployment default, per-scope overrides',
  ),
  modelId: Schema.string().description('pi base model id (a model registry entry)'),
  customProviders: Schema.array(Schema.any()).description('Custom model providers (OpenAI/Anthropic-compatible); specs validated at boot'),
  customProviderKeys: Schema.dict(Schema.string()).description('Keys for custom providers, by provider id'),
  sandbox: Schema.object({
    image: Schema.string().description('Docker image for the local sandbox (default qm-sandbox-local:latest)'),
    dockerBin: Schema.string().description('Docker binary path override'),
    cpus: Schema.number().description('CPU cores per sandbox container'),
    memoryMb: Schema.number().description('Memory cap (MB) per sandbox container'),
    defaultTimeoutSec: Schema.number().description('Per-command exec timeout in seconds'),
    defaultTimeoutCeilingSec: Schema.number().description('Hard ceiling for per-command exec timeouts in seconds'),
  }).description('Sandbox-backed tool execution; set any field (e.g. defaultTimeoutSec) to give every turn a ToolContext'),
  anthropicApiKey: Schema.string().description('Anthropic key for the pi harness'),
  openaiApiKey: Schema.string().description('OpenAI key for the pi harness'),
  openrouterApiKey: Schema.string().description('OpenRouter key for the pi harness'),
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

  /** Queued-turn store; shared by HTTP intake and IM-originated turns. */
  runs!: RunStore

  /** Session store behind the orchestrator. */
  sessions!: SessionStore

  /** Dev resolution (system prompt + scope) used for API and IM turns. */
  resolution!: ResolutionService

  /** The orchestrator driving every turn. */
  orchestrator!: OrchestratorService

  /** Sandbox backend when tool execution is configured; torn down on dispose. */
  sandbox?: Sandbox

  /** Run event stream (deltas/progress/status); the SSE surface reads this. */
  runEvents!: RunEventBus

  constructor(ctx: Context, public config: ApiConfig) {
    super(ctx, 'api')
  }

  async [Service.init]() {
    if (!this.config.secrets?.length) throw new Error('api requires at least one signing secret')
    const sessions = createMemorySessionStore()
    const runs = createMemoryRunStore()
    const runEvents = createMemoryRunEventBus()
    const modelGateway = createModelGateway()
    const customProviders = this.config.customProviders ?? []
    for (const spec of customProviders) validateCustomProviderSpec(spec)
    if (customProviders.length) setCustomProviders(customProviders)
    const harnessId = this.config.defaultHarness ?? 'mock'
    let engine: Harness | undefined
    const registry = createHarnessRouter({
      defaultId: harnessId,
      ...(this.config.scopeId ? { orgScope: this.config.scopeId } : {}),
      ...(this.config.modelId ? { fallbackModelId: this.config.modelId } : {}),
      ...(this.config.harnessRoutes ? { routes: this.config.harnessRoutes } : {}),
    })
    registry.register(createMockHarness())
    const engineIds =
      this.config.engines?.length ?? false ? this.config.engines! : harnessId !== 'mock' ? [harnessId] : []
    const booted: Harness[] = []
    if (engineIds.includes('pi')) {
      const engine = createPiHarness({
        ...(this.config.modelId ? { modelId: this.config.modelId } : {}),
        ...(Object.keys(this.config.customProviderKeys ?? {}).length
          ? {
              resolveProviderKeys: async () => ({
                ...(this.config.anthropicApiKey ? { anthropic: this.config.anthropicApiKey } : {}),
                ...(this.config.openaiApiKey ? { openai: this.config.openaiApiKey } : {}),
                ...(this.config.openrouterApiKey ? { openrouter: this.config.openrouterApiKey } : {}),
                ...this.config.customProviderKeys,
              }),
            }
          : {}),
        ...(this.config.anthropicApiKey ? { apiKey: this.config.anthropicApiKey } : {}),
        ...(this.config.openaiApiKey ? { openaiApiKey: this.config.openaiApiKey } : {}),
        ...(this.config.openrouterApiKey ? { openrouterApiKey: this.config.openrouterApiKey } : {}),
      })
      registry.register(engine)
      booted.push(engine)
    }
    if (engineIds.includes('claude')) {
      const engine = createClaudeHarness({
        ...(this.config.modelId ? { defaultModelId: this.config.modelId } : {}),
        ...(this.config.anthropicApiKey
          ? { env: { ANTHROPIC_API_KEY: this.config.anthropicApiKey } }
          : {}),
      })
      registry.register(engine)
      booted.push(engine)
    }
    if (engineIds.includes('codex')) {
      const engine = createCodexHarness({
        ...(this.config.modelId ? { defaultModelId: this.config.modelId } : {}),
      })
      registry.register(engine)
      booted.push(engine)
    }
    if (engineIds.includes('opencode')) {
      const engine = createOpenCodeHarness({
        ...(this.config.modelId ? { defaultModelId: this.config.modelId } : {}),
        ...(this.config.anthropicApiKey ? { apiKey: this.config.anthropicApiKey } : {}),
        ...(this.config.openaiApiKey ? { openaiApiKey: this.config.openaiApiKey } : {}),
      })
      registry.register(engine)
      booted.push(engine)
    }
    engine = booted.find((candidate) => candidate.profile.id === harnessId) ?? booted[booted.length - 1]
    const resolution = devResolution(this.config)
    let toolFactory: OrchestratorDeps['tools'] | undefined
    const sandboxHandles = new Map<ScopeId, SandboxHandle>()
    const sandboxConfig = this.config.sandbox
    if (sandboxConfig && Object.keys(sandboxConfig).length > 0) {
      const sc = sandboxConfig
      const sandbox = createLocalSandbox({
        ...(sc.image ? { image: sc.image } : {}),
        ...(sc.dockerBin ? { dockerBin: sc.dockerBin } : {}),
        ...(sc.cpus !== undefined ? { cpus: sc.cpus } : {}),
        ...(sc.memoryMb !== undefined ? { memoryMb: sc.memoryMb } : {}),
        ...(sc.defaultTimeoutSec !== undefined ? { defaultTimeoutSec: sc.defaultTimeoutSec } : {}),
      })
      this.sandbox = sandbox
      toolFactory = async ({ scopeId }) => {
        let handle = sandboxHandles.get(scopeId)
        if (!handle) {
          handle = await sandbox.provision([{ scopeId, mountPath: 'global', mode: 'rw' }])
          sandboxHandles.set(scopeId, handle)
        }
        return createSandboxToolContext({
          sandbox,
          handle,
          scopeId,
          ...(sc.defaultTimeoutSec !== undefined ? { execTimeoutMs: sc.defaultTimeoutSec * 1000 } : {}),
          ...(sc.defaultTimeoutCeilingSec !== undefined
            ? { execTimeoutCeilingMs: sc.defaultTimeoutCeilingSec * 1000 }
            : {}),
        })
      }
    }
    const orchestrator = new OrchestratorService(this.ctx, {
      sessions,
      runs,
      harness: registry,
      identity: devIdentity(),
      resolution,
      rateLimiter: allowLimiter(),
      runEvents,
      modelGateway,
      ...(toolFactory ? { tools: toolFactory } : {}),
    })
    this.runs = runs
    this.sessions = sessions
    this.resolution = resolution
    this.orchestrator = orchestrator
    this.runEvents = runEvents
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
      try {
        await engine?.turns.close?.()
      } catch {
        void 0
      }
      if (this.sandbox) {
        for (const handle of sandboxHandles.values()) {
          try {
            await this.sandbox.teardown(handle, { destroy: true })
          } catch (err) {
            void err
          }
        }
        sandboxHandles.clear()
      }
    }
  }
}

export default ApiService

declare module '@qm/cordis' {
  interface Context {
    api: ApiService
  }
}
