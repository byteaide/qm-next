/**
 * Directory routes (parity contract "directory", 5 routes): the qm
 * members/channels/groups sync vocabulary translated onto the provider-
 * neutral DirectorySyncPush store (lane A: provider 'slack', single
 * workspace). deactivate/reactivate stay identity-gated (404 until the
 * identity service lands with the control plane), matching qm's behavior
 * when identity is unwired. Shapes per docs/parity-api-contract.md.
 */
import type { DirectoryStore } from '@qm/directory'
import type { DirectoryPerson, DirectorySpace, DirectorySpaceMember, DirectorySyncPush } from '@qm/im-core'
import type { PrincipalType } from '@qm/types'
import type { ApiRouteContext, Route } from './framework.ts'
import { badRequest, isObj, notFound, sendJson } from './framework.ts'

const PROVIDER = 'slack'
const INSTANCE = 'default'

/** Slack principal ids look like U/A/W + 8+ uppercase alphanumerics. */
const SLACK_ID_RE = /^[UW][A-Z0-9]{8,}$/

/** Deployment meta served by GET /v1/directory/meta (per-process, like qm's app meta). */
export interface DirectoryMeta {
  workspaceUrl?: string
  membersSyncedAt?: number
  channelsSyncedAt?: number
  groupsSyncedAt?: number
}

export interface DirectoryRoutesDeps {
  directory?: DirectoryStore
  /** Identity service arrives with the control plane; routes 404 without it (qm parity). */
  identity?: {
    externalMember(id: string): { active?: boolean } | undefined
    setActive(id: string, active: boolean): Promise<void>
  }
}

interface QmMemberInput {
  id?: unknown
  name?: unknown
  email?: unknown
  type?: unknown
  timezone?: unknown
}

interface QmChannelInput {
  id?: unknown
  name?: unknown
  isPrivate?: unknown
  isExternal?: unknown
}

function personOf(m: QmMemberInput): DirectoryPerson | null {
  if (typeof m.id !== 'string' || !m.id) return null
  const person: DirectoryPerson = {
    providerUserId: m.id,
    type: (typeof m.type === 'string' ? m.type : 'internal') as PrincipalType,
  }
  if (typeof m.name === 'string') person.displayName = m.name
  if (typeof m.email === 'string') person.email = m.email
  if (typeof m.timezone === 'string') person.timezone = m.timezone
  return person
}

function spaceOf(c: QmChannelInput, kind: DirectorySpace['kind']): DirectorySpace | null {
  if (typeof c.id !== 'string' || !c.id) return null
  const space: DirectorySpace = { spaceId: c.id, kind, isPrivate: c.isPrivate === true, isExternal: c.isExternal === true }
  if (typeof c.name === 'string') space.name = c.name
  return space
}

/**
 * Read roster pairs from the qm sync vocabulary. `channelMembers` accepts
 * `{ channelId, userIds[] }` entries (or `spaceId`/`providerUserIds`
 * spellings); `groupMembers` likewise under `groupId`/`groupIds`.
 */
function spaceMembersOf(body: Record<string, unknown>): DirectorySpaceMember[] {
  const out: DirectorySpaceMember[] = []
  for (const key of ['channelMembers', 'groupMembers']) {
    const entries = body[key]
    if (!Array.isArray(entries)) continue
    for (const raw of entries) {
      if (!isObj(raw)) continue
      const spaceId = typeof raw.channelId === 'string' ? raw.channelId : typeof raw.spaceId === 'string' ? raw.spaceId : typeof raw.groupId === 'string' ? raw.groupId : undefined
      if (!spaceId) continue
      const userIds = raw.userIds ?? raw.providerUserIds ?? raw.members
      if (!Array.isArray(userIds)) continue
      for (const u of userIds) {
        if (typeof u === 'string' && u) out.push({ spaceId, providerUserId: u })
      }
    }
  }
  return out
}

function memberView(p: { providerUserId: string; principalId: string; displayName?: string; email?: string; type: PrincipalType; timezone?: string }): Record<string, unknown> {
  const view: Record<string, unknown> = { id: p.principalId, type: p.type }
  if (p.displayName !== undefined) view.name = p.displayName
  if (p.email !== undefined) view.email = p.email
  if (p.timezone !== undefined) view.timezone = p.timezone
  view.slackId = SLACK_ID_RE.test(p.providerUserId) ? p.providerUserId : SLACK_ID_RE.test(p.principalId) ? p.principalId : p.providerUserId
  return view
}

async function deactivate(ctx: ApiRouteContext, deps: DirectoryRoutesDeps, active: boolean): Promise<void> {
  if (!deps.identity) return notFound(ctx)
  const id = ctx.params.id
  if (!id) return notFound(ctx)
  await deps.identity.setActive(id, active)
  return sendJson(ctx, 200, { ok: true, principalId: id, active })
}

export function directoryRoutes(deps: DirectoryRoutesDeps, meta: DirectoryMeta = {}): ReadonlyArray<Route> {
  return [
    {
      method: 'POST',
      path: '/v1/principals/:id/deactivate',
      auth: 'source',
      handle: async (ctx) => deactivate(ctx, deps, false),
    },
    {
      method: 'POST',
      path: '/v1/principals/:id/reactivate',
      auth: 'source',
      handle: async (ctx) => deactivate(ctx, deps, true),
    },
    {
      method: 'POST',
      path: '/v1/directory',
      auth: 'source',
      handle: async (ctx) => {
        if (!deps.directory) return notFound(ctx)
        const body = isObj(ctx.body) ? ctx.body : {}
        const people: DirectoryPerson[] = []
        const spaces: DirectorySpace[] = []
        if (Array.isArray(body.members)) {
          for (const raw of body.members) {
            if (isObj(raw)) {
              const person = personOf(raw)
              if (person) people.push(person)
            }
          }
        }
        if (Array.isArray(body.channels)) {
          for (const raw of body.channels) {
            if (isObj(raw)) {
              const space = spaceOf(raw, 'channel')
              if (space) spaces.push(space)
            }
          }
        }
        if (Array.isArray(body.groups)) {
          for (const raw of body.groups) {
            if (isObj(raw)) {
              const space = spaceOf(raw, 'group')
              if (space) spaces.push(space)
            }
          }
        }
        const spaceMembers = spaceMembersOf(body)
        if (!people.length && !spaces.length && !spaceMembers.length) {
          return badRequest(ctx, 'members, channels or group members are required')
        }
        const push: DirectorySyncPush = { provider: PROVIDER, instanceId: INSTANCE, syncedAt: Date.now() }
        const replace: DirectorySyncPush['replace'] = []
        if (people.length) {
          push.people = people
          replace.push('people')
        }
        if (spaces.length) {
          push.spaces = spaces
          replace.push('spaces')
        }
        if (spaceMembers.length) {
          push.spaceMembers = spaceMembers
          replace.push('spaceMembers')
        }
        if (replace.length) push.replace = replace
        const applied = await deps.directory.apply(push)
        if (!applied) return badRequest(ctx, 'stale sync: a newer snapshot already landed', 'stale_sync')
        if (typeof body.workspaceUrl === 'string') meta.workspaceUrl = body.workspaceUrl
        if (people.length && typeof body.membersSyncedAt === 'number') meta.membersSyncedAt = body.membersSyncedAt
        if (spaces.length && typeof body.channelsSyncedAt === 'number') meta.channelsSyncedAt = body.channelsSyncedAt
        if (spaceMembers.length && typeof body.groupsSyncedAt === 'number') meta.groupsSyncedAt = body.groupsSyncedAt
        return sendJson(ctx, 200, {
          ok: true,
          members: people.length,
          channels: spaces.length,
          groupMembers: spaceMembers.length,
        })
      },
    },
    {
      method: 'GET',
      path: '/v1/directory/meta',
      auth: 'source',
      handle: async (ctx) => {
        if (!deps.directory) return notFound(ctx)
        return sendJson(ctx, 200, meta)
      },
    },
    {
      method: 'GET',
      path: '/v1/directory/resolve',
      auth: 'source',
      handle: async (ctx) => {
        if (!deps.directory) return notFound(ctx)
        const q = (ctx.query.q ?? '').trim()
        if (!q) return badRequest(ctx, 'q is required')
        const resolution = await deps.directory.resolvePerson(PROVIDER, q)
        const matches =
          resolution.kind === 'one' ? [resolution.person] : resolution.kind === 'ambiguous' ? resolution.candidates : []
        return sendJson(ctx, 200, { matches: matches.map(memberView) })
      },
    },
  ]
}
