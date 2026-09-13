import type { Run, Session, SessionEntry, TurnResult } from '@qm/types'
import type { CronRecord } from '@qm/triggers'
import type { SkillRecord } from '@qm/skills'
import type { DirectorySpaceRecord } from '@qm/directory'

export type RunPollWire = {
  status: Run['status']
  result: {
    status: string
    reply?: string
    reason?: string
    stopped?: boolean
    pendingApprovals?: TurnResult['pendingApprovals']
  } | null
  partial?: string
  alive?: boolean
  stale?: boolean
  replyComplete?: boolean
  activity?: unknown[]
  startedAt?: number | null
  finishedAt?: number | null
}

export function resultWire(result: TurnResult): NonNullable<RunPollWire['result']> {
  return {
    status: result.status,
    ...(result.reply !== undefined ? { reply: result.reply } : {}),
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(result.stopped ? { stopped: true } : {}),
    ...(result.pendingApprovals?.length ? { pendingApprovals: result.pendingApprovals } : {}),
  }
}

export function runWire(run: Run): RunPollWire {
  return {
    status: run.status,
    result: run.result ? resultWire(run.result) : null,
    alive: run.status === 'running',
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
  }
}

export interface SessionWire {
  id: string
  type: Session['type']
  scopeId: string
  threadRef: string
  createdAt: number
  title: string | null
  channelName: string | null
  lastActivityAt?: number
  working?: boolean
  awaitingInput?: boolean
}

export function sessionWire(session: Session, working: boolean, lastActivityAt?: number): SessionWire {
  return {
    id: session.id,
    type: session.type,
    scopeId: session.scopeId,
    threadRef: session.threadRef,
    createdAt: session.createdAt,
    title: session.title ?? null,
    channelName: session.channelName ?? null,
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    ...(working ? { working: true, awaitingInput: false } : {}),
  }
}

export interface EntryWire {
  type: SessionEntry['type']
  payload: unknown
  createdAt: number
  seq: number
  parentSeq: number | null
}

export function entryWire(entry: SessionEntry): EntryWire {
  return {
    type: entry.type,
    payload: entry.payload,
    createdAt: entry.createdAt,
    seq: entry.seq,
    parentSeq: entry.parentSeq,
  }
}

export interface SkillItemWire {
  id: string
  name: string
  description: string
  body?: string
  scope: string
  scopeId: string
  status: string
  version: number
  shadowed?: boolean
  editable?: boolean
  requiredCapabilities?: string[]
  createdBy?: string
}

export function skillWire(
  skill: SkillRecord,
  opts: { withBody?: boolean; shadowed?: boolean; editable?: boolean } = {},
): SkillItemWire {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    ...(opts.withBody ? { body: skill.body } : {}),
    scope: skill.scopeId,
    scopeId: skill.scopeId,
    status: skill.status,
    version: skill.version,
    ...(opts.shadowed ? { shadowed: true } : {}),
    ...(opts.editable ? { editable: true } : {}),
    ...(skill.requiredCapabilities.length ? { requiredCapabilities: skill.requiredCapabilities } : {}),
    ...(skill.createdBy ? { createdBy: skill.createdBy } : {}),
  }
}

export interface CronViewWire {
  id: string
  ownerScopeId: string
  owner: string
  title?: string
  action?: string
  message?: string
  schedule: CronRecord['schedule']
  destination: CronRecord['destination'] | null
  enabled: boolean
  archived?: boolean
  createdAt: number
  lastFiredAt?: number
  nextFireAt?: number
  scopeName?: string
  permission?: 'read' | 'manage'
}

export function cronWire(cron: CronRecord, permission: 'read' | 'manage'): CronViewWire {
  return {
    id: cron.id,
    ownerScopeId: cron.scopeId,
    owner: cron.ownerId,
    ...(cron.title ? { title: cron.title } : {}),
    ...(cron.action ? { action: cron.action } : {}),
    ...(cron.message ? { message: cron.message } : {}),
    schedule: cron.schedule,
    destination: cron.destination ?? null,
    enabled: cron.enabled,
    ...(cron.archived ? { archived: true } : {}),
    createdAt: cron.createdAt,
    ...(cron.lastFiredAt !== undefined ? { lastFiredAt: cron.lastFiredAt } : {}),
    ...(cron.nextFireAt !== undefined ? { nextFireAt: cron.nextFireAt } : {}),
    permission,
  }
}

export interface ContextWire {
  scopeId: string
  kind: 'personal' | 'channel' | 'group'
  name: string | null
  isPrivate?: boolean
  sessionCount: number
  lastActivityAt: number | null
}

export function contextWire(space: DirectorySpaceRecord): ContextWire {
  const kind = space.kind === 'group' ? 'group' : 'channel'
  const prefix = kind === 'group' ? 'group' : 'channel'
  return {
    scopeId: `${prefix}:${space.spaceId}`,
    kind,
    name: space.name ?? space.spaceId,
    ...(space.isPrivate ? { isPrivate: true } : {}),
    sessionCount: 0,
    lastActivityAt: null,
  }
}
