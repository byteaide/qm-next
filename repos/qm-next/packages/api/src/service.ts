/**
 * The composition root: memory stores, harness registry (mock echo and, when
 * configured, the real pi engine over the model registry), dev admission
 * defaults, the orchestrator, the async run loop and the HTTP server wired
 * into one cordis service. This is assembly, not policy — production
 * deployments swap each piece without touching the others.
 */
import { Context, Service } from '@qm/cordis'
import {
  bootAdminGrantSeed,
  createAdminGrantStore,
  createAuditLog,
  createCredentialUsageSink,
  createErrorLog,
  createEgressAuditSink,
  createMemoryAdminGrantPersistence,
  createMetricsSink,
  createPostgresAdminGrantStore,
  createPostgresAuditLog,
  createPostgresCredentialUsageSink,
  createPostgresEgressAuditSink,
  createPostgresErrorLog,
  createPostgresMetricsSink,
  type AuditLog,
  type CredentialUsageSink,
  type ErrorLog,
  type EgressAuditSink,
  type MetricsSink,
} from '@qm/admin'
import { createMemoryReplayDedupe, createPostgresReplayDedupe, type ReplayDedupe } from '@qm/auth'
import {
  createMemoryAckEmojiPickStore,
  createMemoryAgentRequestStore,
  createMemoryAmbientJudgmentStore,
  createMemoryApprovalStore,
  createPostgresApprovalStore,
  type AckEmojiPickStore,
  type AgentRequestStore,
  type AmbientCursorStore,
  type AmbientJudgmentStore,
  type ApprovalStore,
} from '@qm/approvals'
import { createMemoryDirectoryStore, createPostgresDirectoryStore, type DirectoryStore } from '@qm/directory'
import { createKeychain, createDeviceFlowCutoverStore, deriveConnectorKey, type DeviceFlowCutoverStore } from '@qm/credentials'
import type { ImDeliveryQueue } from '@qm/im-core'
import type { Keychain } from '@qm/types'
import { createClaudeHarness } from '@qm/harness-claude'
import { createCodexHarness } from '@qm/harness-codex'
import { createOpenCodeHarness } from '@qm/harness-opencode'
import { createPiHarness } from '@qm/harness-pi'
import {
  createCustomProviderStore,
  createModelCredentialStore,
  createModelGateway,
  setCustomProviders,
  validateCustomProviderSpec,
  type CustomProviderSpec,
  type CustomProviderStore,
  type ModelCredentialStore,
} from '@qm/model'
import { createMemoryScopeMemory } from '@qm/memory'
import { createMcpServerStore, createMcpToolService, type McpServerStore, type McpToolService } from '@qm/mcp'
import {
  createBrowserSessionStore,
  createConsentLinkStore,
  createOAuthFlowStore,
  type BrowserSessionStore,
  type ConsentLinkStore,
  type OAuthFlowStore,
} from '@qm/connectors'
import { createMemorySessionStateBus } from '@qm/runs'
import { createMemorySkillStore } from '@qm/skills'
import type { RuntimeRouteConfig } from '@qm/orchestrator'
import { createHarnessRouter, createMockHarness, createSandboxToolContext, OrchestratorService } from '@qm/orchestrator'
import Schema from '@qm/schemastery'
import { createLocalSandbox } from '@qm/sandbox'
import {
  createMemoryRunEventBus,
  createMemoryRunStore,
  createMemorySessionStore,
  createPgPool,
  createPostgresMap,
  createPostgresRunStore,
  createPostgresSessionStore,
  createLocalByteStore,
  createMemoryByteStore,
  type DurableByteStore,
  type PgPool,
} from '@qm/store'
import { createMemoryMap } from '@qm/store'
import { reachDirectory } from '@qm/reach'
import {
  createMemoryAdminService,
  createMemoryBlobTransfer,
  createMemoryChannelPolicyStore,
  createMemoryConnectorTokenStore,
  createMemoryDeploymentLayerStore,
  createMemoryDeploymentStore,
  createMemoryEnvironmentRegistry,
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
  createPostgresChannelPolicyStore,
  createPostgresFileStore,
  createPostgresSlackMap,
  createSurfaceContextQueue,
  createWebhookStore,
} from './services/index.ts'
import { createAmbientCursorStore, createPostgresAckEmojiPickStore, createPostgresAgentRequestStore, createPostgresAmbientJudgmentStore } from './services/ambient-stores.ts'
import type { ChannelPolicyStore as ApiChannelPolicyStore } from './services/channel-policy-store.ts'
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
  /** Admin surface (11.0): qm admin lanes over the 12.0 control plane. */
  admin?: boolean
  /** Bootstrap org admins when the admin surface is on. */
  admins?: string[]
  /** qm ADMIN_GRANTS grammar (`principal:role,…`) seeding durable grant stores. */
  adminGrants?: string
  /** Postgres connection string; durable-by-default swaps every memory store for its PG twin. */
  databaseUrl?: string
  /**
   * File blob bytes root directory (20.0): content-addressed `files/<sha256>`
   * keys under this dir; without it (and with databaseUrl) bytes stay in RAM.
   */
  filesDir?: string
  /** Ambient observability (14.0): judgment + cursor stores for the IM ambient slice. */
  ambient?: boolean
  /** Agent-request directives (14.0): durable registry for IM reply directives. */
  agentRequests?: boolean
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
  /** Admin console (12.0): qm SPA shell + /api proxy under /admin/ui. */
  adminUi?: boolean
  /** Portal identity secret; without it the admin console trusts the dev `admin` cookie. */
  portalIdentitySecret?: string
  /** Portal SSO (12.0): /auth/* ladder + the /admin/ui identity-issuing gate. */
  portal?: boolean
  /** Public base URL of the portal (redirects, cookie Secure flag). */
  portalPublicUrl?: string
  /** Portal session cookie sealing secret (32+ chars; a dev fallback is derived when unset). */
  portalSessionSecret?: string
  /** Portal session TTL seconds (default 28800 = 8h). */
  portalSessionTtlS?: number
  /** OIDC provider config (qm plugins/portal OIDC_* env as one object). */
  portalOidc?: {
    authEndpoint?: string
    tokenEndpoint?: string
    userinfoEndpoint?: string
    clientId: string
    clientSecret?: string
    scopes?: string
    issuer?: string
    jwksUri?: string
    expectedTeamId?: string
  }
  /** Portal principal rule: 'email' (default) or 'sub'. */
  portalPrincipalClaim?: string
  /** Portal allow-list: email domain gate (requires the email claim). */
  portalAllowedEmailDomain?: string
  /** Portal allow-list: explicit email addresses. */
  portalAllowedEmails?: string[]
  /** Local dev bypass: loopback requests get a session without OIDC (non-local publicUrl refuses). */
  portalLocalAuthBypass?: boolean
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
  adminGrants: Schema.string().description('qm ADMIN_GRANTS grammar (principal:role,...) seeding durable grant stores'),
  databaseUrl: Schema.string().description('Postgres connection string; swaps memory stores for durable PG twins'),
  filesDir: Schema.string().description('File blob bytes root directory; content-addressed files/<sha256> keys'),
  ambient: Schema.boolean().description('Ambient observability (14.0): judgment + cursor stores for the IM ambient slice'),
  agentRequests: Schema.boolean().description('Agent-request directives (14.0): durable registry for IM reply directives'),
  skillPacks: Schema.boolean().description('Skill-pack management (11.0)'),
  userModelAuth: Schema.boolean().description('Per-principal model credentials (11.0)'),
  secretDrops: Schema.boolean().description('Secret-drop links (11.0)'),
  emoji: Schema.boolean().description('Emoji upload gate (11.0)'),
  egressAudit: Schema.boolean().description('Egress audit sink ingest (11.0)'),
  credentials: Schema.boolean().description('Credential broker gate (11.0)'),
  authBroker: Schema.boolean().description('Auth broker gates (11.0)'),
  adminUi: Schema.boolean().description('Admin console (12.0): qm SPA shell + /api proxy under /admin/ui'),
  portalIdentitySecret: Schema.string().description('Portal identity secret; without it the admin console trusts the dev admin cookie'),
  portal: Schema.boolean().description('Portal SSO (12.0): /auth/* ladder + the /admin/ui identity-issuing gate'),
  portalPublicUrl: Schema.string().description('Public base URL of the portal (redirects, cookie Secure flag)'),
  portalSessionSecret: Schema.string().description('Portal session cookie sealing secret (32+ chars)'),
  portalSessionTtlS: Schema.number().description('Portal session TTL seconds (default 28800)'),
  portalOidc: Schema.any().description('OIDC provider config (authEndpoint/tokenEndpoint/userinfoEndpoint/clientId/clientSecret/scopes/issuer/jwksUri/expectedTeamId)'),
  portalPrincipalClaim: Schema.string().description("Portal principal rule: 'email' (default) or 'sub'"),
  portalAllowedEmailDomain: Schema.string().description('Portal allow-list: email domain gate'),
  portalAllowedEmails: Schema.array(Schema.string()).description('Portal allow-list: explicit email addresses'),
  portalLocalAuthBypass: Schema.boolean().description('Local dev bypass: loopback requests get a session without OIDC'),
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

  /**
   * The Fastify app; the web-ui convergence relays to the parity lanes
   * through in-process injects against this instance (13.0).
   */
  app!: ReturnType<typeof createApiServer>

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
   * injection is fine. Routes 404 while absent. `deliveries` is the
   * bridge's delivery queue — consent/edit notices and the admin shadow
   * view ride it.
   */
  cronsRuntime?: { crons: CronStore; scheduler?: CronScheduler; deliveries?: ImDeliveryQueue } | undefined

  /**
   * Ambient ingredients (14.0): the default harness's judge port for the
   * IM ambient slice, plus the judgment/cursor stores (durable when
   * databaseUrl is set) and the shared channel-policy store. The
   * im-bridge consumes all three; each stays undefined while its
   * configuring flag is off, and the bridge stays inert accordingly.
   */
  ambientJudge?: { judge(systemPrompt: string, prompt: string): Promise<string | undefined>; model?: string }
  ambientCursors?: AmbientCursorStore
  ambientJudgments?: AmbientJudgmentStore
  channelPolicy?: ApiChannelPolicyStore
  /** Reaction-as-ack ingredients (14.0): the harness emoji picker + pick records. */
  ackEmoji?: { pick(text: string, candidates: readonly string[]): Promise<string | undefined> }
  ackPicks?: AckEmojiPickStore
  /** The synced directory (when configured); the im-bridge resolves DMs from it. */
  directory?: DirectoryStore
  /** Durable agent-request registry (14.0): the bridge records reply directives here. */
  agentRequests?: AgentRequestStore
  /**
   * Keychain instance (14.0): the im-bridge ask-resolution sweep polls it
   * for resolved-but-unnotified asks; routes keep their lazy accessor.
   */
  keychain?: Keychain

  /** Approval store (20.0): one instance shared with the IM bridge; durable with databaseUrl. */
  approvals?: ApprovalStore

  /** Model credential registry (20.0): provider API keys over the `model_credentials` map. */
  modelCredentials?: ModelCredentialStore

  /** Custom provider registry (20.0): over the `custom_model_providers` map. */
  customProviderRegistry?: CustomProviderStore

  /** Device-flow cutover policies (20.0): over the qm-named cutover maps. */
  deviceFlowCutover?: DeviceFlowCutoverStore

  /** Connector OAuth round-trip stores (20.0), present with the connectors surface. */
  oauthFlows?: OAuthFlowStore
  consentLinks?: ConsentLinkStore
  browserSessions?: BrowserSessionStore

  /** MCP registry + agent-tool bridge (20.0), present with the admin surface. */
  mcpServers?: McpServerStore
  mcpToolService?: McpToolService

  constructor(ctx: Context, public config: ApiConfig) {
    super(ctx, 'api')
  }

  async [Service.init]() {
    if (!this.config.secrets?.length) throw new Error('api requires at least one signing secret')
    // Durable-by-default (20.0 twin sweep): every store below swaps to its
    // Postgres twin when databaseUrl is set; memory stays the test/dev
    // default. The shared pool owns no DDL — schema belongs to each store
    // constructor (migration preflight relies on that).
    const databaseUrl = this.config.databaseUrl
    const pg: PgPool | undefined = databaseUrl ? createPgPool(databaseUrl, []) : undefined
    const pgClosers: Array<{ close?(): Promise<void> }> = []
    // DurableMap tables are created lazily on first use; warm them at boot
    // so "start once against an empty database" lands the full schema (the
    // migration runbook's target-bootstrap step relies on this).
    const pgWarmups: Array<{ entries(): Promise<unknown> }> = []
    const pgMap = <T>(table: string) => {
      if (!pg) throw new Error(`pgMap(${table}) requires databaseUrl`)
      const map = createPostgresMap<T>(pg, table)
      pgWarmups.push(map)
      return map
    }
    const sessions = databaseUrl ? createPostgresSessionStore(databaseUrl) : createMemorySessionStore()
    const runs = databaseUrl ? createPostgresRunStore(databaseUrl) : createMemoryRunStore()
    if (databaseUrl) {
      pgClosers.push(sessions as unknown as { close?(): Promise<void> }, runs as unknown as { close?(): Promise<void> })
    }
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
    const defaultJudge = registry.get(harnessId)?.models.judge
    if (defaultJudge) this.ambientJudge = { judge: defaultJudge }
    const defaultPick = registry.get(harnessId)?.models.pickAckEmoji
    if (defaultPick) this.ackEmoji = { pick: defaultPick }
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
    const orgId = (this.config.scopeId ?? 'org:default').replace(/^org:/, '')
    const directoryStore = this.config.directory
      ? databaseUrl
        ? createPostgresDirectoryStore(databaseUrl)
        : createMemoryDirectoryStore()
      : undefined
    if (databaseUrl && directoryStore) pgClosers.push(directoryStore as DirectoryStore & { close(): Promise<void> })
    const keychain = this.config.keychain
      ? createKeychain({
          creds: databaseUrl ? pgMap('keychain_credentials') : createMemoryMap(),
          grants: databaseUrl ? pgMap('keychain_grants') : createMemoryMap(),
          asks: databaseUrl ? pgMap('keychain_asks') : createMemoryMap(),
          key: deriveConnectorKey(this.config.secrets[0]!),
          orgId: () => orgId,
        })
      : undefined
    const memoryStore = this.config.memory ? createMemoryScopeMemory() : undefined
    const skillStore = this.config.skills ? createMemorySkillStore() : undefined
    const contextQueue = this.config.context ? createSurfaceContextQueue() : undefined
    const channelPolicyStore =
      this.config.context || this.config.surfaceCache
        ? databaseUrl
          ? createPostgresChannelPolicyStore(databaseUrl, { orgId })
          : createMemoryChannelPolicyStore()
        : undefined
    const surfaceCacheStore = this.config.surfaceCache ? createMemorySurfaceCacheStore() : undefined
    const environmentRegistry = this.config.environments ? createMemoryEnvironmentRegistry() : undefined
    const projectStore = this.config.projects ? createMemoryProjectStore({ orgId }) : undefined
    const sessionStateBus = this.config.sessionState ? createMemorySessionStateBus() : undefined
    const grantLedger = this.config.grants || this.config.files || this.config.deployments ? createMemoryGrantLedger() : undefined
    const blobTransfer = this.config.blobs || this.config.files ? createMemoryBlobTransfer() : undefined
    // Files (20.0 twin lane): with databaseUrl the metadata lands in the
    // qm-shaped `file_artifacts` table and bytes go through the
    // content-addressed byte store (`filesDir` for the FS backend; without
    // it bytes stay in RAM and a warning says so).
    let byteStore: DurableByteStore | undefined
    if (this.config.files || this.config.blobs) {
      if (this.config.filesDir) {
        byteStore = createLocalByteStore(this.config.filesDir)
      } else {
        if (databaseUrl) this.ctx.logger.warn('api: databaseUrl set but filesDir missing — file bytes stay in RAM')
        byteStore = createMemoryByteStore()
      }
    }
    const fileStore = this.config.files
      ? databaseUrl && byteStore
        ? createPostgresFileStore({ databaseUrl, byteStore, grants: grantLedger! })
        : createMemoryFileStore({ blobTransfer: blobTransfer!, grants: grantLedger! })
      : undefined
    const soulStore = this.config.soul ? createMemorySoulStore(orgId) : undefined
    const runtimeConfigStore = this.config.config ? createMemoryRuntimeConfigStore() : undefined
    const deploymentStore = this.config.deployments ? createMemoryDeploymentStore({ grants: grantLedger! }) : undefined
    const deploymentLayerStore = this.config.deploymentLayer ? createMemoryDeploymentLayerStore() : undefined
    const connectorTokens = this.config.connectors ? createMemoryConnectorTokenStore() : undefined
    const webhookStore = this.config.webhooks
      ? databaseUrl
        ? createWebhookStore(pgMap('webhooks'))
        : createMemoryWebhookStore()
      : undefined
    // Control-plane sinks (12.0): durable-by-default — Postgres twins when
    // databaseUrl is set, in-memory rings otherwise.
    let metrics: MetricsSink | undefined
    let errors: ErrorLog | undefined
    let credentialUsage: CredentialUsageSink | undefined
    let egressAuditSink: EgressAuditSink | undefined
    let adminAuditLog: AuditLog | undefined
    let replayDedupe: ReplayDedupe | undefined
    const adminGrantStore =
      this.config.admin || this.config.authBroker || this.config.credentials
        ? createAdminGrantStore(
            databaseUrl ? createPostgresAdminGrantStore(databaseUrl) : createMemoryAdminGrantPersistence(),
            {
              seed: this.config.admins?.length
                ? this.config.admins.map((principalId) => ({ principalId, scopeId: `org:${orgId}`, role: 'org_admin' as const }))
                : bootAdminGrantSeed(this.config.adminGrants, orgId, Boolean(databaseUrl)),
            },
          )
        : undefined
    const adminService = adminGrantStore
      ? createMemoryAdminService({
          orgId,
          grants: adminGrantStore,
          ...(pg ? { slackMap: createPostgresSlackMap(pg) } : {}),
        })
      : undefined
    if (this.config.admin || databaseUrl) {
      // Observability completion (20.0): with a durable backend the sinks
      // exist whether or not the admin console is on — audit, metrics and
      // error records are operational data, not console features.
      metrics = databaseUrl ? createPostgresMetricsSink(databaseUrl) : createMetricsSink()
      errors = databaseUrl ? createPostgresErrorLog(databaseUrl) : createErrorLog()
      credentialUsage = databaseUrl ? createPostgresCredentialUsageSink(databaseUrl) : createCredentialUsageSink()
      egressAuditSink = databaseUrl ? createPostgresEgressAuditSink(databaseUrl) : createEgressAuditSink()
      adminAuditLog = databaseUrl ? createPostgresAuditLog(databaseUrl) : createAuditLog()
    }
    if (this.config.egressAudit && !egressAuditSink) {
      egressAuditSink = databaseUrl ? createPostgresEgressAuditSink(databaseUrl) : createEgressAuditSink()
    }
    if (this.config.credentials) {
      credentialUsage =
        credentialUsage ?? (databaseUrl ? createPostgresCredentialUsageSink(databaseUrl) : createCredentialUsageSink())
      adminAuditLog = adminAuditLog ?? (databaseUrl ? createPostgresAuditLog(databaseUrl) : createAuditLog())
    }
    if (this.config.authBroker) {
      replayDedupe = replayDedupe ?? (databaseUrl ? createPostgresReplayDedupe(databaseUrl) : createMemoryReplayDedupe())
    }
    if (this.config.ambient) {
      this.ambientJudgments = databaseUrl
        ? createPostgresAmbientJudgmentStore(databaseUrl, orgId)
        : createMemoryAmbientJudgmentStore()
      this.ambientCursors = createAmbientCursorStore(databaseUrl, orgId)
      this.ackPicks = databaseUrl ? createPostgresAckEmojiPickStore(databaseUrl, orgId) : createMemoryAckEmojiPickStore()
    }
    if (channelPolicyStore) this.channelPolicy = channelPolicyStore
    if (directoryStore) this.directory = directoryStore
    if (keychain) this.keychain = keychain
    if (this.config.agentRequests) {
      this.agentRequests = databaseUrl
        ? createPostgresAgentRequestStore(databaseUrl, orgId)
        : createMemoryAgentRequestStore()
    }
    // Approval store (20.0 twin lane): always constructed so the IM bridge
    // shares one instance; durable as soon as databaseUrl is set.
    this.approvals = databaseUrl ? createPostgresApprovalStore(databaseUrl) : createMemoryApprovalStore()
    if (databaseUrl && this.approvals) pgClosers.push(this.approvals as ApprovalStore & { close(): Promise<void> })
    // Model/credential registries (20.0 twin lane): qm-shaped DurableMap
    // stores (`model_credentials`, `custom_model_providers`) so a migration
    // blob-copies rows; consumers (harness key resolution) attach later.
    const keyMaterial = this.config.secrets[0]!
    this.modelCredentials = createModelCredentialStore({
      backing: databaseUrl ? pgMap('model_credentials') : createMemoryMap(),
      keyMaterial,
    })
    this.customProviderRegistry = createCustomProviderStore({
      backing: databaseUrl ? pgMap('custom_model_providers') : createMemoryMap(),
      keyMaterial,
    })
    this.deviceFlowCutover = createDeviceFlowCutoverStore(
      databaseUrl ? pgMap('device_flow_cutover') : createMemoryMap(),
      { orgId, ...(databaseUrl ? { resets: pgMap('device_flow_cutover_resets') } : {}) },
    )
    // Connector OAuth/browser-session stores (20.0 twin lane): constructed
    // with the connectors surface so the tables exist for migration
    // (routes attach in a later lane).
    if (this.config.connectors) {
      const browserKey = deriveConnectorKey(keyMaterial, 'browser-sessions')
      this.oauthFlows = createOAuthFlowStore(databaseUrl ? pgMap('oauth_flows') : createMemoryMap())
      this.consentLinks = createConsentLinkStore(databaseUrl ? pgMap('consent_links') : createMemoryMap())
      this.browserSessions = createBrowserSessionStore({
        sessions: databaseUrl ? pgMap('browser_sessions') : createMemoryMap(),
        key: browserKey,
      })
    }
    // MCP registry (20.0 twin lane): the admin routes light up when the
    // admin surface is on; the store table exists for migration either way.
    if (this.config.admin) {
      this.mcpServers = createMcpServerStore(databaseUrl ? pgMap('mcp_servers') : createMemoryMap())
      this.mcpToolService = createMcpToolService({
        servers: this.mcpServers,
        ...(adminAuditLog ? { audit: adminAuditLog } : {}),
      })
    }
    // Constructor-only store twins (20.0 C.3 close-out): tasks, ACL and
    // run observability stores have no routes yet (16.0 built the stores,
    // consumers attach later) — construct them so their tables land at
    // boot and the migration copies rows instead of reporting gaps.
    if (databaseUrl) {
      const { createPostgresTaskStore } = await import('@qm/tasks')
      const { createPostgresGrantStore } = await import('@qm/acl')
      const { createPostgresRunActivityStore, createPostgresRunSignalStore } = await import('@qm/runs')
      const { createPostgresReplayDedupe } = await import('@qm/auth')
      // ACL grant store owns a pool but exposes no close (process-exit
      // cleanup, like the admin sinks).
      createPostgresGrantStore(databaseUrl)
      pgClosers.push(
        createPostgresTaskStore(databaseUrl),
        createPostgresRunSignalStore(databaseUrl),
        createPostgresRunActivityStore(databaseUrl),
      )
      replayDedupe = createPostgresReplayDedupe(databaseUrl)
    }
    // Monitoring (20.0): readiness probe + panel-shaped summary inputs.
    const startedAt = Date.now()
    const monitoring = {
      startedAt,
      ...(pg
        ? {
            pingDatabase: async () => {
              await pg.q('SELECT 1')
              return true
            },
          }
        : {}),
      deliveryQueueDurable: Boolean(databaseUrl),
      deliveries: () => this.cronsRuntime?.deliveries,
      ...(metrics ? { metrics } : {}),
      ...(errors ? { errors } : {}),
      ...(adminAuditLog ? { auditLog: adminAuditLog } : {}),
      ...(credentialUsage ? { credentialUsage } : {}),
      crons: () => this.cronsRuntime?.crons,
    }
    for (const map of pgWarmups) await map.entries()
    const skillPackStore = this.config.skillPacks ? createMemorySkillPackStore() : undefined
    const userModelCredentials = this.config.userModelAuth ? createMemoryUserModelCredentialsStore() : undefined
    const secretDropStore = this.config.secretDrops ? createMemorySecretDropStore() : undefined
    const app = createApiServer(
      {
        orchestrator,
        sessions,
        runs,
        resolution,
        ...(monitoring ? { monitoring } : {}),
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
        ...(grantLedger
          ? {
              grants: {
                grants: grantLedger,
                orgScope: this.config.scopeId ?? 'org:default',
                ...(fileStore ? { files: fileStore } : {}),
                ...(directoryStore ? { directory: directoryStore } : {}),
              },
            }
          : {}),
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
                deliveries: () => this.cronsRuntime?.deliveries,
                ...(directoryStore ? { directory: directoryStore } : {}),
                ...(environmentRegistry ? { environments: environmentRegistry } : {}),
                ...(egressAuditSink ? { egressAudit: egressAuditSink } : {}),
                ...(adminAuditLog ? { auditLog: adminAuditLog } : {}),
                ...(metrics ? { metrics } : {}),
                ...(errors ? { errors } : {}),
                ...(credentialUsage ? { credentialUsage } : {}),
                 ...(this.ambientJudgments ? { ambientJudgments: this.ambientJudgments } : {}),
                 ...(this.ackPicks ? { ackEmojiPicks: this.ackPicks } : {}),
                 ...(this.mcpServers && this.mcpToolService
                   ? { mcp: { servers: this.mcpServers, toolService: this.mcpToolService } }
                   : {}),
                 ...(monitoring ? { monitoring } : {}),
               },
            }
          : {}),
        ...(skillPackStore && adminService ? { skillPacks: { packs: skillPackStore, ...(skillStore ? { skills: skillStore } : {}), orgScope: this.config.scopeId ?? 'org:default', admins: adminService } } : {}),
        ...(userModelCredentials ? { userModelAuth: { credentials: userModelCredentials } } : {}),
        ...(secretDropStore ? { secretDrops: { drops: secretDropStore, ...(this.config.publicUrl ? { publicUrl: this.config.publicUrl } : {}), orgId } } : {}),
        ...(this.config.emoji ? { emoji: true } : {}),
        ...(egressAuditSink ? { egressAudit: { sink: egressAuditSink } } : {}),
        ...(this.config.credentials
          ? {
              credentials: {
                orgScope: this.config.scopeId ?? 'org:default',
                ...(keychain ? { reader: keychain } : {}),
                ...(credentialUsage ? { usage: credentialUsage } : {}),
                ...(adminAuditLog ? { auditLog: adminAuditLog } : {}),
              },
            }
          : {}),
        ...(this.config.authBroker ? { authBroker: { ...(replayDedupe ? { replayDedupe } : {}) } } : {}),
        ...(this.config.adminUi && adminService
          ? {
              adminUi: {
                orgId,
                adminStatus: (principalId: string) => adminService.adminStatusOf(principalId),
                ...(this.config.portalIdentitySecret ? { portalIdentitySecret: this.config.portalIdentitySecret } : {}),
              },
            }
          : {}),
        ...(this.config.portal && adminService
          ? (() => {
              const publicUrl = (this.config.portalPublicUrl ?? `http://localhost:${this.config.port ?? 0}`).replace(/\/$/, '')
              const sessionSecret = this.config.portalSessionSecret ?? `qm-next-dev-portal-session-secret::${orgId}`
              const identitySecret = this.config.portalIdentitySecret ?? sessionSecret
              return {
                portal: {
                  orgId,
                  publicUrl,
                  sessionSecret,
                  identitySecret,
                  ...(this.config.portalSessionTtlS ? { sessionTtlS: this.config.portalSessionTtlS } : {}),
                  ...(this.config.deployAppsDomain ? { appsDomain: this.config.deployAppsDomain } : {}),
                  adminStatusOf: async (principalId: string) => (await adminService.adminStatusOf(principalId)).isAdmin,
                  ...(replayDedupe ? { replayDedupe } : {}),
                  ...(this.config.portalOidc
                    ? {
                        oidc: {
                          authEndpoint: 'https://slack.com/openid/connect/authorize',
                          tokenEndpoint: 'https://slack.com/api/openid.connect.token',
                          userinfoEndpoint: 'https://slack.com/api/openid.connect.userInfo',
                          scopes: 'openid profile email',
                          issuer: 'https://slack.com',
                          jwksUri: 'https://slack.com/openid/connect/keys',
                          clientSecret: '',
                          redirectUri: `${publicUrl}/auth/callback`,
                          ...this.config.portalOidc,
                        },
                      }
                    : {}),
                  principalRule: {
                    claim: this.config.portalPrincipalClaim === 'sub' ? ('sub' as const) : ('email' as const),
                    ...(this.config.portalAllowedEmailDomain ? { allowedEmailDomain: this.config.portalAllowedEmailDomain } : {}),
                    ...(this.config.portalAllowedEmails?.length ? { allowedEmails: this.config.portalAllowedEmails } : {}),
                  },
                  ...(this.config.portalLocalAuthBypass ? { localAuthBypass: true } : {}),
                },
              }
            })()
          : {}),
        crons: {
          crons: () => this.cronsRuntime?.crons,
          scheduler: () => this.cronsRuntime?.scheduler,
          ...(directoryStore ? { directory: directoryStore } : {}),
          deliveries: () => this.cronsRuntime?.deliveries,
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
    this.app = app
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
      this.mcpToolService?.close()
      for (const store of pgClosers) {
        try {
          await store.close?.()
        } catch (err) {
          void err
        }
      }
      if (pg) await pg.close().catch(() => undefined)
    }
  }
}

export default ApiService

declare module '@qm/cordis' {
  interface Context {
    api: ApiService
  }
}
