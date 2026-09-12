/**
 * M3 directory contract (15.0, lane-opening freeze): the durable roster
 * store fed by im-core `DirectorySyncPush` (people / spaces / spaceMembers
 * — qm's members/channels/groups triple collapsed into platform-neutral
 * shapes), plus query resolution and the visibility filter.
 *
 * Provider adapters push rosters via `apply`; consumers (reach, triggers,
 * approvals card destinations, web-ui contexts) read through the resolve /
 * list / member surfaces. Provider-scoped throughout: keys are
 * `(provider, providerUserId)` and `(provider, spaceId)`.
 *
 * OUT of M3: person identity merge heuristics, provider write-back
 * (openGroup / registerGroup) — the sync push covers the read path.
 * Changes go back through the main session, never inside a parallel lane.
 */
import type { DirectorySpace, DirectorySyncPush } from '@qm/im-core'
import type { PrincipalType } from '@qm/types'

/** Providers may cap ambiguity candidate lists at this size. */
export const MAX_CANDIDATES = 10

/** Normalize a directory query: trim, lowercase, strip a leading @/#. */
export function normDirectoryQuery(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^[@#]/, '')
}

/** Platform principal id for a provider-native user. */
export function principalIdFor(provider: string, providerUserId: string): string {
  return `${provider}:${providerUserId}`
}

/** One directory person as stored: provider-scoped with its principal id. */
export interface DirectoryPersonRecord {
  provider: string
  providerUserId: string
  /** Platform principal id (`principalIdFor`). */
  principalId: string
  displayName?: string
  email?: string
  type: PrincipalType
  timezone?: string
}

/** One space (channel / group / dm) as stored. */
export interface DirectorySpaceRecord {
  provider: string
  spaceId: string
  name?: string
  kind: DirectorySpace['kind']
  isPrivate: boolean
  isExternal: boolean
}

export type PersonResolution =
  | { kind: 'one'; person: DirectoryPersonRecord }
  | { kind: 'ambiguous'; candidates: DirectoryPersonRecord[] }
  | { kind: 'none' }

export type SpaceResolution =
  | { kind: 'one'; space: DirectorySpaceRecord }
  | { kind: 'ambiguous'; candidates: DirectorySpaceRecord[] }
  | { kind: 'none' }

export type GroupResolution = { kind: 'one'; space: DirectorySpaceRecord } | { kind: 'none' }

/**
 * Generic ranked matcher (qm `pickMatch`, provider-neutral): exact id, then
 * exact label, then unique prefix, then unique substring; ties are
 * ambiguous and capped at `MAX_CANDIDATES`.
 */
export function pickMatch<T>(
  items: readonly T[],
  query: string,
  id: (item: T) => string,
  label: (item: T) => string,
): { kind: 'one'; item: T } | { kind: 'ambiguous'; items: T[] } | { kind: 'none' } {
  const q = normDirectoryQuery(query)
  if (!q) return { kind: 'none' }
  const byId = items.find((item) => id(item).toLowerCase() === q)
  if (byId) return { kind: 'one', item: byId }
  const exact = items.filter((item) => normDirectoryQuery(label(item)) === q)
  if (exact.length === 1) return { kind: 'one', item: exact[0]! }
  if (exact.length > 1) return { kind: 'ambiguous', items: exact.slice(0, MAX_CANDIDATES) }
  const prefix = items.filter((item) => normDirectoryQuery(label(item)).startsWith(q))
  const pool = prefix.length ? prefix : items.filter((item) => normDirectoryQuery(label(item)).includes(q))
  if (pool.length === 0) return { kind: 'none' }
  if (pool.length === 1) return { kind: 'one', item: pool[0]! }
  return { kind: 'ambiguous', items: pool.slice(0, MAX_CANDIDATES) }
}

/**
 * Durable roster store. `apply` is the single write path: each section is
 * stale-guarded on `syncedAt` (a push older than the stored stamp for that
 * `(provider, section)` is refused and `false` returned), upserts the
 * carried rows, and — for sections named in `push.replace` — deletes rows
 * absent from the push (revocation semantics). Memory and Postgres
 * implementations satisfy these semantics identically (parity tests).
 */
export interface DirectoryStore {
  apply(push: DirectorySyncPush): Promise<boolean>
  listPeople(provider?: string): Promise<DirectoryPersonRecord[]>
  getPerson(provider: string, providerUserId: string): Promise<DirectoryPersonRecord | null>
  resolvePerson(provider: string, query: string): Promise<PersonResolution>
  listSpaces(provider?: string): Promise<DirectorySpaceRecord[]>
  getSpace(provider: string, spaceId: string): Promise<DirectorySpaceRecord | null>
  resolveSpace(provider: string, query: string): Promise<SpaceResolution>
  spaceMember(provider: string, spaceId: string, providerUserId: string): Promise<boolean>
  /** Member roster, or undefined when no full roster has synced for the space. */
  spaceMemberIds(provider: string, spaceId: string): Promise<string[] | undefined>
  /** Exact-match group lookup by full participant set. */
  resolveGroupByParticipants(provider: string, participantIds: readonly string[]): Promise<GroupResolution>
  /** Spaces the actor may see: public channels plus spaces they belong to. */
  listVisibleSpaces(provider: string, actorProviderUserId: string): Promise<DirectorySpaceRecord[]>
  close?(): Promise<void>
}

/**
 * Visibility filter: a dm or a private/external space is visible only to
 * its members; a public non-external channel is visible to everyone.
 */
export async function isVisible(
  store: DirectoryStore,
  provider: string,
  actorProviderUserId: string,
  space: DirectorySpaceRecord,
): Promise<boolean> {
  if (space.kind === 'channel' && !space.isPrivate && !space.isExternal) return true
  return store.spaceMember(provider, space.spaceId, actorProviderUserId)
}
