/**
 * Surface routes (parity contract "surface", sessions + conversations
 * families): the web-admin face (source auth, `principalId`/`viewer` axes)
 * and the agent self-API (`either` auth, `401 capability_required` without
 * a principal). Transcript windowing mirrors qm's `windowedTranscript`
 * (tailTurns counts user entries; beforeSeq/sinceSeq cuts) minus the byte-
 * budget trimming — deviation #42. Background views and the portal session
 * capability are dep-gated (control plane, 12.0).
 */
import type { GetEntriesOptions, Orchestrator, RunStore, Session, SessionEntry, SessionStore } from '@qm/types'
import type { ApiRouteContext, Route } from './framework.ts'
import { badRequest, isObj, notFound, sendJson } from './framework.ts'
import { createTranscriptSource } from '@qm/store'

export interface SurfaceRoutesDeps {
  sessions: SessionStore
  orchestrator: Orchestrator
  runs?: RunStore
  /** Scope for agent-spawned conversations (org scope in lane A). */
  scopeFor?: () => string
  /** Background-process view; lands with the sandbox process sessions lane. */
  background?: {
    view(sessionId: string, viewer: string): Promise<unknown | null>
    output(sessionId: string, pid: string, viewer: string, sinceCursor: number): Promise<unknown | null>
  }
}

interface TranscriptWindow {
  tailTurns?: number
  sinceSeq?: number
  beforeSeq?: number
}

/** qm `transcriptWindow`: integer bounds with per-param minimums. */
function parseWindow(query: Record<string, string>, defaultTailTurns?: number): TranscriptWindow | null {
  const param = (name: string, min: number): number | undefined | null => {
    const raw = query[name]
    if (raw === undefined) return undefined
    const n = Number(raw)
    return Number.isInteger(n) && n >= min ? n : null
  }
  const tailTurns = param('tailTurns', 1)
  const sinceSeq = param('sinceSeq', 0)
  const beforeSeq = param('beforeSeq', 1)
  if (tailTurns === null || sinceSeq === null || beforeSeq === null) return null
  const tail = tailTurns ?? (sinceSeq === undefined ? defaultTailTurns : undefined)
  if (tail === undefined && sinceSeq === undefined && beforeSeq === undefined) return {}
  return {
    ...(tail !== undefined ? { tailTurns: tail } : {}),
    ...(sinceSeq !== undefined ? { sinceSeq } : {}),
    ...(beforeSeq !== undefined ? { beforeSeq } : {}),
  }
}

/** qm `transcriptEntries` (drop soul) + `windowedTranscript` (cuts + earlier count). */
function windowed(entries: SessionEntry[], window?: TranscriptWindow): { entries: SessionEntry[]; earlier: number } {
  const transcript = entries.filter((e) => e.type !== 'soul')
  let cut = 0
  let list = transcript
  if (window?.beforeSeq !== undefined) {
    const at = list.findIndex((e) => e.seq >= window.beforeSeq!)
    list = list.slice(0, at < 0 ? list.length : at)
  }
  if (window?.sinceSeq !== undefined) {
    const at = list.findIndex((e) => e.seq >= window.sinceSeq!)
    cut = at < 0 ? list.length : at
    list = list.slice(cut)
  } else if (window?.tailTurns !== undefined && window.tailTurns > 0) {
    let turns = 0
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.type !== 'user') continue
      if (++turns === window.tailTurns) {
        cut = i
        break
      }
    }
    list = cut > 0 ? list.slice(cut) : list
  }
  return { entries: list, earlier: cut }
}

function isColor(v: unknown): v is string | null {
  return v === null || (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v))
}

function conversationView(s: Session): Record<string, unknown> {
  return {
    id: s.id,
    scopeId: s.scopeId,
    surface: s.surface || 'unknown',
    title: s.title ?? null,
    archived: s.archived === true,
    pinned: s.pinned === true,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt ?? s.createdAt,
  }
}

export function surfaceRoutes(deps: SurfaceRoutesDeps): ReadonlyArray<Route> {
  const scopeOf = () => deps.scopeFor?.() ?? 'org:default'

  async function sessionForViewer(id: string, principalId: string): Promise<Session | null> {
    const visible = await deps.sessions.listByParticipant(principalId)
    return visible.find((s) => s.id === id) ?? null
  }

  async function transcriptFor(id: string, window?: TranscriptWindow): Promise<{ session: Session; entries: SessionEntry[]; earlierEntries?: number } | null> {
    const session = await deps.sessions.get(id)
    if (!session) return null
    // M-Tape-3 (2026-09-26): render via `createTranscriptSource.forRender`.
    // The projection is the canonical renderer source; coverage-failing
    // sessions transparently fall back to entry reconstruction inside
    // `forRender` (qm `tape-projection.ts:469-484`). The legacy
    // `windowed()` tail-turns cut applies on top so the tailTurns
    // semantic (last N user entries) survives the projection switch.
    const projectionOpts: GetEntriesOptions = {
      ...(window?.beforeSeq !== undefined ? { beforeSeq: window.beforeSeq } : {}),
      ...(window?.sinceSeq !== undefined ? { sinceSeq: window.sinceSeq } : {}),
    }
    const projection = createTranscriptSource(deps.sessions)
    const read = await projection.forRender(id, projectionOpts)
    const w = windowed(read.entries, window)
    return { session, entries: w.entries, ...(w.earlier > 0 ? { earlierEntries: w.earlier } : {}) }
  }

  function patchOf(ctx: ApiRouteContext): Record<string, unknown> | null {
    const b = isObj(ctx.body) ? ctx.body : {}
    const patch: Record<string, unknown> = {}
    if ('title' in b) {
      if (b.title !== null && typeof b.title !== 'string') {
        badRequest(ctx, 'title must be a string or null')
        return null
      }
      const trimmed = typeof b.title === 'string' ? b.title.trim().slice(0, 200) : null
      patch.title = trimmed ? trimmed : null
    }
    if ('archived' in b) {
      if (typeof b.archived !== 'boolean') {
        badRequest(ctx, 'archived must be a boolean')
        return null
      }
      patch.archived = b.archived
    }
    if ('pinned' in b) {
      if (typeof b.pinned !== 'boolean') {
        badRequest(ctx, 'pinned must be a boolean')
        return null
      }
      patch.pinned = b.pinned
    }
    if ('color' in b) {
      if (!isColor(b.color)) {
        badRequest(ctx, "color must be '#rrggbb' or null")
        return null
      }
      patch.color = typeof b.color === 'string' ? b.color.toLowerCase() : null
    }
    if (!Object.keys(patch).length) {
      badRequest(ctx, 'title, archived, pinned, or color required')
      return null
    }
    return patch
  }

  return [
    // --- sessions (web admin face, auth source) ---
    {
      // Portal capability minting arrives with the control plane (12.0).
      method: 'POST',
      path: '/v1/session-cap',
      auth: 'source',
      handle: async (ctx) => {
        if (!ctx.actor) return sendJson(ctx, 401, { error: 'unauthorized', message: 'portal identity required' })
        return sendJson(ctx, 503, { error: 'not_configured', message: 'capability minting lands with the control plane (12.0)' })
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions',
      auth: 'source',
      handle: async (ctx) => {
        const principalId = ctx.query.principalId
        if (!principalId) return badRequest(ctx, 'principalId required')
        return sendJson(ctx, 200, { sessions: await deps.sessions.listByParticipant(principalId) })
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions/search',
      auth: 'source',
      handle: async (ctx) => {
        const principalId = ctx.query.principalId
        if (!principalId) return badRequest(ctx, 'principalId required')
        const q = ctx.query.q ?? ''
        const limitRaw = Number(ctx.query.limit)
        const limit = Number.isInteger(limitRaw) && limitRaw >= 1 ? Math.min(limitRaw, 100) : 20
        const hits = await deps.sessions.searchEntries(principalId, q, limit)
        const visible = new Map((await deps.sessions.listByParticipant(principalId)).map((s) => [s.id, s]))
        const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
        return sendJson(ctx, 200, {
          hits: hits.flatMap((hit) => {
            const session = visible.get(hit.sessionId)
            if (!session) return []
            const lower = hit.text.toLowerCase()
            const at = terms.length ? lower.indexOf(terms[0]!) : -1
            const snippet = at >= 0 ? hit.text.slice(Math.max(0, at - 40), at + 120) : hit.text.slice(0, 120)
            return [
              {
                sessionId: hit.sessionId,
                title: session.title ?? null,
                scopeId: session.scopeId,
                ...(session.channelName ? { channelName: session.channelName } : {}),
                ...(session.surface ? { surface: session.surface } : {}),
                seq: hit.seq,
                entryType: hit.type,
                snippet,
                createdAt: hit.createdAt,
                ...(session.archived ? { archived: true } : {}),
              },
            ]
          }),
        })
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions/:id',
      auth: 'source',
      handle: async (ctx) => {
        const viewer = ctx.query.viewer
        if (!viewer) return badRequest(ctx, 'viewer required')
        const w = parseWindow(ctx.query)
        if (!w) return badRequest(ctx, 'tailTurns and beforeSeq must be positive integers, sinceSeq a non-negative one')
        if (!(await sessionForViewer(ctx.params.id ?? '', viewer))) return notFound(ctx)
        const found = await transcriptFor(ctx.params.id ?? '', w)
        if (!found) return notFound(ctx)
        return sendJson(ctx, 200, found)
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions/:id/entries/:seq',
      auth: 'source',
      handle: async (ctx) => {
        const viewer = ctx.query.viewer
        if (!viewer) return badRequest(ctx, 'viewer required')
        const seq = Number(ctx.params.seq)
        if (!Number.isInteger(seq) || seq < 0) return badRequest(ctx, 'seq must be a non-negative integer')
        if (!(await sessionForViewer(ctx.params.id ?? '', viewer))) return notFound(ctx)
        // M-Tape-3 / A.3.4: personal-scope tool result filtering. The
        // legacy path returned any entry the viewer could see by
        // participant membership; `forViewer` additionally applies
        // `entryWithinTenure` against the viewer's participant window
        // so a personal-scope tool result stays out of channel-audience
        // reads (qm `tape-projection.ts:485-519`).
        const projection = createTranscriptSource(deps.sessions)
        const read = await projection.forViewer(ctx.params.id ?? '', viewer)
        const entry = read.entries.find((e) => e.seq === seq)
        if (!entry) return notFound(ctx)
        return sendJson(ctx, 200, { entry })
      },
    },
    {
      method: 'POST',
      path: '/v1/sessions/:id',
      auth: 'source',
      handle: async (ctx) => {
        const b = isObj(ctx.body) ? ctx.body : {}
        const principalId = typeof b.principalId === 'string' ? b.principalId : null
        if (!principalId) return badRequest(ctx, 'principalId required')
        const patch = patchOf(ctx)
        if (!patch) return
        if (!(await sessionForViewer(ctx.params.id ?? '', principalId))) return notFound(ctx)
        const session = await deps.sessions.patchSession(ctx.params.id ?? '', patch)
        if (!session) return notFound(ctx)
        return sendJson(ctx, 200, { session })
      },
    },
    {
      method: 'POST',
      path: '/v1/sessions/:id/title',
      auth: 'source',
      handle: async (ctx) => {
        const b = isObj(ctx.body) ? ctx.body : {}
        const principalId = typeof b.principalId === 'string' ? b.principalId : null
        if (!principalId) return badRequest(ctx, 'principalId required')
        const id = ctx.params.id ?? ''
        if (!(await sessionForViewer(id, principalId))) return notFound(ctx)
        // Lane A: deterministic title from the first user entry (qm uses the
        // LLM title pass; deviation #42).
        const seed = (await deps.sessions.getEntries(id)).find((e) => e.type === 'user')
        const text = typeof (seed?.payload as { text?: unknown })?.text === 'string' ? (seed!.payload as { text: string }).text : ''
        const title = text.trim().slice(0, 60) || null
        await deps.sessions.patchSession(id, { title })
        return sendJson(ctx, 200, { title })
      },
    },
    {
      method: 'POST',
      path: '/v1/sessions/:id/fork',
      auth: 'source',
      handle: async (ctx) => {
        const b = isObj(ctx.body) ? ctx.body : {}
        const principalId = typeof b.principalId === 'string' ? b.principalId : null
        if (!principalId) return badRequest(ctx, 'principalId required')
        if (b.upToSeq !== undefined && (typeof b.upToSeq !== 'number' || !Number.isInteger(b.upToSeq) || b.upToSeq < 0)) {
          return badRequest(ctx, 'upToSeq must be a non-negative integer')
        }
        if (!(await sessionForViewer(ctx.params.id ?? '', principalId))) return notFound(ctx)
        const out = await deps.sessions.forkSession(ctx.params.id ?? '', principalId, b.upToSeq !== undefined ? { upToSeq: b.upToSeq } : undefined)
        if (!out) return notFound(ctx)
        return sendJson(ctx, 200, out)
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions/:id/approvals',
      auth: 'source',
      handle: async (ctx) => {
        const viewer = ctx.query.viewer
        if (!viewer) return badRequest(ctx, 'viewer required')
        // Approval records wired with the approvals control-plane lane (12.0);
        // no store here means the empty answer qm gives without pending rows.
        return sendJson(ctx, 200, { approvals: [] })
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions/:id/background',
      auth: 'source',
      handle: async (ctx) => {
        const viewer = ctx.query.viewer
        if (!viewer) return badRequest(ctx, 'viewer required')
        if (!deps.background) return notFound(ctx)
        const view = await deps.background.view(ctx.params.id ?? '', viewer)
        if (!view) return notFound(ctx)
        return sendJson(ctx, 200, view)
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions/:id/background/:pid/output',
      auth: 'source',
      handle: async (ctx) => {
        const viewer = ctx.query.viewer
        if (!viewer) return badRequest(ctx, 'viewer required')
        const sinceCursor = Math.max(0, Number(ctx.query.sinceCursor ?? '0') || 0)
        if (!deps.background) return notFound(ctx)
        const read = await deps.background.output(ctx.params.id ?? '', ctx.params.pid ?? '', viewer, sinceCursor)
        if (!read) return notFound(ctx)
        return sendJson(ctx, 200, read)
      },
    },

    // --- conversations (agent self-API, auth either) ---
    {
      method: 'GET',
      path: '/v1/conversations',
      auth: 'either',
      handle: async (ctx) => {
        if (!ctx.actor) return sendJson(ctx, 401, { error: 'capability_required', message: 'this endpoint is for the agent self-API' })
        const sessions = await deps.sessions.listByParticipant(ctx.actor.id)
        return sendJson(ctx, 200, { conversations: sessions.map(conversationView) })
      },
    },
    {
      method: 'GET',
      path: '/v1/conversations/:id',
      auth: 'either',
      handle: async (ctx) => {
        if (!ctx.actor) return sendJson(ctx, 401, { error: 'capability_required', message: 'this endpoint is for the agent self-API' })
        if (ctx.query.sinceSeq !== undefined) {
          return badRequest(ctx, 'agent transcript paging supports tailTurns and beforeSeq')
        }
        const w = parseWindow(ctx.query, 20)
        if (!w) return badRequest(ctx, 'tailTurns and beforeSeq must be positive integers, sinceSeq a non-negative one')
        if (!(await sessionForViewer(ctx.params.id ?? '', ctx.actor.id))) {
          return sendJson(ctx, 404, { error: 'not_found', message: 'not a conversation you can see' })
        }
        const found = await transcriptFor(ctx.params.id ?? '', w)
        if (!found) return notFound(ctx)
        return sendJson(ctx, 200, found)
      },
    },
    {
      method: 'POST',
      path: '/v1/conversations/:id',
      auth: 'either',
      handle: async (ctx) => {
        if (!ctx.actor) return sendJson(ctx, 401, { error: 'capability_required', message: 'this endpoint is for the agent self-API' })
        const patch = patchOf(ctx)
        if (!patch) return
        const session = await deps.sessions.patchSession(ctx.params.id ?? '', patch)
        if (!session) return sendJson(ctx, 404, { error: 'not_found', message: 'not a conversation you can see' })
        return sendJson(ctx, 200, {
          conversation: {
            id: session.id,
            title: session.title ?? null,
            archived: session.archived === true,
            pinned: session.pinned === true,
            color: session.color ?? null,
          },
        })
      },
    },
    {
      method: 'POST',
      path: '/v1/conversations',
      auth: 'either',
      handle: async (ctx) => {
        if (!ctx.actor) return sendJson(ctx, 401, { error: 'capability_required', message: 'this endpoint is for the agent self-API' })
        const b = isObj(ctx.body) ? ctx.body : {}
        if (typeof b.text !== 'string' || !b.text.trim()) return badRequest(ctx, "text required — the new session's first message")
        if (b.title !== undefined && typeof b.title !== 'string') return badRequest(ctx, 'title must be a string')
        const actor = ctx.actor
        const session = await deps.sessions.getOrCreateByThread(
          `web:${actor.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          'dm',
          scopeOf(),
          'web',
        )
        await deps.sessions.addParticipant(session.id, actor.id)
        if (typeof b.title === 'string') await deps.sessions.patchSession(session.id, { title: b.title.trim().slice(0, 200) || null })
        const turn = await deps.orchestrator.handleTurn({
          surface: 'web',
          actor,
          conversation: { kind: 'dm', threadRef: session.threadRef, audience: [actor] },
          origin: { kind: 'direct' },
          text: b.text,
        })
        if (turn.status === 'refused') {
          await deps.sessions.discardSession(session.id, actor.id)
          return sendJson(ctx, 409, {
            error: 'seed_turn_refused',
            message: (turn as { reason?: string }).reason ?? 'the first message was refused',
          })
        }
        return sendJson(ctx, 202, { session, turn: { status: turn.status, ...(turn.status === 'queued' && 'runId' in turn ? { runId: (turn as { runId?: string }).runId } : {}) } })
      },
    },
    {
      method: 'POST',
      path: '/v1/conversations/:id/fork',
      auth: 'either',
      handle: async (ctx) => {
        if (!ctx.actor) return sendJson(ctx, 401, { error: 'capability_required', message: 'this endpoint is for the agent self-API' })
        const b = isObj(ctx.body) ? ctx.body : {}
        if (b.upToSeq !== undefined && (typeof b.upToSeq !== 'number' || !Number.isInteger(b.upToSeq) || b.upToSeq < 0)) {
          return badRequest(ctx, 'upToSeq must be a non-negative integer')
        }
        if (!(await sessionForViewer(ctx.params.id ?? '', ctx.actor.id))) {
          return sendJson(ctx, 404, { error: 'not_found', message: 'not a conversation you can see' })
        }
        const out = await deps.sessions.forkSession(ctx.params.id ?? '', ctx.actor.id, b.upToSeq !== undefined ? { upToSeq: b.upToSeq } : undefined)
        if (!out) return notFound(ctx)
        return sendJson(ctx, 200, out)
      },
    },
  ]
}
