/**
 * In-memory DirectoryStore: dev/test twin of the Postgres implementation.
 * `apply` delegates to the shared `applyPush` driver over the same abstract
 * table semantics, so the two implementations cannot drift.
 */
import type { DirectorySyncPush } from '@qm/im-core'
import type {
  DirectoryPersonRecord,
  DirectorySpaceRecord,
  DirectoryStore,
} from './contract.ts'
import { pickMatch } from './contract.ts'
import { applyPush, type DirectoryTables } from './apply-sync.ts'

function personKey(provider: string, providerUserId: string): string {
  return `${provider}:${providerUserId}`
}

function spaceKey(provider: string, spaceId: string): string {
  return `${provider}:${spaceId}`
}

export function createMemoryDirectoryStore(): DirectoryStore {
  const people = new Map<string, DirectoryPersonRecord>()
  const spaces = new Map<string, DirectorySpaceRecord>()
  const members = new Map<string, Set<string>>()
  const rostersKnown = new Set<string>()
  const syncedAts = new Map<string, number>()

  const tables: DirectoryTables = {
    async upsertPerson(person) {
      people.set(personKey(person.provider, person.providerUserId), person)
    },
    async deletePeopleExcept(provider, keep) {
      for (const [key, person] of people) {
        if (person.provider === provider && !keep.has(person.providerUserId)) people.delete(key)
      }
    },
    async upsertSpace(space) {
      spaces.set(spaceKey(space.provider, space.spaceId), space)
    },
    async deleteSpacesExcept(provider, keep) {
      const doomed = [...spaces.values()].filter((space) => space.provider === provider && !keep.has(space.spaceId))
      for (const space of doomed) {
        const key = spaceKey(provider, space.spaceId)
        spaces.delete(key)
        members.delete(key)
        rostersKnown.delete(key)
      }
    },
    async addMember(provider, spaceId, providerUserId) {
      const key = spaceKey(provider, spaceId)
      const set = members.get(key) ?? new Set<string>()
      set.add(providerUserId)
      members.set(key, set)
    },
    async replaceMembers(provider, pushed) {
      for (const [key, set] of members) {
        if (!key.startsWith(`${provider}:`)) continue
        const spaceId = key.slice(provider.length + 1)
        const keep = pushed.get(spaceId)
        if (!keep) continue
        for (const providerUserId of [...set]) {
          if (!keep.has(providerUserId)) set.delete(providerUserId)
        }
      }
    },
    async markRosterKnown(provider, spaceId) {
      rostersKnown.add(spaceKey(provider, spaceId))
    },
    async hasRosterKnown(provider, spaceId) {
      return rostersKnown.has(spaceKey(provider, spaceId))
    },
    async getSyncedAt(provider, section) {
      return syncedAts.get(`${provider}:${section}`)
    },
    async setSyncedAt(provider, section, at) {
      syncedAts.set(`${provider}:${section}`, at)
    },
  }

  return {
    apply: (push: DirectorySyncPush) => applyPush(tables, push),
    async listPeople(provider) {
      const all = [...people.values()]
      return provider ? all.filter((person) => person.provider === provider) : all
    },
    async getPerson(provider, providerUserId) {
      return people.get(personKey(provider, providerUserId)) ?? null
    },
    async resolvePerson(provider, query) {
      const scoped = [...people.values()].filter((person) => person.provider === provider)
      const m = pickMatch(
        scoped,
        query,
        (person) => person.providerUserId,
        (person) => person.displayName ?? person.principalId,
      )
      if (m.kind === 'one') return { kind: 'one', person: m.item }
      if (m.kind === 'ambiguous') return { kind: 'ambiguous', candidates: m.items }
      return { kind: 'none' }
    },
    async listSpaces(provider) {
      const all = [...spaces.values()]
      return provider ? all.filter((space) => space.provider === provider) : all
    },
    async getSpace(provider, spaceId) {
      return spaces.get(spaceKey(provider, spaceId)) ?? null
    },
    async resolveSpace(provider, query) {
      const scoped = [...spaces.values()].filter((space) => space.provider === provider)
      const m = pickMatch(
        scoped,
        query,
        (space) => space.spaceId,
        (space) => space.name ?? space.spaceId,
      )
      if (m.kind === 'one') return { kind: 'one', space: m.item }
      if (m.kind === 'ambiguous') return { kind: 'ambiguous', candidates: m.items }
      return { kind: 'none' }
    },
    async spaceMember(provider, spaceId, providerUserId) {
      return members.get(spaceKey(provider, spaceId))?.has(providerUserId) ?? false
    },
    async spaceMemberIds(provider, spaceId) {
      if (!rostersKnown.has(spaceKey(provider, spaceId))) return undefined
      return [...(members.get(spaceKey(provider, spaceId)) ?? [])]
    },
    async resolveGroupByParticipants(provider, participantIds) {
      const wanted = [...new Set(participantIds)].sort()
      if (!wanted.length) return { kind: 'none' }
      for (const space of spaces.values()) {
        if (space.provider !== provider || space.kind !== 'group') continue
        const roster = members.get(spaceKey(provider, space.spaceId))
        if (!roster) continue
        if ([...new Set(roster)].sort().join(',') === wanted.join(',')) return { kind: 'one', space }
      }
      return { kind: 'none' }
    },
    async listVisibleSpaces(provider, actorProviderUserId) {
      const scoped = await this.listSpaces(provider)
      const visible: DirectorySpaceRecord[] = []
      for (const space of scoped) {
        const isPublicChannel = space.kind === 'channel' && !space.isPrivate && !space.isExternal
        if (isPublicChannel || members.get(spaceKey(provider, space.spaceId))?.has(actorProviderUserId)) {
          visible.push(space)
        }
      }
      return visible
    },
    async close() {},
  }
}
