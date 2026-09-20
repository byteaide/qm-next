/**
 * The web-ui server half: the SPA's HTTP surface over the M1/M3 stores.
 * Cookie or portal-identity principal, turn/run proxy, SSE run
 * observation off the durable target event log (Phase 7 / KV-006 — the
 * legacy RunEventBus stream is deleted), live skills/crons/contexts
 * views, and per-user relays into the api parity lanes for everything
 * else (files, webhooks, connectors, keychain, memory, deployments,
 * search, user-model-auth) — qm's signed core relays, in-process (13.0).
 */
import { randomBytes } from 'node:crypto'
import { createFireEngine, manualFireKey, renderCronFireInput, type CronSchedule, type CronStore } from '@qm/triggers'
import { WEBHOOK_SCHEMES } from '@qm/api'
import { applyApprovalDecision, type ApprovalContinuationDeps } from '@qm/runs'
import type { DirectoryStore } from '@qm/directory'
import type { SkillStore } from '@qm/skills'
import type {
  Conversation,
  Orchestrator,
  ResolutionService,
  Run,
  RunStore,
  SessionStore,
  TargetRunEvent,
  TargetRunObservation,
  TurnApproval,
  TurnInput,
} from '@qm/types'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { clearSessionCookie, identifyRequest, identityOf, sessionCookie, type AuthOptions } from './principal.ts'
import type { ApiRelay } from './relay.ts'
import {
  contextWire,
  cronWire,
  entryWire,
  runWire,
  sessionWire,
  skillWire,
  type SkillItemWire,
} from './wire.ts'

export interface WebUiDeps {
  orchestrator: Orchestrator
  sessions: SessionStore
  runs: RunStore
  resolution: ResolutionService
  /** Run Observation port (snapshot/replay/subscribe) over the durable log. */
  runObservation: TargetRunObservation
  /**
   * ADR-0010 continuation executor — the approval decision glue
   * (durable ApprovalStore + RunStore [+ event log + reservations]).
   * When absent, approval decisions fail closed with 503 instead of
   * creating successor Runs.
   */
  approvalContinuation?: ApprovalContinuationDeps
  skills: SkillStore
  crons: CronStore
  directory: DirectoryStore
  /** In-process relay into the api parity lanes; per-user bearer minting. */
  relay?: ApiRelay
  /** Public web base URL (connector OAuth redirect targets). */
  publicUrl?: string
  /** Identity verification + principal allow-list (qm WEB_UI hardening). */
  auth?: AuthOptions
}

export interface WebUiServerOptions {
  host: string
  port: number
  /** Default dev principal; every cookie session names one explicitly. */
  user: string
  /** Built SPA directory (dist-web). Optional for API-only tests. */
  distDir?: string
  org?: string
}

const SSE_HEARTBEAT_MS = 15_000

const UNTRUSTED_CONTENT_SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads'
const PLAYGROUND_CSP = [
  'sandbox allow-scripts allow-pointer-lock',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  'worker-src blob:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function safeParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function asBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body
  if (typeof body === 'string') return Buffer.from(body)
  return Buffer.from([])
}

function notFound(reply: FastifyReply, error = 'not_found'): FastifyReply {
  return reply.code(404).send({ error })
}

function sseHead(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  reply.raw.write(': open\n\n')
}

function sseEvent(raw: FastifyReply['raw'], event: string, data: unknown): void {
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function sseComment(raw: FastifyReply['raw'], comment: string): void {
  raw.write(`: ${comment}\n\n`)
}

interface MeWire {
  user: string
  org: string
  mode: 'dev' | 'portal'
  impersonatedBy: string | null
  permissions: string[]
  individualModelAuth: boolean
  modelAuthConnected: boolean
}

interface RuntimeConfigWire {
  scopeId: string
  approvedHarnesses: string[]
  modelsByHarness: Record<string, string[]>
  modelCatalog: Record<string, { name: string; provider: string }>
  orgDefault: { harnessId: string; modelId: string; revision: number }
  scopeOverride: null
  effective: { harnessId: string; modelId: string; effortLevel?: string; fastMode?: boolean }
  upgradeAvailable: boolean
}

const DEV_MODEL_ID = 'claude-sonnet-4-6'

function runtimeConfigWire(scopeId: string, effective: RuntimeConfigWire['effective']): RuntimeConfigWire {
  return {
    scopeId,
    approvedHarnesses: ['mock'],
    modelsByHarness: { mock: [DEV_MODEL_ID] },
    modelCatalog: { [DEV_MODEL_ID]: { name: 'Claude Sonnet 4.6', provider: 'anthropic' } },
    orgDefault: { harnessId: 'mock', modelId: DEV_MODEL_ID, revision: 1 },
    scopeOverride: null,
    effective,
    upgradeAvailable: false,
  }
}

async function serveFile(reply: FastifyReply, filePath: string): Promise<FastifyReply | null> {
  let info
  try {
    info = await stat(filePath)
  } catch {
    return null
  }
  if (!info.isFile()) return null
  const ext = filePath.slice(filePath.lastIndexOf('.'))
  const type = CONTENT_TYPES[ext] ?? 'application/octet-stream'
  const body = await readFile(filePath)
  return reply.code(200).type(type).send(body)
}

export function createWebUiServer(deps: WebUiDeps, opts: WebUiServerOptions): FastifyInstance {
  const app = Fastify({ logger: false })
  const personalScope = `personal:${opts.user}`
  const orgScope = 'org:default'
  const auth: AuthOptions = deps.auth ?? {}
  const relay = deps.relay
  const relayJson = async (
    user: string,
    method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT',
    pathWithQuery: string,
    rawBody?: string,
  ): Promise<{ status: number; text: string } | null> => {
    if (!relay) return null
    const r = await relay.json(user, method, pathWithQuery, rawBody)
    return { status: r.status, text: r.text }
  }
  const replyRelay = (reply: FastifyReply, r: { status: number; text: string } | null): FastifyReply => {
    if (!r) return reply.code(503).send({ error: 'unavailable', message: 'api relay not wired' })
    return reply.code(r.status).type('application/json').send(r.text)
  }
  function authed(req: FastifyRequest): string | null {
    const outcome = identityOf(req)
    return outcome && typeof outcome !== 'string' ? outcome.user : null
  }
  function identityImpersonator(req: FastifyRequest): string | null {
    const outcome = identityOf(req)
    return outcome && typeof outcome !== 'string' ? outcome.impersonator : null
  }
  function unauthorized(reply: FastifyReply, req?: FastifyRequest): FastifyReply {
    const mode = auth.portalIdentitySecret ? 'portal' : 'dev'
    const outcome = req ? identityOf(req) : undefined
    const reason: string = typeof outcome === 'string' ? outcome : 'unauthenticated'
    return reply.code(401).send({ error: 'sign in', mode, reason })
  }
  app.addHook('onRequest', (req, _reply, done) => {
    void identifyRequest(req, auth).then(() => done(), done)
  })
  const uiState = new Map<string, { value: unknown; updatedAt: number }>()
  const effectiveConfig: RuntimeConfigWire['effective'] = { harnessId: 'mock', modelId: DEV_MODEL_ID }
  const fireEngine = createFireEngine({
    sessions: deps.sessions,
    runs: deps.runs,
    resolution: deps.resolution,
  })

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
  app.addContentTypeParser('text/plain', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

  app.get('/healthz', async () => ({ ok: true }))

  app.get('/favicon.svg', async (_req, reply) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">\u{1F3F4}\u200D\u2620\uFE0F</text></svg>`
    return reply.code(200).type('image/svg+xml').header('cache-control', 'no-cache').send(svg)
  })

  app.post('/signin', async (req, reply) => {
    const body = req.body as { user?: unknown } | null
    const id = typeof body?.user === 'string' ? body.user.trim().slice(0, 200) : ''
    if (!id) return reply.code(400).send({ error: 'bad_request', message: 'Enter a principal to sign in as.' })
    return reply.code(200).header('set-cookie', sessionCookie(id)).send({ ok: true, user: id })
  })

  app.post('/signout', async (_req, reply) => {
    return reply.code(200).header('set-cookie', clearSessionCookie()).send({ ok: true })
  })

  app.get('/me', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply, req)
    const [whoami, authStatus] = await Promise.all([
      relayJson(user, 'GET', '/v1/admin/whoami'),
      relayJson(user, 'GET', `/v1/user-model-auth/status?principalId=${encodeURIComponent(user)}`),
    ])
    let permissions: string[] = []
    if (whoami?.status === 200) {
      try {
        const parsed = JSON.parse(whoami.text) as { permissions?: unknown }
        if (Array.isArray(parsed.permissions)) {
          permissions = parsed.permissions.filter((p): p is string => typeof p === 'string')
        }
      } catch {}
    }
    let individualModelAuth = false
    let modelAuthConnected = false
    if (authStatus?.status === 200) {
      try {
        const parsed = JSON.parse(authStatus.text) as {
          individualModelAuth?: boolean
          connections?: Array<{ provider?: string }>
        }
        individualModelAuth = parsed.individualModelAuth === true
        modelAuthConnected = (parsed.connections?.length ?? 0) > 0
      } catch {}
    }
    return reply.code(200).header('set-cookie', sessionCookie(user)).send({
      user,
      org: opts.org ?? 'dev',
      mode: auth.portalIdentitySecret ? 'portal' : 'dev',
      impersonatedBy: identityImpersonator(req),
      permissions: permissions.length ? permissions : ['admin'],
      individualModelAuth,
      modelAuthConnected,
    } satisfies MeWire)
  })

  app.post('/api/turn', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const body = (req.body ?? {}) as Record<string, unknown>
    const text = typeof body.text === 'string' ? body.text : ''
    const proactiveOpener = body.proactiveOpener === true
    const approval: TurnApproval | undefined = (() => {
      if (!isObj(body.approval)) return undefined
      const a = body.approval
      if (typeof a.requestId !== 'string' || typeof a.approved !== 'boolean') return undefined
      const scope = a.scope === 'once' || a.scope === 'session' || a.scope === 'always' ? a.scope : undefined
      return { requestId: a.requestId, approved: a.approved, ...(scope ? { scope } : {}) }
    })()
    if (!text.trim() && !proactiveOpener && !approval) {
      return reply.code(400).send({ error: 'bad_request', message: 'empty message' })
    }
    // ADR-0010 continuation executor — an approval-carrying turn is a
    // decision, not new work: route it through the glue (SAME Run
    // resumes or fails) instead of enqueueing a successor Run.
    if (approval) {
      const continuation = deps.approvalContinuation
      if (!continuation) {
        return reply.code(503).send({ error: 'approval_continuation_unavailable', message: 'approval executor not wired' })
      }
      const request = await continuation.approvals.get(approval.requestId)
      if (!request) return notFound(reply)
      const targetRun = await continuation.runs.get(request.runId)
      if (!targetRun || !targetRun.request.conversation.threadRef.startsWith(`web:${user}:`)) {
        return notFound(reply)
      }
      const { lifecycle } = await applyApprovalDecision(continuation, approval.requestId, {
        approved: approval.approved,
        decidedBy: user,
      })
      const state =
        lifecycle.outcome === 'continuation_started'
          ? 'resuming'
          : lifecycle.outcome === 'run_failed'
            ? 'failed'
            : 'already_decided'
      return reply.code(state === 'already_decided' ? 200 : 202).send({ status: state, runId: request.runId })
    }
    const clientTurnId =
      typeof body.clientTurnId === 'string' && /^[0-9a-f-]{36}$/i.test(body.clientTurnId) ? body.clientTurnId : undefined

    const scopeId = typeof body.scopeId === 'string' && body.scopeId ? body.scopeId : personalScope
    const channelName = typeof body.channelName === 'string' && body.channelName.trim() ? body.channelName.trim().slice(0, 200) : undefined
    let conversation: Conversation
    if (scopeId.startsWith('channel:') || scopeId.startsWith('group:')) {
      const kind = scopeId.startsWith('channel:') ? 'channel' : 'group'
      const spaceId = scopeId.slice(scopeId.indexOf(':') + 1)
      const threadRef = `${kind === 'channel' ? 'ch' : 'g'}:${spaceId}`
      const actor = { id: user, type: 'internal' as const }
      conversation = {
        kind,
        threadRef,
        audience: [actor],
        ...(kind === 'channel' ? { channelRef: spaceId } : {}),
        ...(channelName ? { channelName } : {}),
      }
    } else {
      const threadRef = typeof body.threadRef === 'string' && body.threadRef.startsWith('web:') ? body.threadRef : `web:${user}:default`
      if (!threadRef.startsWith(`web:${user}:`)) {
        return reply.code(403).send({ error: 'forbidden_thread', message: 'this conversation can only be continued from its own context' })
      }
      conversation = { kind: 'dm', threadRef, audience: [{ id: user, type: 'internal' as const }] }
    }

    const actor = { id: user, type: 'internal' as const }
    const input: TurnInput = {
      surface: 'web',
      actor,
      conversation,
      origin: { kind: 'human' },
      text,
      ...(typeof body.harness === 'string' && body.harness ? { harness: body.harness } : {}),
      ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
      ...(typeof body.thinkingLevel === 'string' ? { thinkingLevel: body.thinkingLevel } : {}),
      ...(typeof body.timezone === 'string' && body.timezone.trim() ? { timezone: body.timezone.trim().slice(0, 64) } : {}),
      ...(approval ? { approval } : {}),
    }
    const session = await deps.sessions.getOrCreateByThread(
      conversation.threadRef,
      conversation.kind,
      deps.resolution.scopeFor(conversation, actor),
      'web',
      channelName,
    )
    await deps.sessions.addParticipant(session.id, user)
    const { run } = await deps.runs.enqueue({
      sessionId: session.id,
      request: input,
      ...(clientTurnId ? { dedupKey: `web:${user}:${clientTurnId}` } : {}),
    })
    return reply.code(202).send({ status: 'queued', runId: run.id, sessionId: session.id })
  })

  app.get('/api/runs/active', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const query = req.query as Record<string, string | undefined>
    const threadRef = query.threadRef ?? ''
    if (!threadRef.startsWith('web:')) return notFound(reply)
    const runs = await deps.runs.list({ limit: 100 })
    const forThread = runs
      .filter((r) => r.request.conversation.threadRef === threadRef && (r.status === 'pending' || r.status === 'running'))
      .sort((a, b) => a.createdAt - b.createdAt)
    const live = forThread.find((r) => r.status === 'running') ?? forThread[0]
    if (!live) return reply.code(200).send({ runId: null, run: null })
    const queued = forThread
      .filter((r) => r.id !== live.id && r.status === 'pending')
      .map((r) => ({ runId: r.id, text: r.request.text }))
    return reply.code(200).send({ runId: live.id, run: runWire(live), ...(queued.length ? { queued } : {}) })
  })

  app.get('/api/runs/:id', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const run = await deps.runs.get(id)
    if (!run) return notFound(reply)
    return reply.code(200).send(runWire(run))
  })

  app.post('/api/runs/:id/withdraw', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const withdrawn = await deps.runs.withdraw(id)
    return reply.code(200).send({ withdrawn })
  })

  app.post('/api/runs/:id/signal', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return reply.code(409).send({ error: 'conflict', reason: 'unsupported' })
  })

  // Run Observation surface (Phase 7 / KV-006 cutover) — the only Run
  // stream. Consumes `TargetRunObservation` directly in-process over the
  // durable event log (ADR-0001 + ADR-0014 §2 + ADR-0013). The subscribe
  // route closes the stream once a terminal event passes so browsers and
  // inject-based clients observe a natural end-of-stream.
  app.get('/api/runs/:id/observation/snapshot', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const initial = await deps.runs.get(id)
    if (!initial) return notFound(reply)
    const snap = await deps.runObservation.snapshot(id, {
      sessionId: initial.sessionId,
      callerPrincipalId: user,
      scope: 'principal',
    })
    if (!snap) return notFound(reply)
    return reply.code(200).send(snap)
  })

  app.get('/api/runs/:id/observation/replay', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const query = req.query as Record<string, string | undefined>
    const afterStr = query.after
    const after = afterStr === undefined ? -1 : Number.parseInt(afterStr, 10)
    if (!Number.isInteger(after) || after < -1) {
      return reply.code(400).send({ error: 'bad_request', message: '`after` must be an integer >= -1' })
    }
    const initial = await deps.runs.get(id)
    if (!initial) return notFound(reply)
    const events = await deps.runObservation.replay(
      { runId: id, seq: after },
      { sessionId: initial.sessionId, callerPrincipalId: user, scope: 'principal' },
    )
    return reply.code(200).send(events)
  })

  app.get('/api/runs/:id/observation/subscribe', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const query = req.query as Record<string, string | undefined>
    const afterStr = query.after
    const after = afterStr === undefined ? -1 : Number.parseInt(afterStr, 10)
    if (!Number.isInteger(after) || after < -1) {
      return reply.code(400).send({ error: 'bad_request', message: '`after` must be an integer >= -1' })
    }
    const initial = await deps.runs.get(id)
    if (!initial) return notFound(reply)
    reply.hijack()
    sseHead(reply)
    const raw = reply.raw
    let closed = false
    const teardown = (): void => {
      if (closed) return
      closed = true
      clearInterval(beat)
      unsubscribe()
    }
    req.raw.on('close', teardown)
    const beat = setInterval(() => {
      if (!closed) sseComment(raw, 'ping')
    }, SSE_HEARTBEAT_MS)
    beat.unref?.()
    const unsubscribe = deps.runObservation.subscribe(
      { runId: id, seq: after },
      { sessionId: initial.sessionId, callerPrincipalId: user, scope: 'principal' },
      (event: TargetRunEvent) => {
        if (closed) return
        sseEvent(raw, 'run_observation', event)
        if (event.kind === 'run.finished' || event.kind === 'run.cancelled') {
          teardown()
          raw.end()
        }
      },
    )
  })

  app.get('/api/sessions', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const [runs, activeIds] = await Promise.all([deps.runs.list({ limit: 200 }), deps.runs.activeSessionIds()])
    const active = new Set(activeIds)
    const latest = new Map<string, Run>()
    for (const run of runs) {
      const prev = latest.get(run.sessionId)
      if (!prev || run.createdAt >= prev.createdAt) latest.set(run.sessionId, run)
    }
    const sessions: ReturnType<typeof sessionWire>[] = []
    for (const [sessionId, run] of latest) {
      const session = await deps.sessions.get(sessionId)
      if (!session) continue
      sessions.push(sessionWire(session, active.has(sessionId), run.finishedAt ?? run.createdAt))
    }
    sessions.sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))
    return reply.code(200).send({ sessions })
  })

  app.get('/api/sessions/:id', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const session = await deps.sessions.get(id)
    if (!session) return notFound(reply)
    const all = await deps.sessions.getEntries(id)
    const query = req.query as Record<string, string | undefined>
    let entries = all
    const sinceSeq = query.sinceSeq !== undefined ? Number(query.sinceSeq) : undefined
    const beforeSeq = query.beforeSeq !== undefined ? Number(query.beforeSeq) : undefined
    if (sinceSeq !== undefined && Number.isFinite(sinceSeq)) entries = entries.filter((e) => e.seq > sinceSeq)
    if (beforeSeq !== undefined && Number.isFinite(beforeSeq)) entries = entries.filter((e) => e.seq < beforeSeq)
    const activeIds = await deps.runs.activeSessionIds()
    return reply.code(200).send({
      session: sessionWire(session, activeIds.includes(id), session.lastActivityAt),
      entries: entries.map(entryWire),
      earlierEntries: 0,
    })
  })

  app.post('/api/sessions/:id', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const session = await deps.sessions.get(id)
    if (!session) return notFound(reply)
    const body = (req.body ?? {}) as Record<string, unknown>
    if (typeof body.title === 'string' && body.title.trim()) await deps.sessions.updateTitle(id, body.title.trim().slice(0, 200))
    const updated = (await deps.sessions.get(id)) ?? session
    return reply.code(200).send({ session: sessionWire(updated, false, updated.lastActivityAt) })
  })

  app.post('/api/sessions/:id/title', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const session = await deps.sessions.get(id)
    if (!session) return notFound(reply)
    return reply.code(200).send({ title: session.title ?? null })
  })

  app.get('/api/sessions/:id/entries/:seq', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const seq = Number((req.params as { seq: string }).seq)
    const session = await deps.sessions.get(id)
    if (!session || !Number.isFinite(seq)) return notFound(reply)
    const entries = await deps.sessions.getEntries(id)
    const entry = entries.find((e) => e.seq === seq)
    if (!entry) return notFound(reply)
    return reply.code(200).send({ entry: entryWire(entry) })
  })

  app.get('/api/sessions/:id/approvals', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return reply.code(200).send({ approvals: [] })
  })

  app.post('/api/sessions/:id/fork', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return reply.code(501).send({ error: 'unavailable', message: 'fork is out of scope for M3' })
  })

  app.get('/api/sessions/:id/background', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const session = await deps.sessions.get(id)
    if (!session) return notFound(reply)
    const crons = (await deps.crons.list())
      .filter((c) => c.scopeId === session.scopeId && !c.archived)
      .map((c) => ({ id: c.id, ...(c.title ? { title: c.title } : {}), ...(c.nextFireAt !== undefined ? { nextFireAt: c.nextFireAt } : {}) }))
    return reply.code(200).send({ jobs: [], watches: [], crons })
  })

  app.get('/api/skills', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const resolutions = await deps.skills.visibleFor([personalScope, orgScope])
    const skills: SkillItemWire[] = []
    for (const res of resolutions) {
      if (!res.skill) continue
      skills.push(
        skillWire(res.skill, {
          shadowed: res.shadowed.length > 0,
          editable: res.skill.scopeId === personalScope || res.skill.scopeId === orgScope,
        }),
      )
    }
    return reply.code(200).send({ skills })
  })

  app.get('/api/skills/:id', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const skill = await deps.skills.get(id)
    if (!skill) return notFound(reply)
    return reply.code(200).send({ skill: skillWire(skill, { withBody: true, editable: true }) })
  })

  app.post('/api/skills', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const body = (req.body ?? {}) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name : ''
    const description = typeof body.description === 'string' ? body.description : ''
    const skillBody = typeof body.body === 'string' ? body.body : ''
    const scopeId = typeof body.scopeId === 'string' && body.scopeId ? body.scopeId : personalScope
    if (!name.trim()) return reply.code(400).send({ error: 'bad_request', message: 'name is required' })
    try {
      const skill = await deps.skills.register({
        scopeId,
        name,
        description,
        body: skillBody,
        createdBy: user,
      })
      return reply.code(200).send({ skill: skillWire(skill, { withBody: true, editable: true }) })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = message.includes('collision') ? 409 : 400
      return reply.code(code).send({ error: code === 409 ? 'conflict' : 'bad_request', message })
    }
  })

  app.put('/api/skills/:id', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const body = (req.body ?? {}) as Record<string, unknown>
    const patch: { description?: string; body?: string } = {}
    if (typeof body.description === 'string') patch.description = body.description
    if (typeof body.body === 'string') patch.body = body.body
    if (!Object.keys(patch).length) return reply.code(400).send({ error: 'bad_request', message: 'expected description or body' })
    try {
      const skill = await deps.skills.update(id, patch)
      return reply.code(200).send({ skill: skillWire(skill, { withBody: true, editable: true }) })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.code(message.includes('unknown skill') ? 404 : 400).send({ error: 'bad_request', message })
    }
  })

  app.delete('/api/skills/:id', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const skill = await deps.skills.get(id)
    if (!skill) return notFound(reply)
    await deps.skills.delete(id)
    return reply.code(200).send({ ok: true })
  })

  app.post('/api/skills/:id/restore', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    try {
      const skill = await deps.skills.publish(id)
      return reply.code(200).send({ skill: skillWire(skill, { withBody: true, editable: true }) })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = message.includes('collision') ? 409 : 404
      return reply.code(code).send({ error: code === 409 ? 'conflict' : 'not_found', message })
    }
  })

  app.get('/api/crons', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const all = await deps.crons.list()
    const crons = all.filter((c) => c.ownerId === user).map((c) => cronWire(c, 'manage'))
    const visible = all.filter((c) => c.ownerId !== user).map((c) => cronWire(c, 'read'))
    return reply.code(200).send({ crons, visible })
  })

  app.get('/api/crons/:id/runs', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const cron = await deps.crons.get(id)
    if (!cron) return notFound(reply)
    const page = await deps.crons.getFires(id, 20)
    const runs = page.runs.map((entry) => ({
      fireKey: entry.fireKey,
      threadRef: '',
      firedAt: entry.firedAt,
      ...(entry.scheduledAt !== undefined ? { scheduledAt: entry.scheduledAt } : {}),
      ...(entry.status !== undefined ? { status: entry.status } : {}),
      ...(entry.note !== undefined ? { note: entry.note } : {}),
      ...(entry.reply !== undefined ? { reply: entry.reply } : {}),
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
    }))
    return reply.code(200).send({ runs })
  })

  app.patch('/api/crons/:id', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const body = (req.body ?? {}) as Record<string, unknown>
    const patch: Parameters<CronStore['update']>[1] = {}
    if ('title' in body) {
      if (typeof body.title !== 'string') return reply.code(400).send({ error: 'bad_request', message: 'title must be a string' })
      patch.title = body.title.trim()
    }
    if ('task' in body) {
      if (typeof body.task !== 'string' || !body.task.trim()) {
        return reply.code(400).send({ error: 'bad_request', message: 'task must be a non-empty string' })
      }
      patch.action = body.task.trim()
    }
    if ('action' in body && typeof body.action === 'string') patch.action = body.action
    if ('message' in body && typeof body.message === 'string') patch.message = body.message
    if ('schedule' in body && isObj(body.schedule)) patch.schedule = body.schedule as unknown as CronSchedule
    if ('enabled' in body) {
      if (typeof body.enabled !== 'boolean') return reply.code(400).send({ error: 'bad_request', message: 'enabled must be a boolean' })
      patch.enabled = body.enabled
    }
    if ('archived' in body) {
      if (typeof body.archived !== 'boolean') return reply.code(400).send({ error: 'bad_request', message: 'archived must be a boolean' })
      patch.archived = body.archived
      if (body.archived) patch.enabled = false
    }
    if (!Object.keys(patch).length) {
      return reply.code(400).send({ error: 'bad_request', message: 'expected title, task, schedule, enabled, or archived' })
    }
    const updated = await deps.crons.update(id, patch)
    if (!updated) return notFound(reply)
    return reply.code(200).send({ cron: cronWire(updated, 'manage') })
  })

  app.post('/api/crons/:id/enable', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const updated = await deps.crons.update(id, { enabled: true, archived: false })
    if (!updated) return notFound(reply)
    return reply.code(200).send({ cron: cronWire(updated, 'manage') })
  })

  app.post('/api/crons/:id/disable', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    await deps.crons.setEnabled(id, false)
    const updated = await deps.crons.get(id)
    return reply.code(200).send(updated ? { cron: cronWire(updated, 'manage') } : { ok: true })
  })

  app.post('/api/crons/:id/run', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const cron = await deps.crons.get(id)
    if (!cron) return notFound(reply)
    const task = cron.action ?? cron.message ?? ''
    if (!task.trim()) return reply.code(400).send({ error: 'bad_request', message: 'cron has no task' })
    const fireKey = manualFireKey(id, crypto.randomUUID())
    await fireEngine.submit({
      surface: 'cron',
      fireKey,
      text: renderCronFireInput(task, cron.id, cron.title),
      ownerId: cron.ownerId,
      scopeId: cron.scopeId,
      ...(cron.title ? { title: cron.title } : {}),
      cronId: cron.id,
      firedAt: Date.now(),
      onTerminal: async (entry) => {
        await deps.crons.recordFire(id, entry)
      },
    })
    return reply.code(200).send({ ok: true, fireKey })
  })

  app.delete('/api/crons/:id', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const cron = await deps.crons.get(id)
    if (!cron) return notFound(reply)
    await deps.crons.delete(id)
    return reply.code(200).send({ ok: true })
  })

  app.get('/api/contexts', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const spaces = await deps.directory.listVisibleSpaces('web', user)
    const contexts = [
      {
        scopeId: personalScope,
        kind: 'personal' as const,
        name: null,
        sessionCount: 0,
        lastActivityAt: null,
      },
      ...spaces.map(contextWire),
    ]
    return reply.code(200).send({ contexts })
  })

  app.get('/api/scope-resources', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const query = req.query as Record<string, string | undefined>
    const scope = query.scope ?? personalScope
    if (!relay) {
      const [crons, skills] = await Promise.all([
        deps.crons.list(),
        deps.skills.visibleFor([personalScope, orgScope]),
      ])
      return reply.code(200).send({
        files: [],
        webhooks: [],
        crons: crons.filter((c) => c.scopeId === scope).map((c) => cronWire(c, 'manage')),
        deployments: [],
        skills: skills
          .filter((res): res is typeof res & { skill: NonNullable<typeof res.skill> } => res.skill !== null)
          .filter((res) => res.skill.scopeId === scope)
          .map((res) => ({ id: res.skill.id, name: res.skill.name, description: res.skill.description, status: res.skill.status })),
        manageable: scope === personalScope || scope === orgScope,
      })
    }
    const enc = encodeURIComponent
    const [files, webhooks, deployments, crons, skills] = await Promise.all([
      relayJson(user, 'GET', `/v1/files?viewer=${enc(user)}&scope=${enc(scope)}&limit=200`),
      relayJson(user, 'GET', `/v1/webhooks?viewer=${enc(user)}`),
      relayJson(user, 'GET', `/v1/deployments?principalId=${enc(user)}`),
      deps.crons.list(),
      deps.skills.visibleFor([personalScope, orgScope]),
    ])
    const filesBody = files?.status === 200 ? safeParse<{ files?: unknown[] }>(files.text) : null
    const webhookBody = webhooks?.status === 200 ? safeParse<{ webhooks?: Array<Record<string, unknown>> }>(webhooks.text) : null
    const deploymentBody = deployments?.status === 200 ? safeParse<{ deployments?: unknown[] }>(deployments.text) : null
    const redactWebhook = (w: Record<string, unknown>): Record<string, unknown> => {
      const verification = w.verification
      if (typeof verification !== 'object' || verification === null) return w
      return { ...w, verification: { ...(verification as Record<string, unknown>), secret: undefined } }
    }
    return reply.code(200).send({
      files: filesBody?.files ?? [],
      webhooks: (webhookBody?.webhooks ?? []).map(redactWebhook),
      crons: crons.filter((c) => c.scopeId === scope).map((c) => cronWire(c, 'manage')),
      deployments: deploymentBody?.deployments ?? [],
      skills: skills
        .filter((res): res is typeof res & { skill: NonNullable<typeof res.skill> } => res.skill !== null)
        .filter((res) => res.skill.scopeId === scope)
        .map((res) => ({ id: res.skill.id, name: res.skill.name, description: res.skill.description, status: res.skill.status })),
      manageable: scope === personalScope || scope === orgScope,
    })
  })

  app.get('/api/ui-state', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const query = req.query as Record<string, string | undefined>
    const key = query.key ?? ''
    const record = uiState.get(`${user}:${key}`)
    if (!record) return reply.code(200).send({ value: null, updatedAt: 0 })
    return reply.code(200).send(record)
  })

  app.put('/api/ui-state', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const body = (req.body ?? {}) as Record<string, unknown>
    const key = typeof body.key === 'string' ? body.key : ''
    if (!key) return reply.code(400).send({ error: 'bad_request', message: 'key is required' })
    const record = { value: body.value ?? null, updatedAt: typeof body.updatedAt === 'number' ? body.updatedAt : Date.now() }
    uiState.set(`${user}:${key}`, record)
    return reply.code(200).send({ ok: true })
  })

  app.get('/api/runtime-config', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const query = req.query as Record<string, string | undefined>
    const scopeId = query.scopeId ?? personalScope
    const r = await relayJson(user, 'GET', `/v1/runtime-config?principalId=${enc(user)}&scopeId=${enc(scopeId)}`)
    if (r) return replyRelay(reply, r)
    return reply.code(200).send(runtimeConfigWire(scopeId, effectiveConfig))
  })

  app.put('/api/runtime-config', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const body = (req.body ?? {}) as Record<string, unknown>
    const scopeId = typeof body.scopeId === 'string' && body.scopeId ? body.scopeId : personalScope
    if (relay) {
      const payload = JSON.stringify({ ...body, principalId: user, scopeId })
      return replyRelay(reply, await relayJson(user, 'PUT', '/v1/runtime-config', payload))
    }
    if (typeof body.harnessId === 'string' && body.harnessId) effectiveConfig.harnessId = body.harnessId
    if (typeof body.modelId === 'string' && body.modelId) effectiveConfig.modelId = body.modelId
    if (typeof body.effortLevel === 'string') effectiveConfig.effortLevel = body.effortLevel
    if (typeof body.fastMode === 'boolean') effectiveConfig.fastMode = body.fastMode
    return reply.code(200).send(runtimeConfigWire(personalScope, effectiveConfig))
  })

  app.get('/api/deliveries/events', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    reply.hijack()
    sseHead(reply)
    const raw = reply.raw
    let closed = false
    req.raw.on('close', () => {
      closed = true
    })
    const beat = setInterval(() => {
      if (!closed) sseComment(raw, 'ping')
    }, SSE_HEARTBEAT_MS)
    beat.unref?.()
  })

  app.get('/api/search', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const query = req.query as Record<string, string | undefined>
    const q = query.q ?? ''
    const limit = query.limit ? `&limit=${encodeURIComponent(query.limit)}` : ''
    return replyRelay(
      reply,
      await relayJson(user, 'GET', `/v1/sessions/search?principalId=${encodeURIComponent(user)}&q=${encodeURIComponent(q)}${limit}`),
    )
  })

  app.get('/api/webhooks', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return replyRelay(reply, await relayJson(user, 'GET', `/v1/webhooks?viewer=${encodeURIComponent(user)}`))
  })

  app.post('/api/webhooks', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const body = (req.body ?? {}) as Record<string, unknown>
    const action = typeof body.action === 'string' ? body.action.trim() : ''
    if (!action) return reply.code(400).send({ error: 'action_required', message: "an action (the agent's instructions) is required" })
    let verification: { scheme: string; secret?: string } = { scheme: 'hmac-sha256' }
    if (body.verification !== undefined) {
      if (!isObj(body.verification) || typeof body.verification.scheme !== 'string') {
        return reply.code(400).send({
          error: 'unsupported_verification',
          message: 'verification requires one of the supported signature schemes',
        })
      }
      verification = {
        scheme: body.verification.scheme,
        ...(typeof body.verification.secret === 'string' && body.verification.secret ? { secret: body.verification.secret } : {}),
      }
    }
    if (!WEBHOOK_SCHEMES.includes(verification.scheme as (typeof WEBHOOK_SCHEMES)[number])) {
      return reply.code(400).send({
        error: 'unsupported_verification',
        message: 'choose one of the supported signature verification schemes',
      })
    }
    if (!verification.secret) verification = { ...verification, secret: randomBytes(32).toString('hex') }
    let filters: Array<{ path: string; in: string[] }> | undefined
    if (body.filters !== undefined) {
      const ok =
        Array.isArray(body.filters) &&
        body.filters.every((filter) => {
          if (!isObj(filter)) return false
          return (
            typeof filter.path === 'string' &&
            filter.path.trim().length > 0 &&
            Array.isArray(filter.in) &&
            filter.in.length > 0 &&
            filter.in.every((value) => typeof value === 'string' && value.trim().length > 0)
          )
        })
      if (!ok) {
        return reply.code(400).send({ error: 'invalid_filters', message: 'every filter requires a path and at least one value' })
      }
      filters = body.filters as Array<{ path: string; in: string[] }>
    }
    if (body.destination !== undefined) {
      return reply.code(400).send({
        error: 'invalid_destination',
        message: 'choose webhook destinations with the agent so teammate and channel names can be resolved safely',
      })
    }
    const payload = JSON.stringify({
      ownerScopeId: `personal:${user}`,
      owner: user,
      createdBy: user,
      action,
      verification,
      ...(filters ? { filters } : {}),
    })
    return replyRelay(reply, await relayJson(user, 'POST', '/v1/webhooks', payload))
  })

  const setWebhookEnabled = (enabled: boolean): import('fastify').RouteHandlerMethod => async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const listed = await relayJson(user, 'GET', `/v1/webhooks?viewer=${encodeURIComponent(user)}`)
    const body = listed?.status === 200 ? safeParse<{ webhooks?: Array<{ id?: string }> }>(listed.text) : null
    if (!body?.webhooks?.some((w) => w.id === id)) return notFound(reply)
    return replyRelay(
      reply,
      await relayJson(user, 'POST', `/v1/webhooks/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}?principalId=${encodeURIComponent(user)}`),
    )
  }
  app.post('/api/webhooks/:id/disable', setWebhookEnabled(false))
  app.post('/api/webhooks/:id/enable', setWebhookEnabled(true))

  app.get('/api/files', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const query = req.query as Record<string, string | undefined>
    const parts = new URLSearchParams({ viewer: user })
    if (query.limit) parts.set('limit', query.limit)
    if (query.cursor) parts.set('cursor', query.cursor)
    if (query.scope) parts.set('scope', query.scope)
    const r = await relayJson(user, 'GET', `/v1/files?${parts.toString()}`)
    if (!r || r.status !== 200) return replyRelay(reply, r)
    const page = safeParse<{ files?: Array<Record<string, unknown>>; nextCursor?: string }>(r.text)
    if (!page) return reply.code(502).send({ error: 'upstream_error' })
    const rows: Array<Record<string, unknown>> = (page.files ?? []).map((f) => ({ ...f, openable: true, kind: 'file' }))
    const owned = rows.filter((f) => f.ownerScopeId === `personal:${user}` || f.principalId === user)
    const shared = rows.filter((f) => !owned.includes(f))
    return reply.code(200).send({
      owned,
      shared,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    })
  })

  app.post('/api/blobs', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const query = req.query as Record<string, string | undefined>
    const sha = query.sha ?? ''
    if (!/^[0-9a-f]{64}$/.test(sha)) {
      return reply.code(400).send({ error: 'bad_request', message: 'sha (hex sha-256) required' })
    }
    if (!relay) return reply.code(503).send({ error: 'unavailable', message: 'api relay not wired' })
    const body = asBuffer(req.body)
    const staged = await relay.raw(user, 'POST', '/v1/blobs', body, { 'x-content-sha256': sha })
    return reply.code(staged.status).type('application/json').send(staged.text)
  })

  app.post('/api/files/upload', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const query = req.query as Record<string, string | undefined>
    const sha = query.sha ?? ''
    const name = query.name?.trim() || 'file'
    if (!/^[0-9a-f]{64}$/.test(sha)) {
      return reply.code(400).send({ error: 'bad_request', message: 'sha (hex sha-256) required' })
    }
    if (!relay) return reply.code(503).send({ error: 'unavailable', message: 'api relay not wired' })
    const bytes = asBuffer(req.body)
    const staged = await relay.raw(user, 'POST', '/v1/blobs', bytes, { 'x-content-sha256': sha })
    if (staged.status < 200 || staged.status >= 300) {
      return reply.code(staged.status).type('application/json').send(staged.text)
    }
    const stagedBody = safeParse<{ blobId?: string }>(staged.text)
    if (!stagedBody?.blobId) return reply.code(502).send({ error: 'upstream_error' })
    const mimetype = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : 'application/octet-stream'
    const payload = JSON.stringify({
      principalId: user,
      ...(query.scope ? { scopeId: query.scope } : {}),
      name,
      mimetype,
      blobId: stagedBody.blobId,
    })
    return replyRelay(reply, await relayJson(user, 'POST', '/v1/files/upload', payload))
  })

  app.get('/api/files/by-name/content', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const query = req.query as Record<string, string | undefined>
    const name = query.name?.trim()
    if (!name) return reply.code(400).send({ error: 'bad_request', message: 'name required' })
    if (!relay) return reply.code(503).send({ error: 'unavailable', message: 'api relay not wired' })
    let cursor: string | undefined
    let match: { id: string; createdAt: number } | undefined
    for (let page = 0; page < 50; page++) {
      const parts = new URLSearchParams({ viewer: user, limit: '200' })
      if (cursor) parts.set('cursor', cursor)
      const listed = await relay.json(user, 'GET', `/v1/files?${parts.toString()}`)
      if (listed.status !== 200) return reply.code(listed.status).type('application/json').send(listed.text)
      const body = safeParse<{ files?: Array<{ id?: string; name?: string; createdAt?: number }>; nextCursor?: string }>(listed.text)
      if (!body) return reply.code(502).send({ error: 'upstream_error' })
      for (const file of body.files ?? []) {
        if (file.name !== name || typeof file.id !== 'string') continue
        const createdAt = typeof file.createdAt === 'number' ? file.createdAt : 0
        if (!match || createdAt > match.createdAt) match = { id: file.id, createdAt }
      }
      cursor = body.nextCursor
      if (!cursor) break
    }
    if (!match) return notFound(reply)
    return reply.code(302).header('location', `/api/files/${encodeURIComponent(match.id)}/content`).send()
  })

  const streamArtifact = async (req: FastifyRequest, reply: FastifyReply, playground: boolean): Promise<FastifyReply> => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    if (!relay) return reply.code(503).send({ error: 'unavailable', message: 'api relay not wired' })
    const id = (req.params as { id: string }).id
    const r = await relay.json(user, 'GET', `/v1/files/${encodeURIComponent(id)}/content?viewer=${encodeURIComponent(user)}`)
    if (r.status !== 200) {
      return reply.code(r.status === 404 ? 404 : 502).type('application/json').send({ error: r.status === 404 ? 'not_found' : 'upstream_error' })
    }
    const contentType = r.contentType.toLowerCase()
    if (playground && !contentType.startsWith('text/html')) {
      return reply.code(415).type('application/json').send({ error: 'not_a_playground' })
    }
    const artifactQuery = req.query as Record<string, string | undefined>
    const asSource = playground && artifactQuery.source === '1'
    reply.raw.writeHead(200, {
      'content-type': asSource ? 'text/plain; charset=utf-8' : r.contentType,
      ...(r.body.length ? { 'content-length': String(r.body.length) } : {}),
      ...(playground ? {} : { 'content-disposition': 'inline' }),
      'content-security-policy': playground ? PLAYGROUND_CSP : UNTRUSTED_CONTENT_SANDBOX_CSP,
      'referrer-policy': 'no-referrer',
      ...(playground ? { 'x-frame-options': 'SAMEORIGIN' } : {}),
      'x-content-type-options': 'nosniff',
    })
    reply.raw.end(r.body)
    return reply
  }
  app.get('/api/files/:id/content', async (req, reply) => streamArtifact(req, reply, false))
  app.get('/api/playgrounds/:id', async (req, reply) => streamArtifact(req, reply, true))

  const enc = encodeURIComponent
  app.get('/api/deployments', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const r = await relayJson(user, 'GET', `/v1/deployments?principalId=${enc(user)}`)
    if (!r || r.status !== 200) return replyRelay(reply, r)
    const body = safeParse<{ deployments?: Array<Record<string, unknown>> }>(r.text)
    if (!body) return reply.code(502).send({ error: 'bad_core_response' })
    return reply.code(200).send({
      deployments: (body.deployments ?? []).map((d) => ({
        ...d,
        webUrl: `/deployments/${enc(String(d.id))}/`,
      })),
    })
  })

  app.get('/api/deployments/:id', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    if (!id || id.includes('/')) return notFound(reply)
    const r = await relayJson(user, 'GET', `/v1/deployments/${enc(id)}?principalId=${enc(user)}`)
    if (!r || r.status !== 200) return replyRelay(reply, r)
    const body = safeParse<{ deployment?: Record<string, unknown> }>(r.text)
    if (!body?.deployment) return reply.code(502).send({ error: 'bad_core_response' })
    return reply.code(200).send({
      deployment: { ...body.deployment, webUrl: `/deployments/${enc(String(body.deployment.id))}/` },
    })
  })

  app.get('/api/deployments/:id/owner-url', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    if (!id || id.includes('/')) return notFound(reply)
    return replyRelay(reply, await relayJson(user, 'GET', `/v1/deployments/${enc(id)}/owner-url?principalId=${enc(user)}`))
  })

  const mayManageDeployment = async (user: string, id: string): Promise<boolean> => {
    const r = await relayJson(user, 'GET', `/v1/deployments?principalId=${enc(user)}`)
    if (r?.status !== 200) return false
    const body = safeParse<{ deployments?: Array<{ id?: string; name?: string; permission?: unknown }> }>(r.text)
    const d = body?.deployments?.find((x) => x.id === id || x.name === id)
    return d?.permission === 'write'
  }

  const manageDeployment = (lane: 'display-name' | 'name' | 'archive' | 'restore', pick: (body: Record<string, unknown>) => string | undefined): import('fastify').RouteHandlerMethod => async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    if (!(await mayManageDeployment(user, id))) {
      const r = await relayJson(user, 'GET', `/v1/deployments?principalId=${enc(user)}`)
      if (!r || r.status !== 200) return replyRelay(reply, r)
      const body = safeParse<{ deployments?: Array<{ id?: string; name?: string }> }>(r.text)
      if (!body?.deployments?.some((x) => x.id === id || x.name === id)) return notFound(reply)
      return reply.code(403).send({ error: 'forbidden', message: 'you do not manage this deployment' })
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const field = pick(body)
    const payload = field !== undefined ? JSON.stringify({ [lane === 'display-name' ? 'displayName' : lane]: field }) : lane === 'restore' ? JSON.stringify({ principalId: user }) : undefined
    return replyRelay(reply, await relayJson(user, 'POST', `/v1/deployments/${enc(id)}/${lane}`, payload))
  }

  app.post('/api/deployments/:id/display-name', manageDeployment('display-name', (b) => String(b.displayName ?? '')))
  app.post('/api/deployments/:id/name', manageDeployment('name', (b) => String(b.name ?? '')))
  app.post('/api/deployments/:id/archive', manageDeployment('archive', () => undefined))
  app.post('/api/deployments/:id/restore', manageDeployment('restore', () => undefined))

  app.get('/api/connectors', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return replyRelay(reply, await relayJson(user, 'GET', `/v1/connectors/oauth/status?principalId=${enc(user)}`))
  })

  app.post('/api/connectors/:provider/start', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const provider = (req.params as { provider: string }).provider
    const publicUrl = (deps.publicUrl ?? '').replace(/\/$/, '')
    const params = new URLSearchParams({
      principalId: user,
      redirectUri: `${publicUrl}/v1/connectors/oauth/${enc(provider)}/callback`,
      returnTo: '/keychain',
    })
    return replyRelay(reply, await relayJson(user, 'GET', `/v1/connectors/oauth/${enc(provider)}/start?${params.toString()}`))
  })

  app.post('/api/connectors/revoke', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const body = (req.body ?? {}) as Record<string, unknown>
    const provider = typeof body.provider === 'string' ? body.provider : ''
    const host = typeof body.host === 'string' ? body.host : ''
    if (!provider && !host) return reply.code(400).send({ error: 'bad_request', message: 'provider or host required' })
    return replyRelay(
      reply,
      await relayJson(user, 'POST', '/v1/connectors/oauth/revoke', JSON.stringify({ principalId: user, ...(provider ? { provider } : { host }) })),
    )
  })

  app.get('/api/user-model-auth/status', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return replyRelay(reply, await relayJson(user, 'GET', `/v1/user-model-auth/status?principalId=${enc(user)}`))
  })

  app.post('/api/user-model-auth/api-key', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const body = (req.body ?? {}) as Record<string, unknown>
    return replyRelay(
      reply,
      await relayJson(user, 'POST', '/v1/user-model-auth/api-key', JSON.stringify({ principalId: user, provider: body.provider, apiKey: body.apiKey })),
    )
  })

  app.post('/api/user-model-auth/disconnect', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const body = (req.body ?? {}) as Record<string, unknown>
    return replyRelay(
      reply,
      await relayJson(user, 'POST', '/v1/user-model-auth/disconnect', JSON.stringify({ principalId: user, provider: body.provider })),
    )
  })

  app.post('/api/user-model-auth/chatgpt/start', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return replyRelay(reply, await relayJson(user, 'POST', '/v1/user-model-auth/chatgpt/start', JSON.stringify({ principalId: user })))
  })

  app.post('/api/user-model-auth/chatgpt/poll', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const body = (req.body ?? {}) as Record<string, unknown>
    return replyRelay(
      reply,
      await relayJson(user, 'POST', '/v1/user-model-auth/chatgpt/poll', JSON.stringify({ principalId: user, deviceAuthId: body.deviceAuthId, userCode: body.userCode })),
    )
  })

  app.post('/api/user-model-auth/claude/start', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return replyRelay(reply, await relayJson(user, 'POST', '/v1/user-model-auth/claude/start', JSON.stringify({ principalId: user })))
  })

  app.post('/api/user-model-auth/claude/complete', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const body = (req.body ?? {}) as Record<string, unknown>
    return replyRelay(
      reply,
      await relayJson(user, 'POST', '/v1/user-model-auth/claude/complete', JSON.stringify({ principalId: user, code: body.code, verifier: body.verifier })),
    )
  })

  app.get('/api/keychain/credentials', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return replyRelay(reply, await relayJson(user, 'GET', '/v1/keychain/credentials'))
  })

  app.get('/api/keychain/overview', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return replyRelay(reply, await relayJson(user, 'GET', '/v1/keychain/overview'))
  })

  app.post('/api/keychain/grants/:id/revoke', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    return replyRelay(reply, await relayJson(user, 'POST', `/v1/keychain/grants/${enc(id)}/revoke`, '{}'))
  })

  app.post('/api/keychain/drops', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const body = (req.body ?? {}) as Record<string, unknown>
    const draft = {
      ...(typeof body.service === 'string' ? { service: body.service } : {}),
      ...(typeof body.purpose === 'string' ? { purpose: body.purpose } : {}),
      ...(typeof body.envKey === 'string' ? { envKey: body.envKey } : {}),
    }
    return replyRelay(reply, await relayJson(user, 'POST', '/v1/keychain/drops', JSON.stringify(draft)))
  })

  app.delete('/api/keychain/credentials/:id', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    if (!id) return reply.code(400).send({ error: 'bad_request', message: 'credential id required' })
    return replyRelay(reply, await relayJson(user, 'DELETE', `/v1/keychain/credentials/${enc(id)}`))
  })

  app.get('/api/memory', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return replyRelay(reply, await relayJson(user, 'GET', `/v1/memory?principalId=${enc(user)}`))
  })

  app.put('/api/memory', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const body = (req.body ?? {}) as Record<string, unknown>
    if (typeof body.content !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'content must be a string' })
    }
    let revision = typeof body.revision === 'string' ? body.revision : ''
    if (!revision) {
      const head = await relayJson(user, 'GET', `/v1/memory?principalId=${enc(user)}`)
      revision = head?.status === 200 ? (safeParse<{ revision?: unknown }>(head.text)?.revision ?? '') as string : ''
      if (typeof revision !== 'string') revision = ''
    }
    return replyRelay(
      reply,
      await relayJson(user, 'PUT', '/v1/memory', JSON.stringify({ principalId: user, content: body.content, revision })),
    )
  })

  app.get('/api/memory/history', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return replyRelay(reply, await relayJson(user, 'GET', `/v1/memory/history?principalId=${enc(user)}`))
  })

  app.post('/api/memory/restore', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const body = (req.body ?? {}) as Record<string, unknown>
    const revision = typeof body.revision === 'string' ? body.revision : ''
    const expectedRevision = typeof body.expectedRevision === 'string' ? body.expectedRevision : ''
    return replyRelay(
      reply,
      await relayJson(user, 'POST', '/v1/memory/restore', JSON.stringify({ principalId: user, revision, expectedRevision })),
    )
  })

  app.post('/api/approvals/:requestId', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const requestId = (req.params as { requestId: string }).requestId
    if (!requestId || requestId.includes('/')) return notFound(reply)
    const body = (req.body ?? {}) as Record<string, unknown>
    const approved = body.approved === true
    // ADR-0010 continuation executor — the decision routes through
    // `applyApprovalDecision`; the SAME Run resumes or fails and no
    // successor Run is ever created here (plan Phase 7 checklist).
    const continuation = deps.approvalContinuation
    if (!continuation) {
      return reply.code(503).send({ error: 'approval_continuation_unavailable', message: 'approval executor not wired' })
    }
    const request = await continuation.approvals.get(requestId)
    if (!request) return notFound(reply)
    const targetRun = await continuation.runs.get(request.runId)
    if (!targetRun || !targetRun.request.conversation.threadRef.startsWith(`web:${user}:`)) {
      return notFound(reply)
    }
    const { decision, lifecycle } = await applyApprovalDecision(continuation, requestId, {
      approved,
      decidedBy: user,
    })
    if (decision.outcome === 'not_found') return notFound(reply)
    if (decision.outcome === 'forbidden') {
      return reply.code(403).send({ error: 'forbidden', message: 'only the original requester may decide' })
    }
    const state =
      lifecycle.outcome === 'continuation_started'
        ? 'resuming'
        : lifecycle.outcome === 'run_failed'
          ? 'failed'
          : 'already_decided'
    return reply.code(state === 'already_decided' ? 200 : 202).send({ runId: request.runId, state })
  })

  app.get('/api/directory/resolve', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return reply.code(200).send({ matches: [] })
  })

  app.get('/api/channel-header-pin', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const query = req.query as Record<string, string | undefined>
    return reply.code(200).send({ scopeId: query.scopeId ?? '', on: false, configured: false, default: false })
  })

  app.get('/api/surface-config', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return reply.code(200).send({})
  })

  if (opts.distDir) {
    const distRoot = resolve(opts.distDir)
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/me')) return notFound(reply)
      if (req.method !== 'GET') return notFound(reply)
      const pathname = decodeURIComponent((req.raw.url ?? '/').split('?')[0] ?? '/')
      if (pathname.includes('..')) return notFound(reply)
      const candidate = resolve(join(distRoot, pathname === '/' ? 'index.html' : pathname))
      if (candidate === distRoot || candidate.startsWith(distRoot + sep)) {
        const served = await serveFile(reply, candidate)
        if (served) return served
      }
      const fallback = await serveFile(reply, join(distRoot, 'index.html'))
      if (fallback) return fallback
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('web-ui: dist-web/ is not built — run `pnpm --filter @qm/web-ui build`')
    })
  }

  return app
}
