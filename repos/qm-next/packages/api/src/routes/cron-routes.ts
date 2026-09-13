/**
 * Cron routes (parity contract "crons", 7 routes + the id match route) over
 * the @qm/triggers CronStore. Lane A scope: the source-mode surface is
 * complete (create with resolved destination, list/get/patch/delete,
 * disable, manual run, fire log); capability-mode-only fields (runAs,
 * destinationKey, unattendedGrants, personal scope, consent) arrive with
 * the IM-domain backfill (14.0) and are refused with qm's error codes.
 * Error mapping per contract: 400 create/update/destination failures,
 * 403 forbidden/identity_unverified/not_a_member, otherwise 404.
 */
import type { CronRecord, CronSchedule, CronStore } from '@qm/triggers'
import type { CronScheduler } from '@qm/triggers'
import type { Destination, ScopeId } from '@qm/types'
import type { ReachDirectory } from '@qm/reach'
import { resolveReachTarget } from '@qm/reach'
import type { ApiRouteContext, Route } from './framework.ts'
import { badRequest, isObj, notFound, sendJson } from './framework.ts'

const UNSUPPORTED = 'capability-mode cron field; lands with the IM-domain backfill (14.0)'

export interface CronRoutesDeps {
  /** Cron registry; routes 404 when the triggers runtime is not loaded. */
  crons?: () => CronStore | undefined
  /** Manual-fire hook (`runNow`); run route 404s without the scheduler. */
  scheduler?: () => CronScheduler | undefined
  /** Destination resolution for recipient/channel/participants creates. */
  reach?: ReachDirectory
  provider?: string
  /** Default fire scope for capability-mode creates (org scope). */
  scopeFor?: () => ScopeId
}

interface CronView extends Omit<CronRecord, 'schedule'> {
  schedule: CronSchedule
}

function view(cron: CronRecord): CronView {
  // qm strips the fire log; the qm-next record never embeds one.
  return { ...cron }
}

function scheduleOf(raw: unknown): CronSchedule | null {
  if (!isObj(raw)) return null
  const schedule: CronSchedule = {}
  if (typeof raw.cron === 'string' && raw.cron) schedule.cron = raw.cron
  if (typeof raw.timezone === 'string' && raw.timezone) schedule.timezone = raw.timezone
  if (typeof raw.everyMs === 'number' && Number.isFinite(raw.everyMs)) schedule.everyMs = raw.everyMs
  if (typeof raw.firstFireAt === 'number' && Number.isFinite(raw.firstFireAt)) schedule.firstFireAt = raw.firstFireAt
  if (schedule.cron === undefined && schedule.everyMs === undefined && schedule.firstFireAt === undefined) return null
  return schedule
}

/** Resolve recipient/channel/participants onto a Destination (400/403/404 per contract). */
async function destinationOf(
  deps: CronRoutesDeps,
  ctx: ApiRouteContext,
  body: Record<string, unknown>,
): Promise<Destination | null | undefined> {
  if (!deps.reach) return null
  const recipient = typeof body.recipient === 'string' ? body.recipient : undefined
  const channel = typeof body.channel === 'string' ? body.channel : undefined
  const participants = Array.isArray(body.participants)
    ? body.participants.filter((p): p is string => typeof p === 'string')
    : undefined
  if (recipient === undefined && channel === undefined && participants === undefined) return null
  const actorId = ctx.actor?.id ?? (typeof body.principalId === 'string' ? body.principalId : '')
  const resolution = await resolveReachTarget(
    deps.reach,
    deps.provider ?? 'slack',
    { ...(recipient !== undefined ? { recipient } : {}), ...(channel !== undefined ? { channel } : {}), ...(participants !== undefined ? { participants } : {}) },
    actorId.includes(':') ? actorId.slice(actorId.indexOf(':') + 1) : actorId,
  )
  if (!resolution.ok) {
    sendJson(ctx, resolution.status, {
      error: resolution.error,
      message: resolution.message,
      ...(resolution.candidates ? { candidates: resolution.candidates } : {}),
    })
    return undefined
  }
  return resolution.destination
}

function refused(ctx: ApiRouteContext, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  sendJson(ctx, 400, { error: 'bad_request', message })
}

async function createCron(ctx: ApiRouteContext, deps: CronRoutesDeps): Promise<void> {
  const crons = deps.crons?.()
  if (!crons) return notFound(ctx)
  const body = isObj(ctx.body) ? ctx.body : {}
  if (body.runAs !== undefined || body.destinationKey !== undefined || body.unattendedGrants !== undefined) {
    return badRequest(ctx, UNSUPPORTED)
  }
  if (body.scope !== undefined && body.scope !== 'org') return badRequest(ctx, UNSUPPORTED)
  const schedule = scheduleOf(body.schedule)
  if (!schedule) return badRequest(ctx, 'schedule { cron+timezone? | everyMs? | firstFireAt? } is required', 'cron_create_failed')
  const action = typeof body.task === 'string' ? body.task : typeof body.action === 'string' ? body.action : undefined
  const message = typeof body.text === 'string' ? body.text : typeof body.message === 'string' ? body.message : undefined
  if (!action && !message) {
    return badRequest(ctx, 'task (turn text) or message (direct relay) is required', 'cron_create_failed')
  }
  const destination = await destinationOf(deps, ctx, body)
  if (destination === undefined) return
  const title = typeof body.title === 'string' ? body.title : undefined
  const ownerId = ctx.actor?.id ?? (typeof body.principalId === 'string' ? body.principalId : undefined)
  if (!ownerId) {
    return sendJson(ctx, 403, { error: 'identity_unverified', message: 'cron ownership requires an authenticated principal' })
  }
  const scopeId = (ctx.actor ? deps.scopeFor?.() : undefined) ?? (typeof body.scopeId === 'string' ? body.scopeId : 'org:default')
  let record: CronRecord
  try {
    record = await crons.create({
      scopeId,
      ownerId,
      createdBy: ownerId,
      schedule,
      ...(action ? { action } : {}),
      ...(message ? { message } : {}),
      ...(destination ? { destination } : {}),
      ...(title ? { title } : {}),
    })
  } catch (err) {
    return refused(ctx, err)
  }
  return sendJson(ctx, 200, {
    cron: view(record),
    ...(resolutionEcho(destination, body)),
  })
}

function resolutionEcho(destination: Destination | null, body: Record<string, unknown>): Record<string, unknown> {
  if (!destination) return {}
  if (typeof body.recipient === 'string') return { recipient: body.recipient }
  if (typeof body.channel === 'string') return { channel: body.channel }
  if (Array.isArray(body.participants)) return { group: body.participants }
  return {}
}

async function listCrons(ctx: ApiRouteContext, deps: CronRoutesDeps): Promise<void> {
  const crons = deps.crons?.()
  if (!crons) return notFound(ctx)
  const all = await crons.list()
  return sendJson(ctx, 200, { crons: all.map(view), visible: all.map((c) => c.id) })
}

async function disableCron(ctx: ApiRouteContext, deps: CronRoutesDeps): Promise<void> {
  const crons = deps.crons?.()
  if (!crons) return notFound(ctx)
  const id = ctx.params.id
  if (!id) return notFound(ctx)
  const record = await crons.get(id)
  if (!record) return notFound(ctx)
  await crons.setEnabled(id, false)
  return sendJson(ctx, 200, { ok: true })
}

async function runCron(ctx: ApiRouteContext, deps: CronRoutesDeps): Promise<void> {
  const crons = deps.crons?.()
  const scheduler = deps.scheduler?.()
  if (!crons || !scheduler) return notFound(ctx)
  const id = ctx.params.id
  if (!id) return notFound(ctx)
  const record = await crons.get(id)
  if (!record) return notFound(ctx)
  if (record.archived || !record.enabled) {
    return badRequest(ctx, 'cron is archived or paused', 'cron_archived')
  }
  await scheduler.runNow(record.id)
  return sendJson(ctx, 200, { ok: true })
}

async function cronRuns(ctx: ApiRouteContext, deps: CronRoutesDeps): Promise<void> {
  const crons = deps.crons?.()
  if (!crons) return notFound(ctx)
  const id = ctx.params.id
  if (!id) return notFound(ctx)
  const record = await crons.get(id)
  if (!record) return notFound(ctx)
  const raw = Number(ctx.query.limit)
  const limit = Number.isInteger(raw) && raw > 0 ? raw : undefined
  const page = await crons.getFires(record.id, limit)
  return sendJson(ctx, 200, { cron: view(record), runs: page.runs, total: page.total })
}

async function cronById(ctx: ApiRouteContext, deps: CronRoutesDeps): Promise<void> {
  const crons = deps.crons?.()
  if (!crons) return notFound(ctx)
  const id = ctx.params.id
  if (!id) return notFound(ctx)
  const record = await crons.get(id)
  switch (ctx.req.method) {
    case 'GET':
      if (!record) return notFound(ctx)
      return sendJson(ctx, 200, { cron: view(record) })
    case 'DELETE':
      if (!record) return notFound(ctx)
      await crons.delete(record.id)
      return sendJson(ctx, 200, { ok: true })
    case 'PATCH': {
      if (!record) return sendJson(ctx, 200, { cron: null })
      const body = isObj(ctx.body) ? ctx.body : {}
      if (body.runAs !== undefined || body.destinationKey !== undefined || body.unattendedGrants !== undefined) {
        return badRequest(ctx, UNSUPPORTED)
      }
      const patch: Parameters<CronStore['update']>[1] = {}
      if (typeof body.title === 'string') patch.title = body.title
      if (typeof body.task === 'string') patch.action = body.task
      if (typeof body.action === 'string') patch.action = body.action
      if (typeof body.message === 'string') patch.message = body.message
      if (body.schedule !== undefined) {
        const schedule = scheduleOf(body.schedule)
        if (!schedule) return badRequest(ctx, 'invalid schedule', 'cron_update_failed')
        patch.schedule = schedule
      }
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
      if (typeof body.archived === 'boolean') patch.archived = body.archived
      if (!Object.keys(patch).length) {
        return badRequest(ctx, 'nothing to change', 'CRON_PATCH_NOTHING_TO_CHANGE')
      }
      try {
        const next = await crons.update(record.id, patch)
        if (!next) return notFound(ctx)
        return sendJson(ctx, 200, { cron: view(next) })
      } catch (err) {
        return refused(ctx, err)
      }
    }
    default:
      return notFound(ctx)
  }
}

export function cronRoutes(deps: CronRoutesDeps): ReadonlyArray<Route> {
  return [
    { method: 'POST', path: '/v1/crons', auth: 'either', handle: (ctx) => createCron(ctx, deps) },
    { method: 'GET', path: '/v1/crons', auth: 'source', handle: (ctx) => listCrons(ctx, deps) },
    { method: 'POST', path: '/v1/crons/:id/disable', auth: 'source', handle: (ctx) => disableCron(ctx, deps) },
    { method: 'POST', path: '/v1/crons/:id/run', auth: 'source', handle: (ctx) => runCron(ctx, deps) },
    { method: 'GET', path: '/v1/crons/:id/runs', auth: 'source', handle: (ctx) => cronRuns(ctx, deps) },
    { method: 'GET', path: '/v1/crons/:id', auth: 'source', handle: (ctx) => cronById(ctx, deps) },
    { method: 'PATCH', path: '/v1/crons/:id', auth: 'source', handle: (ctx) => cronById(ctx, deps) },
    { method: 'DELETE', path: '/v1/crons/:id', auth: 'source', handle: (ctx) => cronById(ctx, deps) },
    // Consent route: the consent store arrives with the IM-domain backfill
    // (14.0); without one there is never a pending consent (qm: 400).
    {
      method: 'POST',
      path: '/v1/triggers/:id/consent',
      auth: 'either',
      handle: async (ctx) => {
        if (!ctx.actor) {
          return sendJson(ctx, 403, { error: 'forbidden', message: 'consent decisions require an agent capability token' })
        }
        return badRequest(ctx, 'no consent pending for this trigger')
      },
    },
  ]
}
