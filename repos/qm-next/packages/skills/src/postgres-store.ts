/**
 * Postgres SkillStore: durable twin of the in-process implementation. The
 * partial unique index on `(scope_id, name) WHERE status = 'published'`
 * makes register collisions a database guarantee; resolution sorts by
 * `created_at, id` so keep-first ordering matches the memory twin.
 */
import { randomUUID } from 'node:crypto'
import type { ScopeId } from '@qm/types'
import { createPgPool, type PgPool } from '@qm/store'
import type { SkillPatch, SkillRecord, SkillResolution, SkillStore } from './contract.ts'
import { assertSafeSkillName, isSafeSkillName } from './skill-name.ts'

export const SKILLS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS skills(
    id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
    body TEXT NOT NULL, required_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'published', created_by TEXT NOT NULL,
    version BIGINT NOT NULL DEFAULT 1, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    last_used_at BIGINT)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_skills_published_name ON skills(scope_id, name) WHERE status = 'published'`,
  `CREATE INDEX IF NOT EXISTS idx_skills_scope ON skills(scope_id, status)`,
]

const COLUMNS = 'id, scope_id, name, description, body, required_capabilities, status, created_by, version, created_at, updated_at, last_used_at'

function row(r: Record<string, unknown>): SkillRecord {
  return {
    id: r.id as string,
    scopeId: r.scope_id as ScopeId,
    name: r.name as string,
    description: r.description as string,
    body: r.body as string,
    requiredCapabilities: (r.required_capabilities as string[]) ?? [],
    status: r.status as SkillRecord['status'],
    createdBy: r.created_by as string,
    version: Number(r.version),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    ...(r.last_used_at != null ? { lastUsedAt: Number(r.last_used_at) } : {}),
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}

const ORDER = ' ORDER BY created_at, id'

export function createPostgresSkillStore(connectionString: string): SkillStore {
  const pool: PgPool = createPgPool(connectionString, SKILLS_SCHEMA_STATEMENTS)

  async function publishedOrdered(): Promise<SkillRecord[]> {
    const rows = await pool.q(`SELECT ${COLUMNS} FROM skills WHERE status = 'published'${ORDER}`)
    return rows.map(row)
  }

  function resolveIndex(orderedScopes: ScopeId[], published: SkillRecord[]): (name: string) => SkillResolution {
    const rank = new Map(orderedScopes.map((scopeId, i) => [scopeId, i]))
    const byName = new Map<string, SkillRecord[]>()
    for (const skill of published) {
      if (!rank.has(skill.scopeId) || !isSafeSkillName(skill.name)) continue
      const list = byName.get(skill.name) ?? []
      list.push(skill)
      byName.set(skill.name, list)
    }
    return (name: string) => {
      if (!isSafeSkillName(name)) return { skill: null, shadowed: [] }
      const candidates = (byName.get(name) ?? []).slice()
      candidates.sort((a, b) => {
        const ra = rank.get(a.scopeId)!
        const rb = rank.get(b.scopeId)!
        if (ra !== rb) return ra - rb
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
      const [skill, ...shadowed] = candidates
      return { skill: skill ?? null, shadowed }
    }
  }

  return {
    async register(input) {
      assertSafeSkillName(input.name)
      const at = Date.now()
      try {
        const rows = await pool.q(`INSERT INTO skills (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'published',$7,1,$8,$8,NULL) RETURNING ${COLUMNS}`, [
          randomUUID(),
          input.scopeId,
          input.name,
          input.description,
          input.body,
          JSON.stringify(input.requiredCapabilities ?? []),
          input.createdBy,
          at,
        ])
        return row(rows[0]!)
      } catch (e) {
        if (isUniqueViolation(e)) throw new Error(`skill name collision in scope ${input.scopeId}: ${input.name}`)
        throw e
      }
    },

    async update(id, patch: SkillPatch) {
      const sets: string[] = []
      const params: unknown[] = [id]
      if (patch.description !== undefined) {
        params.push(patch.description)
        sets.push(`description = $${params.length}`)
      }
      if (patch.body !== undefined) {
        params.push(patch.body)
        sets.push(`body = $${params.length}`)
      }
      if (patch.requiredCapabilities !== undefined) {
        params.push(JSON.stringify(patch.requiredCapabilities))
        sets.push(`required_capabilities = $${params.length}::jsonb`)
      }
      params.push(Date.now())
      sets.push(`updated_at = $${params.length}`)
      params.push(1)
      sets.push(`version = version + $${params.length}`)
      const rows = await pool.q(`UPDATE skills SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`, params)
      if (!rows[0]) throw new Error(`unknown skill: ${id}`)
      return row(rows[0])
    },

    get: async (id) => {
      const rows = await pool.q(`SELECT ${COLUMNS} FROM skills WHERE id = $1`, [id])
      return rows[0] ? row(rows[0]) : null
    },

    list: async () => {
      const rows = await pool.q(`SELECT ${COLUMNS} FROM skills${ORDER}`)
      return rows.map(row)
    },

    async publish(id) {
      const rows = await pool.q(`SELECT ${COLUMNS} FROM skills WHERE id = $1`, [id])
      if (!rows[0]) throw new Error(`unknown skill: ${id}`)
      const skill = row(rows[0])
      if (skill.status === 'published') return skill
      try {
        const updated = await pool.q(`UPDATE skills SET status = 'published', updated_at = $2 WHERE id = $1 RETURNING ${COLUMNS}`, [
          id,
          Date.now(),
        ])
        return row(updated[0]!)
      } catch (e) {
        if (isUniqueViolation(e)) throw new Error(`skill name collision in scope ${skill.scopeId}: ${skill.name}`)
        throw e
      }
    },

    async archive(id) {
      const rows = await pool.q(`UPDATE skills SET status = 'archived', updated_at = $2 WHERE id = $1 AND status <> 'archived' RETURNING ${COLUMNS}`, [
        id,
        Date.now(),
      ])
      if (rows[0]) return row(rows[0])
      const existing = await pool.q(`SELECT ${COLUMNS} FROM skills WHERE id = $1`, [id])
      if (!existing[0]) throw new Error(`unknown skill: ${id}`)
      return row(existing[0])
    },

    delete: async (id) => {
      await pool.q('DELETE FROM skills WHERE id = $1', [id])
    },

    recordUse: async (id, at) => {
      const rows = await pool.q('UPDATE skills SET last_used_at = $2 WHERE id = $1 RETURNING id', [id, at ?? Date.now()])
      if (!rows[0]) throw new Error(`unknown skill: ${id}`)
    },

    resolve: async (name, orderedScopes) => {
      const resolve = resolveIndex(orderedScopes, await publishedOrdered())
      return resolve(name)
    },

    visibleFor: async (orderedScopes) => {
      const published = await publishedOrdered()
      const resolve = resolveIndex(orderedScopes, published)
      const names = new Set(published.filter((s) => orderedScopes.includes(s.scopeId) && isSafeSkillName(s.name)).map((s) => s.name))
      return [...names]
        .sort()
        .map((n) => resolve(n))
        .filter((r): r is SkillResolution & { skill: SkillRecord } => r.skill !== null)
    },

    close: async () => pool.close(),
  }
}
