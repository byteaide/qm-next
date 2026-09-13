/**
 * The web-ui server half: the SPA's HTTP surface over the M1/M3 stores.
 * Cookie principal (dev mode, loopback bind), turn/run proxy, SSE
 * run-events off the frozen RunEventBus, live skills/crons/contexts
 * views, and stub-empty answers for every surface outside the M3
 * boundary (files, webhooks, connectors, deploys, memory, ...).
 */
import { createFireEngine, manualFireKey, renderCronFireInput, type CronSchedule, type CronStore } from '@qm/triggers'
import type { DirectoryStore } from '@qm/directory'
import type { SkillStore } from '@qm/skills'
import type {
  Conversation,
  Orchestrator,
  ResolutionService,
  Run,
  RunEvent,
  RunEventBus,
  RunStore,
  SessionStore,
  TurnApproval,
  TurnInput,
} from '@qm/types'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { clearSessionCookie, cookieUser, sessionCookie } from './principal.ts'
import {
  contextWire,
  cronWire,
  entryWire,
  runWire,
  sessionWire,
  skillWire,
  type RunPollWire,
  type SkillItemWire,
} from './wire.ts'

export interface WebUiDeps {
  orchestrator: Orchestrator
  sessions: SessionStore
  runs: RunStore
  resolution: ResolutionService
  runEvents: RunEventBus
  skills: SkillStore
  crons: CronStore
  directory: DirectoryStore
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

function authed(req: FastifyRequest): string | null {
  return cookieUser(req)
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({ mode: 'dev', reason: 'unauthenticated' })
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
  mode: 'dev'
  impersonatedBy: string | null
  permissions: string[]
  individualModelAuth: boolean
  modelAuthConnected: boolean
}

function meWire(user: string, org: string): MeWire {
  return {
    user,
    org,
    mode: 'dev',
    impersonatedBy: null,
    permissions: ['admin'],
    individualModelAuth: false,
    modelAuthConnected: false,
  }
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
  const uiState = new Map<string, { value: unknown; updatedAt: number }>()
  const effectiveConfig: RuntimeConfigWire['effective'] = { harnessId: 'mock', modelId: DEV_MODEL_ID }
  const fireEngine = createFireEngine({
    sessions: deps.sessions,
    runs: deps.runs,
    resolution: deps.resolution,
  })

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

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
    if (!user) return unauthorized(reply)
    return reply.code(200).header('set-cookie', sessionCookie(user)).send(meWire(user, opts.org ?? 'dev'))
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

  app.get('/api/runs/:id/events', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const id = (req.params as { id: string }).id
    const initial = await deps.runs.get(id)
    if (!initial) return notFound(reply)
    reply.hijack()
    sseHead(reply)
    const raw = reply.raw
    let acc = ''
    let lastSeq = -1
    let finished = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const pending: RunEvent[] = []
    const unsub = deps.runEvents.subscribe(id, (ev) => {
      if (!finished) pending.push(ev)
    })
    const teardown = (): void => {
      finished = true
      if (heartbeat) clearInterval(heartbeat)
      unsub()
    }
    const finish = async (): Promise<void> => {
      if (finished) return
      teardown()
      const run = await deps.runs.get(id)
      const wire: RunPollWire | null = run ? runWire(run) : null
      if (raw.writableEnded) return
      sseEvent(raw, 'done', {
        status: wire?.status ?? null,
        result: wire?.result ?? null,
        partial: acc,
        activity: [],
        replyComplete: false,
        startedAt: wire?.startedAt ?? null,
        finishedAt: wire?.finishedAt ?? null,
      })
      raw.end()
    }
    const process = (ev: RunEvent): void => {
      if (finished || ev.seq <= lastSeq) return
      lastSeq = ev.seq
      if (ev.kind === 'delta') {
        acc += ev.text
        sseEvent(raw, 'partial', { partial: acc })
      } else if (ev.kind === 'progress') {
        sseEvent(raw, 'alive', { at: Date.now() })
      } else if (ev.status !== 'running') {
        void finish()
      }
    }
    for (const ev of deps.runEvents.replay(id)) process(ev)
    for (const ev of pending.splice(0)) process(ev)
    if (!finished && (initial.status === 'done' || initial.status === 'failed')) await finish()
    if (!finished) sseEvent(raw, 'alive', { at: Date.now() })
    req.raw.on('close', teardown)
    heartbeat = setInterval(() => {
      if (finished) return
      sseComment(raw, 'ping')
    }, SSE_HEARTBEAT_MS)
    heartbeat.unref?.()
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
    return reply.code(200).send(runtimeConfigWire(query.scopeId ?? personalScope, effectiveConfig))
  })

  app.put('/api/runtime-config', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    const body = (req.body ?? {}) as Record<string, unknown>
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
    return reply.code(200).send({ hits: [] })
  })

  app.get('/api/webhooks', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return reply.code(200).send({ webhooks: [] })
  })

  app.get('/api/files', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return reply.code(200).send({ owned: [], shared: [] })
  })

  app.get('/api/deployments', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return reply.code(200).send({ deployments: [] })
  })

  app.get('/api/connectors', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return reply.code(200).send({ providers: {} })
  })

  app.get('/api/user-model-auth/status', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return reply.code(200).send({ individualModelAuth: false, connections: [] })
  })

  app.get('/api/keychain/overview', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return reply.code(200).send({ credentials: [], grants: [], drops: [] })
  })

  app.get('/api/memory', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return reply.code(200).send({ content: '', revision: '0' })
  })

  app.post('/api/memory', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return reply.code(501).send({ error: 'unavailable', message: 'memory editing wires up at the M3 convergence (17.0)' })
  })

  app.get('/api/memory/history', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return reply.code(200).send({ revisions: [] })
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

  app.all('/api/blobs', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return reply.code(501).send({ error: 'unavailable', message: 'file uploads are out of scope for M3' })
  })

  app.all('/api/playgrounds/:id', async (req, reply) => {
    const user = authed(req)
    if (!user) return unauthorized(reply)
    return reply.code(501).send({ error: 'unavailable', message: 'playground is out of scope for M3' })
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
