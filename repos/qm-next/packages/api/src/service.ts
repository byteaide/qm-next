/**
 * The composition root: memory stores, harness registry (mock echo and, when
 * configured, the real pi engine over the model registry), dev admission
 * defaults, the orchestrator, the async run loop and the HTTP server wired
 * into one cordis service. This is assembly, not policy — production
 * deployments swap each piece without touching the others.
 */
import { Context, Service } from '@qm/cordis'
import { createMemoryDirectoryStore } from '@qm/directory'
import { createKeychain, deriveConnectorKey } from '@qm/credentials'
import { createClaudeHarness } from '@qm/harness-claude'
import { createCodexHarness } from '@qm/harness-codex'
import { createOpenCodeHarness } from '@qm/harness-opencode'
import { createPiHarness } from '@qm/harness-pi'
import { createModelGateway, setCustomProviders, validateCustomProviderSpec, type CustomProviderSpec } from '@qm/model'
import { createMemoryScopeMemory } from '@qm/memory'
import { createMemorySessionStateBus } from '@qm/runs'
import { createMemorySkillStore } from '@qm/skills'
import type { RuntimeRouteConfig } from '@qm/orchestrator'
import { createHarnessRouter, createMockHarness, createSandboxToolContext, OrchestratorService } from '@qm/orchestrator'
import Schema from '@qm/schemastery'
import { createLocalSandbox } from '@qm/sandbox'
import { createMemoryRunEventBus, createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import { createMemoryMap } from '@qm/store'
import { reachDirectory } from '@qm/reach'
import {
  createMemoryAdminService,
  createMemoryAuditLog,
  createMemoryBlobTransfer,
  createMemoryChannelPolicyStore,
  createMemoryConnectorTokenStore,
  createMemoryDeploymentLayerStore,
  createMemoryDeploymentStore,
  createMemoryEnvironmentRegistry,
  createMemoryEgressAuditSink,
  createMemoryFileStore,
  createMemoryGrantLedger,
  createMemoryProjectStore,
  createMemoryRuntimeConfigStore,
  createMemorySecretDropStore,
  createMemorySkillPackStore,
  createMemorySoulStore,
  createMemorySurfaceCacheStore,
  createMemoryUserModelCredentialsStore,
  createMemoryWebhookStore,
  createSurfaceContextQueue,
} from './services/index.ts'
import type { CronScheduler, CronStore } from '@qm/triggers'
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
  /** Directory sync surface (11.0): in-memory store behind the directory + reach routes. */
  directory?: boolean
  /**
   * Keychain surface (11.0): agent keychain behind the /v1/keychain routes.
   * Lane A backs it with memory maps; production swaps Postgres maps in.
   */
  keychain?: boolean
  /** Memory surface (11.0): scope memory behind the /v1/memory routes. */
  memory?: boolean
  /** Skills surface (11.0): skill registry behind the /v1/skills routes. */
  skills?: boolean
  /** Context surface (11.0): surface-context pull queue + channel policy routes. */
  context?: boolean
  /** Surface-cache surface (11.0): connector ingest + surface-cache policy routes. */
  surfaceCache?: boolean
  /** Environments surface (11.0): agent environment registry behind /v1/environments. */
  environments?: boolean
  /** Projects surface (11.0): web project store behind /v1/projects. */
  projects?: boolean
  /** Session-state surface (11.0): SSE stream over the session-state bus. */
  sessionState?: boolean
  /** Files surface (11.0): file list/content/upload over the blob transfer. */
  files?: boolean
  /** Grants surface (11.0): grant ledger behind /v1/grants (+ the share gate). */
  grants?: boolean
  /** Soul surface (11.0): per-scope soul behind /v1/soul. */
  soul?: boolean
  /** Config surface (11.0): surface-config/runtime-config/channel-header-pin. */
  config?: boolean
  /** Deployments surface (11.0): management lane behind /v1/deployments. */
  deployments?: boolean
  /** Deployment-layer surface (11.0): the CLI tools/skills bundle lane. */
  deploymentLayer?: boolean
  /** Connectors surface (11.0): connector token/OAuth surface. */
  connectors?: boolean
  /** Webhooks surface (11.0): webhook CRUD + raw incoming deliveries. */
  webhooks?: boolean
  /** Blobs surface (11.0): raw blob staging put/get. */
  blobs?: boolean
  /** Admin surface (11.0): qm admin lanes over lane-A stores. */
  admin?: boolean
  /** Bootstrap org admins when the admin surface is on. */
  admins?: string[]
  /** Skill-pack management (11.0). */
  skillPacks?: boolean
  /** Per-principal model credentials (11.0). */
  userModelAuth?: boolean
  /** Secret-drop links (11.0). */
  secretDrops?: boolean
  /** Emoji upload gate (11.0; uploader needs the browser session store). */
  emoji?: boolean
  /** Egress audit sink ingest (11.0). */
  egressAudit?: boolean
  /** Credential broker gate (11.0; service creds land with 12.0). */
  credentials?: boolean
  /** Auth broker claim/email-allowed gates (11.0). */
  authBroker?: boolean
  /** Public web base URL used for webhook inbound URLs. */
  publicUrl?: string
  /** Deploy apps domain for owner URLs (qm DEPLOY_APPS_DOMAIN). */
  deployAppsDomain?: string
  /** Static surface-config values served by GET /v1/surface-config. */
  surfaceConfig?: {
    webuiModels?: string[]
    baseModel?: string
    harnessId?: string
    externalSlackParticipants?: string[]
    branding?: { accent?: string; mark?: string; selfLabel?: string }
  }
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
  directory: Schema.boolean().description('Directory sync surface (11.0): in-memory store behind the directory + reach routes'),
  keychain: Schema.boolean().description('Keychain surface (11.0): agent keychain behind the /v1/keychain routes'),
  memory: Schema.boolean().description('Memory surface (11.0): scope memory behind the /v1/memory routes'),
  skills: Schema.boolean().description('Skills surface (11.0): skill registry behind the /v1/skills routes'),
  context: Schema.boolean().description('Context surface (11.0): surface-context queue + channel policy routes'),
  surfaceCache: Schema.boolean().description('Surface-cache surface (11.0): connector ingest + policy routes'),
  environments: Schema.boolean().description('Environments surface (11.0): agent environment registry'),
  projects: Schema.boolean().description('Projects surface (11.0): web project store'),
  sessionState: Schema.boolean().description('Session-state surface (11.0): SSE event stream'),
  files: Schema.boolean().description('Files surface (11.0): file list/content/upload'),
  grants: Schema.boolean().description('Grants surface (11.0): grant ledger + share gate'),
  soul: Schema.boolean().description('Soul surface (11.0): per-scope soul'),
  config: Schema.boolean().description('Config surface (11.0): surface-config/runtime-config/channel-header-pin'),
  deployments: Schema.boolean().description('Deployments surface (11.0): management lane'),
  deploymentLayer: Schema.boolean().description('Deployment-layer surface (11.0): CLI bundle lane'),
  connectors: Schema.boolean().description('Connectors surface (11.0): connector tokens + OAuth gates'),
  webhooks: Schema.boolean().description('Webhooks surface (11.0): webhook CRUD + raw incoming'),
  blobs: Schema.boolean().description('Blobs surface (11.0): raw blob staging'),
  admin: Schema.boolean().description('Admin surface (11.0): qm admin lanes'),
  admins: Schema.array(Schema.string()).description('Bootstrap org admins (principal ids)'),
  skillPacks: Schema.boolean().description('Skill-pack management (11.0)'),
  userModelAuth: Schema.boolean().description('Per-principal model credentials (11.0)'),
  secretDrops: Schema.boolean().description('Secret-drop links (11.0)'),
  emoji: Schema.boolean().description('Emoji upload gate (11.0)'),
  egressAudit: Schema.boolean().description('Egress audit sink ingest (11.0)'),
  credentials: Schema.boolean().description('Credential broker gate (11.0)'),
  authBroker: Schema.boolean().description('Auth broker gates (11.0)'),
  publicUrl: Schema.string().description('Public web base URL for webhook inbound URLs'),
  deployAppsDomain: Schema.string().description('Deploy apps domain for deployment owner URLs'),
  surfaceConfig: Schema.any().description('Static surface-config values for GET /v1/surface-config'),
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

  /**
   * Cron runtime (store + scheduler) injected by the triggers plugin after
   * it boots; the parity cron routes read it lazily per request, so late
   * injection is fine. Routes 404 while absent.
   */
  cronsRuntime?: { crons: CronStore; scheduler?: CronScheduler } | undefined

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
    // Parity surface (11.0): directory + reach behind an opt-in store; cron
    // routes always register and 404 per request until the triggers plugin
    // injects its runtime into `cronsRuntime`.
    const directoryStore = this.config.directory ? createMemoryDirectoryStore() : undefined
    const keychain = this.config.keychain
      ? createKeychain({
          creds: createMemoryMap(),
          grants: createMemoryMap(),
          asks: createMemoryMap(),
          key: deriveConnectorKey(this.config.secrets[0]!),
          orgId: () => (this.config.scopeId ?? 'org:default').replace(/^org:/, ''),
        })
      : undefined
    const memoryStore = this.config.memory ? createMemoryScopeMemory() : undefined
    const skillStore = this.config.skills ? createMemorySkillStore() : undefined
    const contextQueue = this.config.context ? createSurfaceContextQueue() : undefined
    const channelPolicyStore =
      this.config.context || this.config.surfaceCache ? createMemoryChannelPolicyStore() : undefined
    const surfaceCacheStore = this.config.surfaceCache ? createMemorySurfaceCacheStore() : undefined
    const environmentRegistry = this.config.environments ? createMemoryEnvironmentRegistry() : undefined
    const projectStore = this.config.projects
      ? createMemoryProjectStore({ orgId: (this.config.scopeId ?? 'org:default').replace(/^org:/, '') })
      : undefined
    const sessionStateBus = this.config.sessionState ? createMemorySessionStateBus() : undefined
    const grantLedger = this.config.grants || this.config.files || this.config.deployments ? createMemoryGrantLedger() : undefined
    const blobTransfer = this.config.blobs || this.config.files ? createMemoryBlobTransfer() : undefined
    const fileStore = this.config.files ? createMemoryFileStore({ blobTransfer: blobTransfer!, grants: grantLedger! }) : undefined
    const soulStore = this.config.soul
      ? createMemorySoulStore((this.config.scopeId ?? 'org:default').replace(/^org:/, ''))
      : undefined
    const runtimeConfigStore = this.config.config ? createMemoryRuntimeConfigStore() : undefined
    const deploymentStore = this.config.deployments ? createMemoryDeploymentStore({ grants: grantLedger! }) : undefined
    const deploymentLayerStore = this.config.deploymentLayer ? createMemoryDeploymentLayerStore() : undefined
    const connectorTokens = this.config.connectors ? createMemoryConnectorTokenStore() : undefined
    const webhookStore = this.config.webhooks ? createMemoryWebhookStore() : undefined
    const orgId = (this.config.scopeId ?? 'org:default').replace(/^org:/, '')
    const adminService = this.config.admin
      ? createMemoryAdminService({ orgId, ...(this.config.admins?.length ? { seedAdmins: this.config.admins } : {}) })
      : undefined
    const skillPackStore = this.config.skillPacks ? createMemorySkillPackStore() : undefined
    const userModelCredentials = this.config.userModelAuth ? createMemoryUserModelCredentialsStore() : undefined
    const secretDropStore = this.config.secretDrops ? createMemorySecretDropStore() : undefined
    const egressAuditSink = this.config.egressAudit ? createMemoryEgressAuditSink() : undefined
    const adminAuditLog = this.config.admin ? createMemoryAuditLog() : undefined
    const app = createApiServer(
      {
        orchestrator,
        sessions,
        runs,
        resolution,
        // Parity surface (11.0): sessions/conversations ride the session
        // store every deployment already has.
        surface: {
          sessions,
          orchestrator,
          scopeFor: () => this.config.scopeId ?? 'org:default',
        },
        ...(directoryStore ? { directory: { directory: directoryStore }, reach: { directory: directoryStore } } : {}),
        ...(keychain ? { keychain: { keychain: () => keychain, scopeFor: (actorId) => `personal:${actorId}` } } : {}),
        ...(memoryStore ? { memory: { memory: memoryStore, scopeFor: () => this.config.scopeId ?? 'org:default' } } : {}),
        ...(skillStore ? { skills: { skills: skillStore, scopeFor: () => this.config.scopeId ?? 'org:default' } } : {}),
        ...(contextQueue
          ? {
              context: { queue: contextQueue },
              contextPolicy: { ...(channelPolicyStore ? { channelPolicy: channelPolicyStore } : {}) },
            }
          : {}),
        ...(surfaceCacheStore && channelPolicyStore
          ? {
              surfaceCache: {
                cache: surfaceCacheStore,
                policy: (container: string) => channelPolicyStore.get(container),
                setPolicy: (container: string, orders: string, setBy?: string) =>
                  channelPolicyStore.set(container, orders, { ...(setBy ? { setBy } : {}) }),
              },
            }
          : {}),
        ...(environmentRegistry ? { environments: { environments: environmentRegistry } } : {}),
        ...(projectStore ? { projects: { projects: projectStore } } : {}),
        ...(sessionStateBus ? { sessionState: { bus: sessionStateBus } } : {}),
        ...(fileStore ? { files: { files: fileStore, blobTransfer: blobTransfer! } } : {}),
        ...(grantLedger ? { grants: { grants: grantLedger } } : {}),
        ...(soulStore ? { soul: { soul: soulStore } } : {}),
        ...(runtimeConfigStore
          ? {
              config: {
                config: runtimeConfigStore,
                ...(this.config.surfaceConfig ? { surfaceConfig: this.config.surfaceConfig } : {}),
              },
            }
          : {}),
        ...(deploymentStore
          ? {
              deployments: {
                deployments: deploymentStore,
                ...(this.config.deployAppsDomain ? { deployAppsDomain: this.config.deployAppsDomain } : {}),
              },
            }
          : {}),
        ...(deploymentLayerStore ? { deploymentLayer: { deploymentLayer: deploymentLayerStore } } : {}),
        ...(connectorTokens ? { connectors: { tokens: connectorTokens } } : {}),
        ...(webhookStore
          ? {
              webhooks: {
                webhooks: webhookStore,
                ...(this.config.publicUrl ? { publicUrl: this.config.publicUrl } : {}),
              },
            }
          : {}),
        ...(blobTransfer ? { blobs: { blobTransfer } } : {}),
        ...(adminService
          ? {
              admin: {
                admin: adminService,
                orgScope: this.config.scopeId ?? 'org:default',
                sessions,
                runs,
                ...(memoryStore ? { memory: memoryStore } : {}),
                ...(fileStore ? { files: fileStore, blobTransfer: blobTransfer! } : {}),
                ...(deploymentStore ? { deployments: deploymentStore } : {}),
                ...(skillStore ? { skills: skillStore } : {}),
                ...(skillPackStore ? { skillPacks: skillPackStore } : {}),
                crons: () => this.cronsRuntime?.crons,
                ...(directoryStore ? { directory: directoryStore } : {}),
                ...(environmentRegistry ? { environments: environmentRegistry } : {}),
                ...(egressAuditSink ? { egressAudit: egressAuditSink } : {}),
                ...(adminAuditLog ? { auditLog: adminAuditLog } : {}),
              },
            }
          : {}),
        ...(skillPackStore && adminService ? { skillPacks: { packs: skillPackStore, ...(skillStore ? { skills: skillStore } : {}), orgScope: this.config.scopeId ?? 'org:default', admins: adminService } } : {}),
        ...(userModelCredentials ? { userModelAuth: { credentials: userModelCredentials } } : {}),
        ...(secretDropStore ? { secretDrops: { drops: secretDropStore } } : {}),
        ...(this.config.emoji ? { emoji: true } : {}),
        ...(egressAuditSink ? { egressAudit: { sink: egressAuditSink } } : {}),
        ...(this.config.credentials ? { credentials: true } : {}),
        ...(this.config.authBroker ? { authBroker: true } : {}),
        crons: {
          crons: () => this.cronsRuntime?.crons,
          scheduler: () => this.cronsRuntime?.scheduler,
          ...(directoryStore
            ? {
                reach: reachDirectory(directoryStore),
                scopeFor: () => this.config.scopeId ?? 'org:default',
              }
            : {}),
        },
      },
      { secrets: this.config.secrets },
    )
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
