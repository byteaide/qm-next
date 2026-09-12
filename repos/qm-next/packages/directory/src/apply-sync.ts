/**
 * Shared sync driver: `applyPush` runs the frozen `DirectoryStore.apply`
 * semantics (stale-guard, upsert, replace-revocation) over an abstract
 * table surface. Both the memory and Postgres stores are thin `DirectoryTables`
 * adapters, so the two implementations are parity-checked by construction.
 */
import type { DirectoryPersonRecord, DirectorySpaceRecord } from './contract.ts'
import { principalIdFor } from './contract.ts'

export interface DirectoryTables {
  upsertPerson(person: DirectoryPersonRecord): Promise<void>
  deletePeopleExcept(provider: string, keepProviderUserIds: ReadonlySet<string>): Promise<void>
  upsertSpace(space: DirectorySpaceRecord): Promise<void>
  deleteSpacesExcept(provider: string, keepSpaceIds: ReadonlySet<string>): Promise<void>
  addMember(provider: string, spaceId: string, providerUserId: string): Promise<void>
  /** Full-roster swap for the spaces named in `pushed`; other spaces keep their rosters. */
  replaceMembers(provider: string, pushed: ReadonlyMap<string, ReadonlySet<string>>): Promise<void>
  markRosterKnown(provider: string, spaceId: string): Promise<void>
  hasRosterKnown(provider: string, spaceId: string): Promise<boolean>
  getSyncedAt(provider: string, section: string): Promise<number | undefined>
  setSyncedAt(provider: string, section: string, at: number): Promise<void>
}

const SECTIONS = ['people', 'spaces', 'spaceMembers'] as const

/** Run the frozen `apply` semantics over the abstract tables; returns false on a stale push. */
export async function applyPush(tables: DirectoryTables, push: DirectorySyncPush): Promise<boolean> {
  const carried = SECTIONS.filter((section) => {
    if (section === 'people') return push.people !== undefined
    if (section === 'spaces') return push.spaces !== undefined
    return push.spaceMembers !== undefined
  })
  for (const section of carried) {
    if (!(await acceptSync(tables, push.provider, section, push.syncedAt))) return false
  }
  for (const section of carried) await tables.setSyncedAt(push.provider, section, push.syncedAt)
  if (push.people) {
    for (const person of push.people) {
      await tables.upsertPerson({
        provider: push.provider,
        providerUserId: person.providerUserId,
        principalId: principalIdFor(push.provider, person.providerUserId),
        ...(person.displayName ? { displayName: person.displayName } : {}),
        ...(person.email ? { email: person.email } : {}),
        type: person.type,
        ...(person.timezone ? { timezone: person.timezone } : {}),
      })
    }
    if (push.replace?.includes('people')) {
      await tables.deletePeopleExcept(push.provider, new Set(push.people.map((p) => p.providerUserId)))
    }
  }
  if (push.spaces) {
    for (const space of push.spaces) {
      await tables.upsertSpace({
        provider: push.provider,
        spaceId: space.spaceId,
        ...(space.name ? { name: space.name } : {}),
        kind: space.kind,
        isPrivate: space.isPrivate === true,
        isExternal: space.isExternal === true,
      })
    }
    if (push.replace?.includes('spaces')) {
      await tables.deleteSpacesExcept(push.provider, new Set(push.spaces.map((s) => s.spaceId)))
    }
  }
  if (push.spaceMembers) {
    const pushed = new Map<string, Set<string>>()
    for (const member of push.spaceMembers) {
      const set = pushed.get(member.spaceId) ?? new Set<string>()
      set.add(member.providerUserId)
      pushed.set(member.spaceId, set)
    }
    for (const [spaceId, userIds] of pushed) {
      for (const providerUserId of userIds) await tables.addMember(push.provider, spaceId, providerUserId)
      if (push.replace?.includes('spaceMembers')) await tables.markRosterKnown(push.provider, spaceId)
    }
    if (push.replace?.includes('spaceMembers')) await tables.replaceMembers(push.provider, pushed)
  }
  return true
}

async function acceptSync(
  tables: DirectoryTables,
  provider: string,
  section: string,
  syncedAt: number | undefined,
): Promise<boolean> {
  if (syncedAt === undefined) return true
  const stored = await tables.getSyncedAt(provider, section)
  if (stored !== undefined && stored > syncedAt) return false
  return true
}
