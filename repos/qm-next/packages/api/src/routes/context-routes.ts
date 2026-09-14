/**
 * Parity surface-context routes (11.0 tranche 5, contract "context"): the
 * agent self-API asks for channel context or a file, the surface connector
 * long-polls `/pending` and answers `/result`, and the original request
 * awaits fulfillment with qm's timeout ladder. Lane-A cuts (deviation #44):
 * the channel-visibility pre-checks (`not_visible`/`identity_unverified`,
 * resolution ambiguity) need the surface channel registry — requests queue
 * as addressed instead — and `/v1/surface-file` answers `download: null`
 * because blob-read capability tokens land with the control plane (12.0).
 */
import type { ApiRouteContext, Route } from './framework.ts'
import { isObj, sendJson } from './framework.ts'
import type { ContextOutcome, PendingContextRequest, SurfaceContextQueue, SurfaceContextResult, SurfaceFileMeta } from '../services/surface-context-queue.ts'

const SURFACE_CONTEXT_MAX_MESSAGES = 200
const SURFACE_CONTEXT_DEFAULT_MESSAGES = 100
const FULFILL_WAIT_MS = 25_000
const FULFILL_POLL_MS = 100
const PENDING_WAIT_CAP_MS = 20_000
const PENDING_POLL_MS = 100
const FILE_FULFILL_WAIT_MS = 120_000

export interface ContextRoutesDeps {
  queue: SurfaceContextQueue
  fulfillWaitMs?: number
  fileFulfillWaitMs?: number
  pollMs?: number
}

type SurfaceTarget = { source: string; target: { channelId?: string; channelName?: string; conversationTarget?: string } }

function requireViewer(ctx: ApiRouteContext): string | null {
  if (!ctx.actor) {
    sendJson(ctx, 401, { error: 'capability_required', message: 'this endpoint is for the agent self-API' })
    return null
  }
  return ctx.actor.id
}

function resolveSurfaceTarget(ctx: ApiRouteContext, body: Record<string, unknown>): SurfaceTarget | null {
  if (typeof body.channel === 'string' && body.channel.trim()) {
    const ref = body.channel.trim().replace(/^#/, '')
    if (/^[CG][A-Z0-9]{6,}$/.test(ref)) return { source: 'slack', target: { channelId: ref } }
    return { source: 'slack', target: { channelName: ref } }
  }
  sendJson(ctx, 400, {
    error: 'no_conversation',
    message: 'this conversation has no surface history to pull — name a channel instead',
  })
  return null
}

async function awaitOutcome(
  ctx: ApiRouteContext,
  deps: ContextRoutesDeps,
  requestId: string,
  waitMs: number,
): Promise<{ status: 'done'; result: SurfaceContextResult } | null> {
  const outcome = await deps.queue.await(requestId, { waitMs, pollMs: deps.pollMs ?? FULFILL_POLL_MS })
  if (outcome.status === 'timeout') {
    sendJson(ctx, 504, { error: 'surface_timeout', message: "the surface didn't answer in time — try again" })
    return null
  }
  if ('error' in outcome.outcome) {
    sendJson(ctx, 502, { error: 'surface_error', message: outcome.outcome.error || "the surface couldn't answer that" })
    return null
  }
  return { status: 'done', result: outcome.outcome.result }
}

export function contextRoutes(deps: ContextRoutesDeps): ReadonlyArray<Route> {
  return [
    {
      method: 'POST',
      path: '/v1/surface-context',
      auth: 'either',
      handle: async (ctx) => {
        const viewer = requireViewer(ctx)
        if (!viewer) return
        const body = isObj(ctx.body) ? ctx.body : {}
        const count = Math.max(
          1,
          Math.min(
            SURFACE_CONTEXT_MAX_MESSAGES,
            typeof body.count === 'number' ? Math.floor(body.count) : SURFACE_CONTEXT_DEFAULT_MESSAGES,
          ),
        )
        const before = typeof body.before === 'string' && body.before.trim() ? body.before.trim() : undefined
        const match = typeof body.match === 'string' && body.match.trim() ? body.match.trim().slice(0, 200) : undefined
        const resolved = resolveSurfaceTarget(ctx, body)
        if (!resolved) return
        const request = deps.queue.create(resolved.source, {
          ...resolved.target,
          viewer,
          count,
          ...(before ? { before } : {}),
          ...(match ? { match } : {}),
        })
        const outcome = await awaitOutcome(ctx, deps, request.id, deps.fulfillWaitMs ?? FULFILL_WAIT_MS)
        if (!outcome) return
        const channelName = request.query.channelName
        return sendJson(ctx, 200, {
          ...(channelName ? { channel: `#${channelName}` } : {}),
          ...outcome.result,
        })
      },
    },
    {
      method: 'POST',
      path: '/v1/surface-file',
      auth: 'either',
      handle: async (ctx) => {
        const viewer = requireViewer(ctx)
        if (!viewer) return
        const body = isObj(ctx.body) ? ctx.body : {}
        const ts = typeof body.ts === 'string' && body.ts.trim() ? body.ts.trim() : undefined
        if (!ts) {
          return sendJson(ctx, 400, {
            error: 'bad_request',
            message: "pass the message's `ts` (find it via /v1/surface-context)",
          })
        }
        const threadTs = typeof body.threadTs === 'string' && body.threadTs.trim() ? body.threadTs.trim() : undefined
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined
        const resolved = resolveSurfaceTarget(ctx, body)
        if (!resolved) return
        const request = deps.queue.create(resolved.source, {
          ...resolved.target,
          viewer,
          count: 1,
          file: { ts, ...(threadTs ? { threadTs } : {}), ...(name ? { name } : {}) },
        })
        const outcome = await awaitOutcome(ctx, deps, request.id, deps.fileFulfillWaitMs ?? FILE_FULFILL_WAIT_MS)
        if (!outcome) return
        const file: SurfaceFileMeta | undefined = outcome.result.file
        if (!file) {
          return sendJson(ctx, 502, {
            error: 'surface_error',
            message: "the surface can't fetch files yet (it may be mid-deploy) — tell the person plainly rather than retrying",
          })
        }
        const { blobId: _blobId, ...meta } = file
        return sendJson(ctx, 200, { file: meta, download: null })
      },
    },
    {
      method: 'GET',
      path: '/v1/surface-context/pending',
      auth: 'source',
      handle: async (ctx) => {
        const source = ctx.query.source ?? 'slack'
        const waitMs = Math.max(0, Math.min(PENDING_WAIT_CAP_MS, Number(ctx.query.waitMs) || 0))
        const deadline = Date.now() + waitMs
        let requests: PendingContextRequest[] = deps.queue.pending(source)
        while (!requests.length && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? PENDING_POLL_MS))
          requests = deps.queue.pending(source)
        }
        return sendJson(ctx, 200, {
          requests: requests.map((r) => ({ id: r.id, query: r.query })),
        })
      },
    },
    {
      method: 'POST',
      path: '/v1/surface-context/:id/result',
      auth: 'source',
      handle: async (ctx) => {
        const id = ctx.params.id
        if (!id) return sendJson(ctx, 404, { error: 'not_found', message: 'request expired or already answered' })
        const body = isObj(ctx.body) ? ctx.body : {}
        const f = isObj(body.file) ? body.file : undefined
        const file =
          f && typeof f.blobId === 'string' && typeof f.name === 'string' && typeof f.sizeBytes === 'number'
            ? {
                blobId: f.blobId,
                name: f.name,
                sizeBytes: f.sizeBytes,
                ...(typeof f.mimetype === 'string' ? { mimetype: f.mimetype } : {}),
                ...(typeof f.author === 'string' ? { author: f.author } : {}),
              }
            : undefined
        const g = isObj(body.group) ? body.group : undefined
        const group = g && typeof g.groupId === 'string' && g.groupId ? { groupId: g.groupId } : undefined
        const outcome: ContextOutcome =
          typeof body.error === 'string'
            ? { error: body.error }
            : {
                result: {
                  messages: Array.isArray(body.messages) ? body.messages : [],
                  ...(typeof body.hasMore === 'boolean' ? { hasMore: body.hasMore } : {}),
                  ...(typeof body.nextBefore === 'string' ? { nextBefore: body.nextBefore } : {}),
                  ...(typeof body.note === 'string' ? { note: body.note } : {}),
                  ...(file ? { file } : {}),
                  ...(group ? { group } : {}),
                },
              }
        const ok = deps.queue.fulfill(id, outcome)
        return sendJson(
          ctx,
          ok ? 200 : 404,
          ok ? { ok: true } : { error: 'not_found', message: 'request expired or already answered' },
        )
      },
    },
  ]
}
