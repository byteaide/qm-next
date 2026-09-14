/**
 * HTTP surface: `POST /v1/turns` (synchronous, or `?async=1` to enqueue into
 * the run queue) and `GET /healthz`. Requests authenticate with a signed
 * bearer token whose claims are the turn's actor; the body states the surface
 * explicitly. The orchestrator owns every admission decision — the API only
 * translates HTTP.
 */
import type { Conversation, Destination, Orchestrator, ResolutionService, RunStore, SessionStore, TurnInput, TurnOrigin, TurnResult } from '@qm/types'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { authenticateBearer } from './auth.ts'
import { registerRouteTable } from './routes/framework.ts'
import { directoryRoutes, type DirectoryRoutesDeps } from './routes/directory-routes.ts'
import { cronRoutes, type CronRoutesDeps } from './routes/cron-routes.ts'
import { reachRoutes, type ReachRoutesDeps } from './routes/reach-routes.ts'
import { keychainRoutes, type KeychainRoutesDeps } from './routes/keychain-routes.ts'
import { surfaceRoutes, type SurfaceRoutesDeps } from './routes/surface-routes.ts'
import { memoryRoutes, type MemoryRoutesDeps } from './routes/memory-routes.ts'
import { skillRoutes, type SkillRoutesDeps } from './routes/skill-routes.ts'
import { searchRoutes, type SearchRoutesDeps } from './routes/search-routes.ts'
import { contextRoutes, type ContextRoutesDeps } from './routes/context-routes.ts'
import { contextPolicyRoutes, type ContextPolicyRoutesDeps } from './routes/context-policy-routes.ts'
import { surfaceCacheRoutes, type SurfaceCacheRoutesDeps } from './routes/surface-cache-routes.ts'
import { environmentRoutes, type EnvironmentRoutesDeps } from './routes/environment-routes.ts'
import { projectRoutes, type ProjectRoutesDeps } from './routes/project-routes.ts'
import { sessionStateRoutes, type SessionStateRoutesDeps } from './routes/session-state-routes.ts'
import { fileRoutes, type FileDeps } from './routes/file-routes.ts'
import { grantRoutes, type GrantDeps } from './routes/grant-routes.ts'
import { soulRoutes, type SoulDeps } from './routes/soul-routes.ts'
import { surfaceConfigRoutes, type ConfigDeps } from './routes/surface-config-routes.ts'
import { deploymentRoutes, type DeploymentDeps } from './routes/deployment-routes.ts'
import { deploymentLayerRoutes, type DeploymentLayerDeps } from './routes/deployment-layer-routes.ts'
import { connectorRoutes, connectorMatchRoutes, type ConnectorDeps } from './routes/connector-routes.ts'
import { webhookRoutes, webhookRawRoutes, type WebhookDeps } from './routes/webhook-routes.ts'
import { blobRoutes, type BlobDeps } from './routes/blob-routes.ts'
import { registerRawRouteTable } from './routes/raw-framework.ts'

export interface ApiDeps {
  orchestrator: Orchestrator
  sessions: SessionStore
  runs: RunStore
  resolution: ResolutionService
  /** Parity surface (11.0): directory sync/resolve routes when a store is wired. */
  directory?: DirectoryRoutesDeps
  /** Parity surface (11.0): cron routes when the triggers runtime is loaded. */
  crons?: CronRoutesDeps
  /** Parity surface (11.0): the reach route when a directory is wired. */
  reach?: ReachRoutesDeps
  /** Parity surface (11.0): keychain routes when a keychain is wired. */
  keychain?: KeychainRoutesDeps
  /** Parity surface (11.0): sessions/conversations routes over the session store. */
  surface?: SurfaceRoutesDeps
  /** Parity surface (11.0): personal/agent memory routes when a ScopeMemory is wired. */
  memory?: MemoryRoutesDeps
  /** Parity surface (11.0): skill registry routes when a SkillStore is wired. */
  skills?: SkillRoutesDeps
  /** Parity surface (11.0): the search route when a search backend is wired. */
  search?: SearchRoutesDeps
  /** Parity surface (11.0): surface-context pull protocol when the queue is wired. */
  context?: ContextRoutesDeps
  /** Parity surface (11.0): channel policy routes when a policy store is wired. */
  contextPolicy?: ContextPolicyRoutesDeps
  /** Parity surface (11.0): surface-cache ingest/policy when a cache is wired. */
  surfaceCache?: SurfaceCacheRoutesDeps
  /** Parity surface (11.0): environment routes when a registry is wired. */
  environments?: EnvironmentRoutesDeps
  /** Parity surface (11.0): project routes when a project store is wired. */
  projects?: ProjectRoutesDeps
  /** Parity surface (11.0): the session-state SSE stream over the run bus. */
  sessionState?: SessionStateRoutesDeps
  /** Parity surface (11.0): file list/content/upload over the file store. */
  files?: FileDeps
  /** Parity surface (11.0): grant apply/revoke plus the capability-gated share gate. */
  grants?: GrantDeps
  /** Parity surface (11.0): soul read/compose and personal-scope writes. */
  soul?: SoulDeps
  /** Parity surface (11.0): surface-config, runtime-config, channel-header-pin. */
  config?: ConfigDeps
  /** Parity surface (11.0): deployment management lane (proxy lane lands 13.0). */
  deployments?: DeploymentDeps
  /** Parity surface (11.0): the deployment CLI's tools/skills bundle lane. */
  deploymentLayer?: DeploymentLayerDeps
  /** Parity surface (11.0): connector OAuth/token surface over the token store. */
  connectors?: ConnectorDeps
  /** Parity surface (11.0): webhook CRUD and the raw incoming delivery lane. */
  webhooks?: WebhookDeps
  /** Parity surface (11.0): raw blob staging put/get. */
  blobs?: BlobDeps
}

export interface ApiServerOptions {
  secrets: string[]
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseConversation(value: unknown): Conversation | null {
  if (!isObj(value) || typeof value.kind !== 'string' || typeof value.threadRef !== 'string' || !value.threadRef) return null
  if (value.kind !== 'dm' && value.kind !== 'channel' && value.kind !== 'group') return null
  const conversation: Conversation = { kind: value.kind, threadRef: value.threadRef, audience: [] }
  if (typeof value.channelRef === 'string') conversation.channelRef = value.channelRef
  if (typeof value.channelName === 'string') conversation.channelName = value.channelName
  if (typeof value.isPrivate === 'boolean') conversation.isPrivate = value.isPrivate
  return conversation
}

function parseDestination(value: unknown): Destination | null {
  if (!isObj(value) || typeof value.type !== 'string' || typeof value.target !== 'string') return null
  const destination: Destination = { type: value.type, target: value.target }
  if (typeof value.threadId === 'string') destination.threadId = value.threadId
  return destination
}

function parseOrigin(value: unknown): TurnOrigin | null {
  if (value === undefined) return { kind: 'direct' }
  if (!isObj(value) || typeof value.kind !== 'string') return null
  switch (value.kind) {
    case 'direct':
      return { kind: 'direct' }
    case 'human': {
      const origin: TurnOrigin = { kind: 'human' }
      if (typeof value.messageTs === 'string') origin.messageTs = value.messageTs
      if (typeof value.entryTs === 'string') origin.entryTs = value.entryTs
      return origin
    }
    case 'ambient': {
      const origin: TurnOrigin = { kind: 'ambient' }
      if (typeof value.entryTs === 'string') origin.entryTs = value.entryTs
      if (typeof value.live === 'boolean') origin.live = value.live
      return origin
    }
    case 'automation': {
      if (value.destination === undefined) return { kind: 'automation' }
      const destination = parseDestination(value.destination)
      return destination ? { kind: 'automation', destination } : null
    }
    default:
      return null
  }
}

function sendResult(reply: FastifyReply, result: TurnResult): FastifyReply {
  if (result.status === 'queued') return reply.code(202).send(result)
  return reply.code(result.status === 'refused' ? 403 : 200).send(result)
}

export function createApiServer(deps: ApiDeps, opts: ApiServerOptions): FastifyInstance {
  const app = Fastify({ logger: false })

  app.get('/healthz', async () => ({ ok: true }))

  if (deps.directory) {
    registerRouteTable(app, opts, directoryRoutes(deps.directory))
  }
  if (deps.crons) {
    registerRouteTable(app, opts, cronRoutes(deps.crons))
  }
  if (deps.reach) {
    registerRouteTable(app, opts, reachRoutes(deps.reach))
  }
  if (deps.keychain) {
    registerRouteTable(app, opts, keychainRoutes(deps.keychain))
  }
  if (deps.surface) {
    registerRouteTable(app, opts, surfaceRoutes(deps.surface))
  }
  if (deps.memory) {
    registerRouteTable(app, opts, memoryRoutes(deps.memory))
  }
  if (deps.skills) {
    registerRouteTable(app, opts, skillRoutes(deps.skills))
  }
  if (deps.search) {
    registerRouteTable(app, opts, searchRoutes(deps.search))
  }
  if (deps.context) {
    registerRouteTable(app, opts, contextRoutes(deps.context))
  }
  if (deps.contextPolicy) {
    registerRouteTable(app, opts, contextPolicyRoutes(deps.contextPolicy))
  }
  if (deps.surfaceCache) {
    registerRouteTable(app, opts, surfaceCacheRoutes(deps.surfaceCache))
  }
  if (deps.environments) {
    registerRouteTable(app, opts, environmentRoutes(deps.environments))
  }
  if (deps.projects) {
    registerRouteTable(app, opts, projectRoutes(deps.projects))
  }
  if (deps.sessionState) {
    registerRouteTable(app, opts, sessionStateRoutes(deps.sessionState))
  }
  if (deps.files) {
    registerRouteTable(app, opts, fileRoutes(deps.files))
  }
  if (deps.grants) {
    registerRouteTable(app, opts, grantRoutes(deps.grants))
  }
  if (deps.soul) {
    registerRouteTable(app, opts, soulRoutes(deps.soul))
  }
  if (deps.config) {
    registerRouteTable(app, opts, surfaceConfigRoutes(deps.config))
  }
  if (deps.deployments) {
    registerRouteTable(app, opts, deploymentRoutes(deps.deployments))
  }
  if (deps.deploymentLayer) {
    registerRouteTable(app, opts, deploymentLayerRoutes(deps.deploymentLayer))
  }
  if (deps.connectors) {
    registerRouteTable(app, opts, connectorRoutes(deps.connectors))
    registerRouteTable(app, opts, [connectorMatchRoutes(deps.connectors).api])
    registerRawRouteTable(app, opts, [connectorMatchRoutes(deps.connectors).raw])
  }
  if (deps.webhooks) {
    registerRouteTable(app, opts, webhookRoutes(deps.webhooks))
    registerRawRouteTable(app, opts, webhookRawRoutes(deps.webhooks))
  }
  if (deps.blobs) {
    registerRawRouteTable(app, opts, blobRoutes(deps.blobs))
  }

  app.get('/v1/runs/:id', async (request, reply) => {
    const actor = await authenticateBearer(request.headers.authorization, opts.secrets)
    if (!actor) {
      return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid bearer token' })
    }
    const run = await deps.runs.get((request.params as { id: string }).id)
    if (!run) return reply.code(404).send({ error: 'not_found' })
    return reply.code(200).send(run)
  })

  app.post('/v1/turns', async (request, reply) => {
    const actor = await authenticateBearer(request.headers.authorization, opts.secrets)
    if (!actor) {
      return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid bearer token' })
    }
    const body = request.body
    if (!isObj(body) || typeof body.text !== 'string' || !body.text) {
      return reply.code(400).send({ error: 'bad_request', message: 'text is required' })
    }
    if (typeof body.surface !== 'string' || !body.surface) {
      return reply.code(400).send({ error: 'bad_request', message: 'surface is required; turns never have a default surface' })
    }
    const conversation = parseConversation(body.conversation)
    if (!conversation) {
      return reply.code(400).send({ error: 'bad_request', message: 'conversation { kind, threadRef } is required' })
    }
    const origin = parseOrigin(body.origin)
    if (!origin) {
      return reply.code(400).send({ error: 'bad_request', message: 'invalid origin' })
    }
    conversation.audience = [actor]
    const input: TurnInput = { surface: body.surface, actor, conversation, origin, text: body.text }
    if (typeof body.harness === 'string') input.harness = body.harness
    if (typeof body.model === 'string') input.model = body.model
    if (typeof body.thinkingLevel === 'string') input.thinkingLevel = body.thinkingLevel
    if (typeof body.readOnly === 'boolean') input.readOnly = body.readOnly

    const query = request.query as Record<string, string | undefined>
    const wantAsync = query.async === '1' || body.async === true
    if (!wantAsync) {
      return sendResult(reply, await deps.orchestrator.handleTurn(input))
    }

    const session = await deps.sessions.getOrCreateByThread(
      conversation.threadRef,
      conversation.kind,
      deps.resolution.scopeFor(conversation, actor),
      input.surface,
      conversation.channelName,
    )
    const { run } = await deps.runs.enqueue({ sessionId: session.id, request: input })
    const result: TurnResult = { status: 'queued', runId: run.id, sessionId: session.id }
    return reply.code(202).send(result)
  })

  return app
}
