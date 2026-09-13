/**
 * Reach route (parity contract "reach", 1 route): resolve a user-stated
 * target through @qm/reach and send. Lane A: the send gate returns the
 * documented 501 until surface delivery is wired (web-ui backend,
 * 13.0) — resolution, validation, membership/visibility checks and rate
 * limiting are complete. Files need blob staging (control plane, 12.0)
 * and resolve to 501 exactly as qm reports unwired deps.
 */
import { reachDirectory, resolveReachTarget } from '@qm/reach'
import type { DirectoryStore } from '@qm/directory'
import type { ApiRouteContext, Route } from './framework.ts'
import { badRequest, isObj, sendJson } from './framework.ts'

const PROVIDER = 'slack'
const MAX_OUTBOUND_FILES = 8

/** Fixed-window send limiter keyed `reach:<actorId>` (qm parity: 429 rate_limited). */
export interface ReachRateLimiter {
  check(key: string): boolean
}

export function memoryRateLimiter(opts: { limit: number; windowMs: number }): ReachRateLimiter {
  const hits = new Map<string, { count: number; windowStart: number }>()
  return {
    check(key: string): boolean {
      const now = Date.now()
      const entry = hits.get(key)
      if (!entry || now - entry.windowStart >= opts.windowMs) {
        hits.set(key, { count: 1, windowStart: now })
        return true
      }
      entry.count += 1
      return entry.count <= opts.limit
    },
  }
}

export interface ReachRoutesDeps {
  directory?: DirectoryStore
  limiter?: ReachRateLimiter
}

/** The actor's provider-native id: directory principals are `slack:<uid>`. */
function providerUserIdOf(actorId: string): string {
  const idx = actorId.indexOf(':')
  return idx >= 0 ? actorId.slice(idx + 1) : actorId
}

export function reachRoutes(deps: ReachRoutesDeps): ReadonlyArray<Route> {
  const limiter = deps.limiter ?? memoryRateLimiter({ limit: 10, windowMs: 60_000 })
  return [
    {
      method: 'POST',
      path: '/v1/reach',
      auth: 'either',
      handle: async (ctx) => reach(ctx, deps, limiter),
    },
  ]
}

async function reach(ctx: ApiRouteContext, deps: ReachRoutesDeps, limiter: ReachRateLimiter): Promise<void> {
  if (!ctx.actor) {
    return sendJson(ctx, 403, { error: 'forbidden', message: 'reach requires an agent capability token' })
  }
  if (!deps.directory) {
    return sendJson(ctx, 501, { error: 'not_configured', message: 'no directory wired' })
  }
  const body = isObj(ctx.body) ? ctx.body : {}
  const text = typeof body.text === 'string' ? body.text : typeof body.message === 'string' ? body.message : undefined
  const recipient = typeof body.recipient === 'string' ? body.recipient : undefined
  const channel = typeof body.channel === 'string' ? body.channel : undefined
  const participants = Array.isArray(body.participants) ? body.participants.filter((p): p is string => typeof p === 'string') : undefined
  const threadTs = typeof body.threadTs === 'string' ? body.threadTs : undefined
  const files = Array.isArray(body.files) ? body.files.filter((f): f is string => typeof f === 'string') : undefined
  const react = isObj(body.react) ? body.react : undefined
  const remove = isObj(body.delete) ? body.delete : undefined

  if (!text && !react && !remove) {
    return badRequest(ctx, 'text, react or delete is required')
  }
  if (files) {
    if (files.length > MAX_OUTBOUND_FILES) {
      return sendJson(ctx, 400, { error: 'attach_failed', message: `at most ${MAX_OUTBOUND_FILES} files`, oversized: files.slice(MAX_OUTBOUND_FILES) })
    }
    if (files.some((f) => !f || f.includes('..'))) {
      return sendJson(ctx, 400, { error: 'attach_failed', message: 'files must be workspace-relative paths', missing: files.filter((f) => !f) })
    }
    if (!text) return badRequest(ctx, 'files require a text post')
  }
  if (react || remove) {
    if (react && remove) return badRequest(ctx, 'react and delete are mutually exclusive')
    if (files) return badRequest(ctx, 'react/delete cannot carry files')
    if (threadTs === undefined && !(react?.ts && typeof react.ts === 'string') && !(remove?.ts && typeof remove.ts === 'string')) {
      return badRequest(ctx, 'react/delete need the message ts')
    }
    if (recipient) return badRequest(ctx, 'react/delete cannot carry recipient')
  }

  if (!limiter.check(`reach:${ctx.actor.id}`)) {
    return sendJson(ctx, 429, { error: 'rate_limited', message: 'too many reach calls; slow down' })
  }

  const resolution = await resolveReachTarget(
    reachDirectory(deps.directory),
    PROVIDER,
    { ...(recipient !== undefined ? { recipient } : {}), ...(channel !== undefined ? { channel } : {}), ...(participants !== undefined ? { participants } : {}) },
    providerUserIdOf(ctx.actor.id),
  )
  if (!resolution.ok) {
    return sendJson(ctx, resolution.status, {
      error: resolution.error,
      message: resolution.message,
      ...(resolution.candidates ? { candidates: resolution.candidates } : {}),
    })
  }

  // Send gate: surface delivery lands with the web-ui backend (13.0);
  // blob staging for files lands with the control plane (12.0).
  return sendJson(ctx, 501, {
    error: 'not_configured',
    message: 'no surface delivery wired for this deployment',
    resolved: {
      destination: resolution.destination,
      ...(resolution.recipient ? { recipient: resolution.recipient } : {}),
      ...(resolution.channel ? { channel: resolution.channel } : {}),
      ...(resolution.group ? { group: resolution.group } : {}),
    },
  })
}
