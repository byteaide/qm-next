/**
 * In-process SkillStore. Resolution order is deterministic: scope-chain
 * position first, then creation time, then id — mirroring the Postgres
 * twin's `ORDER BY created_at, id` plus the per-scope published-name
 * uniqueness enforced at register time.
 */
import { randomUUID } from 'node:crypto'
import type { ScopeId } from '@qm/types'
import type { SkillRecord, SkillResolution, SkillStore } from './contract.ts'
import { assertSafeSkillName, isSafeSkillName } from './skill-name.ts'

export function createMemorySkillStore(): SkillStore {
  const skills = new Map<string, SkillRecord>()

  function requireSkill(id: string): SkillRecord {
    const skill = skills.get(id)
    if (!skill) throw new Error(`unknown skill: ${id}`)
    return skill
  }

  function publishedByName(orderedScopes: ScopeId[]): Map<string, SkillRecord[]> {
    const rank = new Map(orderedScopes.map((scopeId, i) => [scopeId, i]))
    const byName = new Map<string, SkillRecord[]>()
    for (const skill of skills.values()) {
      if (skill.status !== 'published' || !isSafeSkillName(skill.name)) continue
      if (!rank.has(skill.scopeId)) continue
      const list = byName.get(skill.name) ?? []
      list.push(skill)
      byName.set(skill.name, list)
    }
    for (const [name, list] of byName) {
      list.sort((a, b) => {
        const ra = rank.get(a.scopeId)!
        const rb = rank.get(b.scopeId)!
        if (ra !== rb) return ra - rb
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
      byName.set(name, list)
    }
    return byName
  }

  function resolveFromIndex(byName: Map<string, SkillRecord[]>, name: string): SkillResolution {
    if (!isSafeSkillName(name)) return { skill: null, shadowed: [] }
    const candidates = byName.get(name) ?? []
    const [skill, ...shadowed] = candidates
    return { skill: skill ?? null, shadowed }
  }

  return {
    async register(input) {
      assertSafeSkillName(input.name)
      const existing = [...skills.values()].find(
        (s) => s.status === 'published' && s.scopeId === input.scopeId && s.name === input.name,
      )
      if (existing) throw new Error(`skill name collision in scope ${input.scopeId}: ${input.name}`)
      const at = Date.now()
      const skill: SkillRecord = {
        id: randomUUID(),
        scopeId: input.scopeId,
        name: input.name,
        description: input.description,
        body: input.body,
        requiredCapabilities: [...(input.requiredCapabilities ?? [])],
        status: 'published',
        createdBy: input.createdBy,
        version: 1,
        createdAt: at,
        updatedAt: at,
      }
      skills.set(skill.id, skill)
      return skill
    },

    async update(id, patch) {
      const skill = requireSkill(id)
      if (patch.description !== undefined) skill.description = patch.description
      if (patch.body !== undefined) skill.body = patch.body
      if (patch.requiredCapabilities !== undefined) skill.requiredCapabilities = [...patch.requiredCapabilities]
      skill.version += 1
      skill.updatedAt = Date.now()
      return skill
    },

    get: async (id) => skills.get(id) ?? null,
    list: async () => [...skills.values()],

    async publish(id) {
      const skill = requireSkill(id)
      if (skill.status === 'published') return skill
      const collision = [...skills.values()].find(
        (s) => s.id !== skill.id && s.status === 'published' && s.scopeId === skill.scopeId && s.name === skill.name,
      )
      if (collision) throw new Error(`skill name collision in scope ${skill.scopeId}: ${skill.name}`)
      skill.status = 'published'
      skill.updatedAt = Date.now()
      return skill
    },

    async archive(id) {
      const skill = requireSkill(id)
      if (skill.status === 'archived') return skill
      skill.status = 'archived'
      skill.updatedAt = Date.now()
      return skill
    },

    delete: async (id) => {
      skills.delete(id)
    },

    recordUse: async (id, at) => {
      const skill = requireSkill(id)
      skill.lastUsedAt = at ?? Date.now()
    },

    async resolve(name, orderedScopes) {
      return resolveFromIndex(publishedByName(orderedScopes), name)
    },

    async visibleFor(orderedScopes) {
      const byName = publishedByName(orderedScopes)
      return [...byName.keys()]
        .sort()
        .map((name) => resolveFromIndex(byName, name))
        .filter((r): r is SkillResolution & { skill: SkillRecord } => r.skill !== null)
    },
  }
}
