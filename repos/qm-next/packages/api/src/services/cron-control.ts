/**
 * Cron control plane for the ToolContext surface (T-cluster wiring): qm's
 * `control-service.createCron/listCrons/…` ladder over the @qm/triggers
 * CronStore + scheduler, shared with cron-routes' stores but shaped for
 * tool calls — result objects instead of HTTP. Capability-only features
 * (runAs, destinationKey, unattendedGrants, personal scope) are refused
 * with qm's error codes, matching the route lane. Recipient consent and
 * schedule validation mirror qm `crons.ts` semantics.
 */
import type { CronPatch, CronRecord, CronSchedule, CronScheduler, CronStore } from '@qm/triggers'
import { consentRequiredRecipient, notifyOwnerOfCronEdit, sendConsentNotice } from '@qm/triggers'
import { resolveReachTarget, type ReachDirectory } from '@qm/reach'
import type { DirectoryStore } from '@qm/directory'
import { resolveProviderDm } from '@qm/directory'
import type { ImDeliveryQueue } from '@qm/im-core'
import type {
  ControlErr,
  ControlOk,
  Cron,
  CronCreateRequest,
  CronCreateResult,
  CronPatchRequest,
  CronRunsRequest,
  CronRunsResult,
  Destination,
  VisibleCron,
} from '@qm/types'

/** The @qm/types cron view: trigger base fields plus schedule; fires run one scope per record. */
type CronView = CronRecord & Omit<Cron, keyof CronRecord>

function view(record: CronRecord): CronView {
  const { scopeId, ownerId, ...rest } = record
  return { ...rest, ownerScopeId: scopeId, owner: ownerId } as CronView
}

export interface CronControlDeps {
  crons: CronStore
  /** Manual-fire hook; cronRun answers `unavailable` without the scheduler. */
  scheduler?: CronScheduler
  /** Destination resolution for recipient/channel/participants creates. */
  reach?: ReachDirectory
  provider?: string
  /** Fire scope for creates (org scope of the deployment). */
  scopeFor?: () => string
  /** Roster for owner display names and recipient DM resolution. */
  directory?: DirectoryStore
  /** Notice delivery sink (consent notices, edit notices). */
  deliveries?: () => Pick<ImDeliveryQueue, 'enqueue'> | undefined
}

const UNSUPPORTED = 'capability-mode cron field; lands with the IM-domain backfill (14.0)'

export function scheduleOf(raw: unknown): CronSchedule | null {
  if (typeof raw !== 'object' || raw === null) return null
  const s = raw as Record<string, unknown>
  const schedule: CronSchedule = {}
  if (typeof s.cron === 'string' && s.cron) schedule.cron = s.cron
  if (typeof s.timezone === 'string' && s.timezone) schedule.timezone = s.timezone
  if (typeof s.everyMs === 'number' && Number.isFinite(s.everyMs)) schedule.everyMs = s.everyMs
  if (typeof s.firstFireAt === 'number' && Number.isFinite(s.firstFireAt)) schedule.firstFireAt = s.firstFireAt
  if (schedule.cron === undefined && schedule.everyMs === undefined && schedule.firstFireAt === undefined) return null
  return schedule
}

/** qm standing rule: calendar or interval schedules wait for consent. */
export function isStandingSchedule(schedule: CronSchedule): boolean {
  return schedule.cron !== undefined || schedule.everyMs !== undefined
}

function principalUid(principalId: string): { provider: string; uid: string } | null {
  const sep = principalId.indexOf(':')
  if (sep <= 0) return null
  return { provider: principalId.slice(0, sep), uid: principalId.slice(sep + 1) }
}

async function directoryMemberOf(deps: CronControlDeps, principalId: string): Promise<{ displayName?: string } | null> {
  const parts = principalUid(principalId)
  if (!deps.directory || !parts) return null
  const person = await deps.directory.getPerson(parts.provider, parts.uid).catch(() => null)
  return person ? { ...(person.displayName ? { displayName: person.displayName } : {}) } : null
}

async function ownerDmDestination(deps: CronControlDeps, principalId: string): Promise<Destination | null> {
  const parts = principalUid(principalId)
  if (!deps.directory || !parts) return null
  const dm = await resolveProviderDm(deps.directory, parts.provider, parts.uid).catch(() => null)
  return dm?.destination ?? null
}

async function deliverConsentNotice(
  deps: CronControlDeps,
  args: { triggerId: string; recipientId: string; ownerId: string; title?: string },
): Promise<void> {
  const deliveries = deps.deliveries?.()
  const parts = principalUid(args.recipientId)
  if (!deliveries || !deps.directory || !parts) return
  const dm = await resolveProviderDm(deps.directory, parts.provider, parts.uid).catch(() => null)
  if (!dm) return
  const ownerName = (await directoryMemberOf(deps, args.ownerId))?.displayName
  await sendConsentNotice(
    (input) =>
      deliveries.enqueue({
        provider: dm.destination.type,
        op: { op: 'send', destination: input.destination, body: { text: input.text } },
        idempotencyKey: input.idempotencyKey,
      }),
    {
      triggerId: args.triggerId,
      recipientId: args.recipientId,
      ownerId: args.ownerId,
      ...(ownerName ? { ownerName } : {}),
      what: args.title ? `a scheduled message ("${args.title}")` : 'a recurring scheduled message',
      destination: dm.destination,
    },
  )
}

async function createCron(deps: CronControlDeps, req: CronCreateRequest, actorId: string): Promise<CronCreateResult> {
  const schedule = scheduleOf(req.schedule)
  if (!schedule) {
    return { ok: false, code: 'bad_request', message: 'schedule { cron+timezone? | everyMs? | firstFireAt? } is required' }
  }
  if (req.action === undefined && req.text === undefined) {
    return { ok: false, code: 'bad_request', message: 'task (what to do) or text (exact text to send) required' }
  }
  const wantsPersonal = req.scope === 'personal'
  if (wantsPersonal || req.runAs !== undefined || req.destinationKey !== undefined || req.unattendedGrants !== undefined) {
    return { ok: false, code: 'bad_request', message: UNSUPPORTED }
  }
  const hasParticipants = Array.isArray(req.participants) && req.participants.length > 0
  if ([req.recipient !== undefined, req.channel !== undefined, hasParticipants].filter(Boolean).length > 1) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'specify at most one of recipient (a teammate), channel, or participants (a group DM)',
    }
  }

  let destination: Destination | undefined
  let resolvedRecipient: { principalId: string; displayName: string } | undefined
  let resolvedChannel: { channelId: string; name: string } | undefined
  let resolvedGroup: { groupId: string } | undefined
  if (req.recipient !== undefined || req.channel !== undefined || hasParticipants) {
    if (!deps.reach) return { ok: false, code: 'unknown_destination', message: 'no destination resolver is wired on this deployment' }
    const actorUid = actorId.includes(':') ? actorId.slice(actorId.indexOf(':') + 1) : actorId
    const r = await resolveReachTarget(
      deps.reach,
      deps.provider ?? 'slack',
      {
        ...(req.recipient !== undefined ? { recipient: req.recipient } : {}),
        ...(req.channel !== undefined ? { channel: req.channel } : {}),
        ...(hasParticipants ? { participants: req.participants } : {}),
      },
      actorUid,
    )
    if (!r.ok) {
      type FailureCode = Extract<CronCreateResult, { ok: false }>['code']
      let code: FailureCode = 'bad_request'
      const RESOLVER_CODES: ReadonlySet<string> = new Set(['recipient_not_found', 'ambiguous_recipient', 'group_not_found'])
      if (RESOLVER_CODES.has(r.error)) {
        code = r.error as FailureCode
      } else if (r.status === 404) {
        code = req.recipient !== undefined ? 'recipient_not_found' : hasParticipants ? 'group_not_found' : 'channel_not_found'
      } else if (r.status === 409) {
        code = req.recipient !== undefined ? 'ambiguous_recipient' : 'ambiguous_channel'
      } else if (r.status === 403) {
        code = r.error === 'identity_unverified' ? 'identity_unverified' : 'not_a_member'
      }
      return {
        ok: false,
        code,
        message: r.error === 'not_a_member' && req.channel !== undefined
          ? "I can only schedule posts to a private channel you're in"
          : r.message,
        ...(r.candidates
          ? { candidates: r.candidates.map((c) => ({ id: c.principalId ?? c.channelId ?? '', label: c.displayName ?? c.name ?? '' })) }
          : {}),
      }
    }
    destination = r.destination
    if (r.recipient) resolvedRecipient = { principalId: r.recipient.principalId, displayName: r.recipient.displayName }
    if (r.channel) resolvedChannel = { channelId: r.channel.spaceId, name: r.channel.name }
    if (r.group) resolvedGroup = { groupId: r.group.spaceId }
  }

  const standing = isStandingSchedule(schedule)
  const consentRecipient = consentRequiredRecipient({
    owner: actorId,
    standing,
    ...(destination ? { destination } : {}),
  })
  let record: CronRecord
  try {
    record = await deps.crons.create({
      scopeId: deps.scopeFor?.() ?? 'org:default',
      ownerId: actorId,
      createdBy: actorId,
      schedule,
      ...(req.action !== undefined ? { action: req.action } : {}),
      ...(req.text !== undefined ? { message: req.text } : {}),
      ...(destination ? { destination } : {}),
      ...(typeof req.title === 'string' ? { title: req.title } : {}),
      ...(consentRecipient ? { recipientConsent: { recipientId: consentRecipient, status: 'pending' as const } } : {}),
    })
  } catch (err) {
    return { ok: false, code: 'cron_create_failed', message: err instanceof Error ? err.message : String(err) }
  }
  if (consentRecipient) {
    await deliverConsentNotice(deps, { triggerId: record.id, recipientId: consentRecipient, ownerId: actorId, ...(typeof req.title === 'string' ? { title: req.title } : {}) })
  }
  return {
    ok: true,
    cron: view(record),
    ...(resolvedRecipient ? { recipient: resolvedRecipient } : {}),
    ...(resolvedChannel ? { channel: resolvedChannel } : {}),
    ...(resolvedGroup ? { group: resolvedGroup } : {}),
  }
}

/** Owner notice on a third-party edit (qm edit-notice flow, provider-native DM). */
async function notifyOwnerOfEdit(
  deps: CronControlDeps,
  before: CronRecord,
  after: CronRecord,
  patch: CronPatch,
  editorId: string | undefined,
): Promise<void> {
  const deliveries = deps.deliveries?.()
  if (!editorId || editorId === before.ownerId || !deliveries) return
  const changes: string[] = []
  if (patch.title !== undefined) changes.push('title')
  if (patch.action !== undefined || patch.message !== undefined) changes.push('task')
  if (patch.schedule !== undefined) changes.push('schedule')
  if (patch.enabled !== undefined) changes.push(`enabled=${String(patch.enabled)}`)
  if (patch.archived !== undefined) changes.push(`archived=${String(patch.archived)}`)
  if (changes.length === 0) return
  await notifyOwnerOfCronEdit(
    {
      enqueueDelivery: (input) =>
        deliveries.enqueue({
          provider: input.destination.type,
          op: { op: 'send', destination: input.destination, body: { text: input.text } },
          idempotencyKey: input.idempotencyKey,
        }),
      directoryMember: (principalId) => directoryMemberOf(deps, principalId),
      ownerDestination: (ownerPrincipalId) => ownerDmDestination(deps, ownerPrincipalId),
    },
    {
      cron: { id: after.id, owner: after.ownerId, ...(after.title ? { title: after.title } : {}) },
      editorId,
      changeSummary: changes,
      editFingerprint: JSON.stringify(patch),
      ...(patch.schedule !== undefined ? { detail: { schedule: after.schedule } } : {}),
    },
  )
}

/**
 * The ToolContext cron surface (qm control-service ladder, lane-A scope).
 * Ownership checks compare the cron owner against `actorId`; unknown ids
 * answer not_found, foreign crons answer forbidden (qm `canAdministerCron`
 * collapses to owner equality on this lane).
 */
/** The @qm/types fire-log view: the store entry keyed by session thread. */
function fireView(entry: import('@qm/triggers').CronFireLogEntry): import('@qm/types').CronFireLogEntry {
  return { ...entry, threadRef: entry.sessionId ?? '' }
}

export function createCronControl(deps: CronControlDeps): {
  cronCreate(req: CronCreateRequest, actorId: string): Promise<CronCreateResult>
  cronList(actorId: string): Promise<{ crons: Cron[]; visible: VisibleCron[] }>
  cronGet(id: string, actorId: string): Promise<ControlOk<{ cron: Cron }> | ControlErr<'not_found' | 'forbidden'>>
  cronRuns(
    id: string,
    req: CronRunsRequest | undefined,
    actorId: string,
  ): Promise<ControlOk<CronRunsResult> | ControlErr<'not_found' | 'forbidden' | 'bad_request'>>
  cronPatch(
    id: string,
    req: CronPatchRequest,
    editorId: string | undefined,
  ): Promise<ControlOk<{ cron: Cron }> | ControlErr<'not_found' | 'forbidden' | 'bad_request' | 'cron_update_failed'>>
  cronDelete(id: string, actorId: string): Promise<ControlOk<Record<never, never>> | ControlErr<'not_found' | 'forbidden'>>
  cronSetEnabled(id: string, enabled: boolean, actorId: string): Promise<ControlOk<{ cron: Cron }> | ControlErr<'not_found' | 'forbidden'>>
  cronRun(id: string): Promise<ControlOk<Record<never, never>> | ControlErr<'not_found' | 'forbidden' | 'unavailable' | 'bad_request'>>
  cronRetarget(
    id: string,
    _destinationKey: string,
    actorId: string,
  ): Promise<ControlOk<{ cron: Cron }> | ControlErr<'not_found' | 'forbidden' | 'unknown_destination'>>
} {
  async function owned(id: string, actorId: string): Promise<CronRecord | null | 'forbidden'> {
    const record = await deps.crons.get(id)
    if (!record) return null
    if (record.ownerId !== actorId) return 'forbidden'
    return record
  }
  return {
    cronCreate: (req, actorId) => createCron(deps, req, actorId),
    async cronList(actorId) {
      const all = await deps.crons.list()
      const administered = all.filter((c) => c.ownerId === actorId || c.createdBy === actorId)
      const administeredIds = new Set(administered.map((c) => c.id))
      return {
        crons: administered.map(view),
        visible: all.filter((c) => !administeredIds.has(c.id)).map((c) => view(c)),
      }
    },
    async cronGet(id, actorId) {
      const record = await owned(id, actorId)
      if (record === null) return { ok: false, code: 'not_found', message: `no cron ${id}` }
      if (record === 'forbidden') return { ok: false, code: 'forbidden', message: 'not your cron' }
      return { ok: true, cron: view(record) }
    },
    async cronRuns(id, req, actorId) {
      const record = await owned(id, actorId)
      if (record === null) return { ok: false, code: 'not_found', message: `no cron ${id}` }
      if (record === 'forbidden') return { ok: false, code: 'forbidden', message: 'not your cron' }
      const limit = req?.limit
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        return { ok: false, code: 'bad_request', message: 'limit must be a positive integer' }
      }
      const page = await deps.crons.getFires(record.id, limit)
      return { ok: true, cron: view(record), runs: page.runs.map(fireView), total: page.total }
    },
    async cronPatch(id, req, editorId) {
      if (req.runAs !== undefined || req.unattendedGrants !== undefined) {
        return { ok: false, code: 'bad_request', message: UNSUPPORTED }
      }
      const record = await deps.crons.get(id)
      if (!record) return { ok: false, code: 'not_found', message: `no cron ${id}` }
      if (record.ownerId !== editorId) return { ok: false, code: 'forbidden', message: 'not your cron' }
      const patch: CronPatch = {}
      if (typeof req.title === 'string') patch.title = req.title
      if (typeof req.action === 'string') patch.action = req.action
      if (typeof req.text === 'string') patch.message = req.text
      if (req.schedule !== undefined) {
        const schedule = scheduleOf(req.schedule)
        if (!schedule) return { ok: false, code: 'bad_request', message: 'invalid schedule' }
        patch.schedule = schedule
      }
      if (typeof req.enabled === 'boolean') patch.enabled = req.enabled
      if (typeof req.archived === 'boolean') patch.archived = req.archived
      if (req.unfurlLinks !== undefined) return { ok: false, code: 'bad_request', message: UNSUPPORTED }
      if (!Object.keys(patch).length) {
        return { ok: false, code: 'bad_request', message: 'nothing to change' }
      }
      let next: CronRecord | null
      try {
        next = await deps.crons.update(record.id, patch)
        if (!next) return { ok: false, code: 'not_found', message: `no cron ${id}` }
      } catch (err) {
        return { ok: false, code: 'cron_update_failed', message: err instanceof Error ? err.message : String(err) }
      }
      await notifyOwnerOfEdit(deps, record, next, patch, editorId)
      return { ok: true, cron: view(next) }
    },
    async cronDelete(id, actorId) {
      const record = await owned(id, actorId)
      if (record === null) return { ok: false, code: 'not_found', message: `no cron ${id}` }
      if (record === 'forbidden') return { ok: false, code: 'forbidden', message: 'not your cron' }
      await deps.crons.delete(record.id)
      return { ok: true }
    },
    async cronSetEnabled(id, enabled, actorId) {
      const record = await owned(id, actorId)
      if (record === null) return { ok: false, code: 'not_found', message: `no cron ${id}` }
      if (record === 'forbidden') return { ok: false, code: 'forbidden', message: 'not your cron' }
      await deps.crons.setEnabled(record.id, enabled)
      const next = await deps.crons.get(record.id)
      return { ok: true, cron: view(next ?? record) }
    },
    async cronRun(id) {
      const record = await deps.crons.get(id)
      if (!record) return { ok: false, code: 'not_found', message: `no cron ${id}` }
      if (!deps.scheduler) return { ok: false, code: 'unavailable', message: 'the cron scheduler is not running on this deployment' }
      if (record.archived || !record.enabled) return { ok: false, code: 'bad_request', message: 'cron is archived or paused' }
      await deps.scheduler.runNow(record.id)
      return { ok: true }
    },
    async cronRetarget(id, destinationKey, actorId) {
      const record = await owned(id, actorId)
      if (record === null) return { ok: false, code: 'not_found', message: `no cron ${id}` }
      if (record === 'forbidden') return { ok: false, code: 'forbidden', message: 'not your cron' }
      void destinationKey
      return { ok: false, code: 'unknown_destination', message: 'destination retargeting needs the destination registry (capability lane)' }
    },
  }
}
