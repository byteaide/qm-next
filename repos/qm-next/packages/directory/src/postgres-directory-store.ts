/**
 * Postgres DirectoryStore: durable twin of the memory implementation.
 * `apply` runs the shared `applyPush` driver inside one transaction, so a
 * multi-section push lands atomically and rosters survive restarts.
 */
import type { DirectorySyncPush } from '@qm/im-core'
import type { PrincipalType } from '@qm/types'
import { createPgPool, type PgPool, type Rows } from '@qm/store'
import type { DirectoryPersonRecord, DirectorySpaceRecord, DirectoryStore } from './contract.ts'
import { pickMatch } from './contract.ts'
import { applyPush, type DirectoryTables } from './apply-sync.ts'

export const DIRECTORY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS directory_people(
      provider TEXT NOT NULL, provider_user_id TEXT NOT NULL,
      display_name TEXT, email TEXT, type TEXT NOT NULL, timezone TEXT,
      PRIMARY KEY(provider, provider_user_id)
    )`,
  `CREATE TABLE IF NOT EXISTS directory_spaces(
      provider TEXT NOT NULL, space_id TEXT NOT NULL,
      name TEXT, kind TEXT NOT NULL, is_private BOOLEAN NOT NULL DEFAULT FALSE,
      is_external BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY(provider, space_id)
    )`,
  `CREATE TABLE IF NOT EXISTS directory_space_members(
      provider TEXT NOT NULL, space_id TEXT NOT NULL, provider_user_id TEXT NOT NULL,
      PRIMARY KEY(provider, space_id, provider_user_id)
    )`,
  `CREATE TABLE IF NOT EXISTS directory_rosters(
      provider TEXT NOT NULL, space_id TEXT NOT NULL,
      PRIMARY KEY(provider, space_id)
    )`,
  `CREATE TABLE IF NOT EXISTS directory_sync_state(
      provider TEXT NOT NULL, section TEXT NOT NULL, synced_at BIGINT NOT NULL,
      PRIMARY KEY(provider, section)
    )`,
]

type Q = (text: string, params?: unknown[]) => Promise<Rows>

function personRow(r: Record<string, unknown>): DirectoryPersonRecord {
  return {
    provider: r.provider as string,
    providerUserId: r.provider_user_id as string,
    principalId: `${r.provider as string}:${r.provider_user_id as string}`,
    ...(r.display_name != null ? { displayName: r.display_name as string } : {}),
    ...(r.email != null ? { email: r.email as string } : {}),
    type: r.type as PrincipalType,
    ...(r.timezone != null ? { timezone: r.timezone as string } : {}),
  }
}

function spaceRow(r: Record<string, unknown>): DirectorySpaceRecord {
  return {
    provider: r.provider as string,
    spaceId: r.space_id as string,
    ...(r.name != null ? { name: r.name as string } : {}),
    kind: r.kind as DirectorySpaceRecord['kind'],
    isPrivate: r.is_private === true,
    isExternal: r.is_external === true,
  }
}

function makeTables(q: Q): DirectoryTables {
  return {
    async upsertPerson(person) {
      await q(
        `INSERT INTO directory_people(provider, provider_user_id, display_name, email, type, timezone)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (provider, provider_user_id) DO UPDATE SET
           display_name = EXCLUDED.display_name, email = EXCLUDED.email,
           type = EXCLUDED.type, timezone = EXCLUDED.timezone`,
        [person.provider, person.providerUserId, person.displayName ?? null, person.email ?? null, person.type, person.timezone ?? null],
      )
    },
    async deletePeopleExcept(provider, keep) {
      await q('DELETE FROM directory_people WHERE provider = $1 AND NOT (provider_user_id = ANY($2))', [
        provider,
        [...keep],
      ])
    },
    async upsertSpace(space) {
      await q(
        `INSERT INTO directory_spaces(provider, space_id, name, kind, is_private, is_external)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (provider, space_id) DO UPDATE SET
           name = EXCLUDED.name, kind = EXCLUDED.kind,
           is_private = EXCLUDED.is_private, is_external = EXCLUDED.is_external`,
        [space.provider, space.spaceId, space.name ?? null, space.kind, space.isPrivate, space.isExternal],
      )
    },
    async deleteSpacesExcept(provider, keep) {
      await q('DELETE FROM directory_spaces WHERE provider = $1 AND NOT (space_id = ANY($2))', [provider, [...keep]])
      await q('DELETE FROM directory_space_members WHERE provider = $1 AND NOT (space_id = ANY($2))', [provider, [...keep]])
      await q('DELETE FROM directory_rosters WHERE provider = $1 AND NOT (space_id = ANY($2))', [provider, [...keep]])
    },
    async addMember(provider, spaceId, providerUserId) {
      await q(
        'INSERT INTO directory_space_members(provider, space_id, provider_user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [provider, spaceId, providerUserId],
      )
    },
    async replaceMembers(provider, pushed) {
      for (const [spaceId, keep] of pushed) {
        await q(
          'DELETE FROM directory_space_members WHERE provider = $1 AND space_id = $2 AND NOT (provider_user_id = ANY($3))',
          [provider, spaceId, [...keep]],
        )
      }
    },
    async markRosterKnown(provider, spaceId) {
      await q('INSERT INTO directory_rosters(provider, space_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [provider, spaceId])
    },
    async hasRosterKnown(provider, spaceId) {
      const rows = await q('SELECT 1 AS one FROM directory_rosters WHERE provider = $1 AND space_id = $2', [provider, spaceId])
      return rows.length > 0
    },
    async getSyncedAt(provider, section) {
      const rows = await q('SELECT synced_at FROM directory_sync_state WHERE provider = $1 AND section = $2', [provider, section])
      return rows[0] ? Number(rows[0].synced_at) : undefined
    },
    async setSyncedAt(provider, section, at) {
      await q(
        'INSERT INTO directory_sync_state(provider, section, synced_at) VALUES ($1,$2,$3) ON CONFLICT (provider, section) DO UPDATE SET synced_at = EXCLUDED.synced_at',
        [provider, section, at],
      )
    },
  }
}

export function createPostgresDirectoryStore(
  connectionString: string,
  statements: string[] = DIRECTORY_SCHEMA_STATEMENTS,
): DirectoryStore {
  const store: PgPool = createPgPool(connectionString, statements)
  const { q, pool, close } = store
  const tables = makeTables(q)

  return {
    apply: async (push: DirectorySyncPush) => {
      const client = await (await pool()).connect()
      try {
        await client.query('BEGIN')
        const result = await applyPush(makeTables(async (text, params) => (await client.query(text, params)).rows as Rows), push)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async listPeople(provider) {
      const rows = provider
        ? await q('SELECT * FROM directory_people WHERE provider = $1 ORDER BY provider_user_id', [provider])
        : await q('SELECT * FROM directory_people ORDER BY provider, provider_user_id')
      return rows.map(personRow)
    },
    async getPerson(provider, providerUserId) {
      const rows = await q('SELECT * FROM directory_people WHERE provider = $1 AND provider_user_id = $2', [
        provider,
        providerUserId,
      ])
      return rows[0] ? personRow(rows[0]) : null
    },
    async resolvePerson(provider, query) {
      const rows = await q('SELECT * FROM directory_people WHERE provider = $1', [provider])
      const m = pickMatch(
        rows.map(personRow),
        query,
        (person) => person.providerUserId,
        (person) => person.displayName ?? person.principalId,
      )
      if (m.kind === 'one') return { kind: 'one', person: m.item }
      if (m.kind === 'ambiguous') return { kind: 'ambiguous', candidates: m.items }
      return { kind: 'none' }
    },
    async listSpaces(provider) {
      const rows = provider
        ? await q('SELECT * FROM directory_spaces WHERE provider = $1 ORDER BY space_id', [provider])
        : await q('SELECT * FROM directory_spaces ORDER BY provider, space_id')
      return rows.map(spaceRow)
    },
    async getSpace(provider, spaceId) {
      const rows = await q('SELECT * FROM directory_spaces WHERE provider = $1 AND space_id = $2', [provider, spaceId])
      return rows[0] ? spaceRow(rows[0]) : null
    },
    async resolveSpace(provider, query) {
      const rows = await q('SELECT * FROM directory_spaces WHERE provider = $1', [provider])
      const m = pickMatch(
        rows.map(spaceRow),
        query,
        (space) => space.spaceId,
        (space) => space.name ?? space.spaceId,
      )
      if (m.kind === 'one') return { kind: 'one', space: m.item }
      if (m.kind === 'ambiguous') return { kind: 'ambiguous', candidates: m.items }
      return { kind: 'none' }
    },
    async spaceMember(provider, spaceId, providerUserId) {
      const rows = await q(
        'SELECT 1 AS one FROM directory_space_members WHERE provider = $1 AND space_id = $2 AND provider_user_id = $3',
        [provider, spaceId, providerUserId],
      )
      return rows.length > 0
    },
    async spaceMemberIds(provider, spaceId) {
      if (!(await tables.hasRosterKnown(provider, spaceId))) return undefined
      const rows = await q('SELECT provider_user_id FROM directory_space_members WHERE provider = $1 AND space_id = $2', [
        provider,
        spaceId,
      ])
      return rows.map((row) => row.provider_user_id as string)
    },
    async resolveGroupByParticipants(provider, participantIds) {
      const wanted = [...new Set(participantIds)].sort()
      if (!wanted.length) return { kind: 'none' }
      const groups = await q("SELECT * FROM directory_spaces WHERE provider = $1 AND kind = 'group'", [provider])
      for (const row of groups) {
        const space = spaceRow(row)
        const roster = await q('SELECT provider_user_id FROM directory_space_members WHERE provider = $1 AND space_id = $2', [
          provider,
          space.spaceId,
        ])
        const ids = roster.map((r) => r.provider_user_id as string)
        if (!ids.length) continue
        if ([...new Set(ids)].sort().join(',') === wanted.join(',')) return { kind: 'one', space }
      }
      return { kind: 'none' }
    },
    async listVisibleSpaces(provider, actorProviderUserId) {
      const rows = await q(
        `SELECT s.* FROM directory_spaces s
         WHERE s.provider = $1 AND (
           (s.kind = 'channel' AND NOT s.is_private AND NOT s.is_external)
           OR EXISTS (SELECT 1 FROM directory_space_members m
                      WHERE m.provider = s.provider AND m.space_id = s.space_id AND m.provider_user_id = $2)
         ) ORDER BY s.space_id`,
        [provider, actorProviderUserId],
      )
      return rows.map(spaceRow)
    },
    close,
  }
}
