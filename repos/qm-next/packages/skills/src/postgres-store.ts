/**
 * Postgres SkillStore: durable twin of the in-process implementation. The
 * partial unique index on `(scope_id, name) WHERE status = 'published'`
 * makes register collisions a database guarantee; resolution sorts by
 * `created_at, id` so keep-first ordering matches the memory twin.
 *
 * 15.0: adds the full-lifecycle columns (files, granted_capabilities,
 * approvals, pack, signature) via idempotent ALTERs so 14.0 deployments
 * upgrade in place.
 */
import { randomUUID } from 'node:crypto'
import type { ScopeId } from '@qm/types'
import { createPgPool, type PgPool } from '@qm/store'
import type { SkillCreateInput, SkillPatch, SkillRecord, SkillResolution, SkillStore } from './contract.ts'
import { assertSafeSkillName, isSafeSkillName } from './skill-name.ts'
import { createSigner, type Signer } from './manifest.ts'
import { parseScopeId } from '@qm/types'

export const SKILLS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS skills(
    id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
    body TEXT NOT NULL, required_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'published', created_by TEXT NOT NULL,
    version BIGINT NOT NULL DEFAULT 1, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    last_used_at BIGINT)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_skills_published_name ON skills(scope_id, name) WHERE status = 'published'`,
  `CREATE INDEX IF NOT EXISTS idx_skills_scope ON skills(scope_id, status)`,
  // 15.0: full-lifecycle columns (idempotent so re-running CREATE picks up older deployments).
  `ALTER TABLE skills ADD COLUMN IF NOT EXISTS files JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE skills ADD COLUMN IF NOT EXISTS granted_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE skills ADD COLUMN IF NOT EXISTS approvals JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE skills ADD COLUMN IF NOT EXISTS pack JSONB`,
  `ALTER TABLE skills ADD COLUMN IF NOT EXISTS signature TEXT`,
]

const COLUMNS = 'id, scope_id, name, description, body, required_capabilities, status, created_by, version, created_at, updated_at, last_used_at, files, granted_capabilities, approvals, pack, signature'

function row(r: Record<string, unknown>): SkillRecord {
  const files = (r.files as Array<Record<string, unknown>> | null) ?? []
  const granted = (r.granted_capabilities as string[] | null) ?? []
  const approvals = (r.approvals as string[] | null) ?? []
  const packRaw = r.pack as Record<string, unknown> | null
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
    ...(files.length ? { files: files.map((f) => ({ path: String(f.path), content: String(f.content ?? ''), ...(f.executable === true ? { executable: true } : {}) })) } : {}),
    ...(granted.length ? { grantedCapabilities: granted } : {}),
    ...(approvals.length ? { approvals } : {}),
    ...(typeof r.signature === 'string' && r.signature ? { signature: r.signature } : {}),
    ...(packRaw && typeof packRaw.packId === 'string' ? { pack: { packId: String(packRaw.packId), commit: String(packRaw.commit ?? ''), upstreamName: String(packRaw.upstreamName ?? '') } } : {}),
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}

const ORDER = ' ORDER BY created_at, id'

export function createPostgresSkillStore(
  connectionString: string,
  opts: { signingSecret?: string } = {},
): SkillStore {
  const pool: PgPool = createPgPool(connectionString, SKILLS_SCHEMA_STATEMENTS)
  const signer: Signer = createSigner(opts.signingSecret)

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
      const signature = signer.sign({
        name: input.name,
        description: input.description,
        body: input.body,
        requiredCapabilities: input.requiredCapabilities ?? [],
        ...(input.files ? { files: input.files } : {}),
      })
      try {
        const rows = await pool.q(
          `INSERT INTO skills (${COLUMNS}) VALUES (
            $1,$2,$3,$4,$5,$6::jsonb,'published',$7,1,$8,$8,NULL,
            $9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13
          ) RETURNING ${COLUMNS}`,
          [
            randomUUID(),
            input.scopeId,
            input.name,
            input.description,
            input.body,
            JSON.stringify(input.requiredCapabilities ?? []),
            input.createdBy,
            at,
            JSON.stringify(input.files ?? []),
            JSON.stringify([]),
            JSON.stringify([]),
            input.pack ? JSON.stringify(input.pack) : null,
            signature,
          ],
        )
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

    async create(input: SkillCreateInput) {
      assertSafeSkillName(input.manifest.name)
      const at = Date.now()
      const granted = input.grantCapabilities ?? input.manifest.requiredCapabilities
      const signature = signer.sign(input.manifest)
      try {
        const rows = await pool.q(
          `INSERT INTO skills (${COLUMNS}) VALUES (
            $1,$2,$3,$4,$5,$6::jsonb,'published',$7,1,$8,$8,NULL,
            $9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13
          ) RETURNING ${COLUMNS}`,
          [
            randomUUID(),
            input.scopeId,
            input.manifest.name,
            input.manifest.description,
            input.manifest.body,
            JSON.stringify(input.manifest.requiredCapabilities),
            input.createdBy,
            at,
            JSON.stringify(input.manifest.files ?? []),
            JSON.stringify(granted),
            JSON.stringify([input.reviewer]),
            input.pack ? JSON.stringify(input.pack) : null,
            signature,
          ],
        )
        return row(rows[0]!)
      } catch (e) {
        if (isUniqueViolation(e)) throw new Error(`skill name collision in scope ${input.scopeId}: ${input.manifest.name}`)
        throw e
      }
    },

    verify(skill) {
      if (!skill.signature) return false
      return signer.verify(
        {
          name: skill.name,
          description: skill.description,
          body: skill.body,
          requiredCapabilities: skill.requiredCapabilities,
          ...(skill.files ? { files: skill.files } : {}),
        },
        skill.signature,
      )
    },

    async restore(skill) {
      assertSafeSkillName(skill.name)
      const at = Date.now()
      await pool.q(
        `INSERT INTO skills (${COLUMNS}) VALUES (
          $1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,
          $13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17
        )
        ON CONFLICT (id) DO UPDATE SET
          scope_id = EXCLUDED.scope_id, name = EXCLUDED.name, description = EXCLUDED.description,
          body = EXCLUDED.body, required_capabilities = EXCLUDED.required_capabilities,
          status = EXCLUDED.status, version = EXCLUDED.version, updated_at = EXCLUDED.updated_at,
          files = EXCLUDED.files, granted_capabilities = EXCLUDED.granted_capabilities,
          approvals = EXCLUDED.approvals, pack = EXCLUDED.pack, signature = EXCLUDED.signature`,
        [
          skill.id,
          skill.scopeId,
          skill.name,
          skill.description,
          skill.body,
          JSON.stringify(skill.requiredCapabilities),
          skill.status,
          skill.createdBy,
          skill.version,
          skill.createdAt ?? at,
          at,
          skill.lastUsedAt ?? null,
          JSON.stringify(skill.files ?? []),
          JSON.stringify(skill.grantedCapabilities ?? []),
          JSON.stringify(skill.approvals ?? []),
          skill.pack ? JSON.stringify(skill.pack) : null,
          skill.signature ?? null,
        ],
      )
    },

    async promote(id, targetScopeId) {
      const s = await pool.q(`SELECT ${COLUMNS} FROM skills WHERE id = $1`, [id])
      if (!s[0]) throw new Error(`unknown skill: ${id}`)
      const skill = row(s[0]!)
      assertSafeSkillName(skill.name)
      if (skill.status !== 'published') throw new Error('only a published skill can be promoted')
      if (!skill.signature) throw new Error('skill signature missing — cannot promote')
      try {
        const at = Date.now()
        const rows = await pool.q(
          `INSERT INTO skills (${COLUMNS}) VALUES (
            $1,$2,$3,$4,$5,$6::jsonb,'published',$7,$8,$9,$10,$11,
            $12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16
          )
          ON CONFLICT (id) DO UPDATE SET
            scope_id = EXCLUDED.scope_id, status = 'published', version = skills.version + 1,
            updated_at = EXCLUDED.updated_at, files = EXCLUDED.files,
            granted_capabilities = EXCLUDED.granted_capabilities, approvals = EXCLUDED.approvals,
            pack = EXCLUDED.pack, signature = EXCLUDED.signature
          RETURNING ${COLUMNS}`,
          [
            skill.id,
            targetScopeId,
            skill.name,
            skill.description,
            skill.body,
            JSON.stringify(skill.requiredCapabilities),
            skill.createdBy,
            (skill.version ?? 1) + 1,
            Date.now(),
            at,
            null,
            JSON.stringify(skill.files ?? []),
            JSON.stringify(skill.grantedCapabilities ?? []),
            JSON.stringify(skill.approvals ?? []),
            skill.pack ? JSON.stringify(skill.pack) : null,
            skill.signature,
          ],
        )
        return row(rows[0]!)
      } catch (e) {
        if (isUniqueViolation(e)) throw new Error(`skill name collision in scope ${targetScopeId}: ${skill.name}`)
        throw e
      }
    },

    async move(id, toScopeId) {
      if (parseScopeId(toScopeId).kind === 'org')
        throw new Error('ceding a skill to the org goes through promote (admin-gated), not move')
      const rows = await pool.q(
        `UPDATE skills SET scope_id = $2, updated_at = $3 WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, toScopeId, Date.now()],
      )
      if (!rows[0]) throw new Error(`unknown skill: ${id}`)
      return row(rows[0]!)
    },

    close: async () => pool.close(),
  }
}
