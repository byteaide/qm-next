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

export interface ApiDeps {
  orchestrator: Orchestrator
  sessions: SessionStore
  runs: RunStore
  resolution: ResolutionService
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
