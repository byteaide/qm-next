/**
 * In-process SkillStore. Resolution order is deterministic: scope-chain
 * position first, then creation time, then id — mirroring the Postgres
 * twin's `ORDER BY created_at, id` plus the per-scope published-name
 * uniqueness enforced at register time.
 */
import { randomUUID } from 'node:crypto'
import type { ScopeId } from '@qm/types'
import type { SkillCreateInput, SkillRecord, SkillResolution, SkillStore } from './contract.ts'
import { assertSafeSkillName, isSafeSkillName } from './skill-name.ts'
import { createSigner, type Signer } from './manifest.ts'
import { parseScopeId } from '@qm/types'

export function createMemorySkillStore(opts: { signingSecret?: string } = {}): SkillStore {
  const skills = new Map<string, SkillRecord>()
  const signer: Signer = createSigner(opts.signingSecret)

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
      const manifest = {
        name: input.name,
        description: input.description,
        body: input.body,
        requiredCapabilities: input.requiredCapabilities ?? [],
        ...(input.files ? { files: input.files } : {}),
      }
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
        signature: signer.sign(manifest),
        ...(input.files ? { files: [...input.files] } : {}),
        ...(input.pack ? { pack: { ...input.pack } } : {}),
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

    async create(input: SkillCreateInput) {
      assertSafeSkillName(input.manifest.name)
      const conflict = [...skills.values()].find(
        (s) =>
          s.scopeId === input.scopeId &&
          s.name === input.manifest.name &&
          s.createdBy === input.createdBy &&
          s.status !== 'archived',
      )
      if (conflict) throw new Error(`skill name collision in scope ${input.scopeId}: ${input.manifest.name}`)
      const at = Date.now()
      const granted = new Set(input.grantCapabilities ?? input.manifest.requiredCapabilities)
      const skill: SkillRecord = {
        id: randomUUID(),
        scopeId: input.scopeId,
        name: input.manifest.name,
        description: input.manifest.description,
        body: input.manifest.body,
        requiredCapabilities: [...input.manifest.requiredCapabilities],
        status: 'published',
        createdBy: input.createdBy,
        version: 1,
        createdAt: at,
        updatedAt: at,
        signature: signer.sign(input.manifest),
        grantedCapabilities: [...granted],
        approvals: [input.reviewer],
        ...(input.manifest.files ? { files: [...input.manifest.files] } : {}),
        ...(input.pack ? { pack: { ...input.pack } } : {}),
      }
      skills.set(skill.id, skill)
      return skill
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
      skills.set(skill.id, structuredClone(skill))
    },

    async promote(id, targetScopeId) {
      const s = requireSkill(id)
      assertSafeSkillName(s.name)
      if (s.status !== 'published') throw new Error('only a published skill can be promoted')
      if (!s.signature || !signer.verify(
        {
          name: s.name,
          description: s.description,
          body: s.body,
          requiredCapabilities: s.requiredCapabilities,
          ...(s.files ? { files: s.files } : {}),
        },
        s.signature,
      )) throw new Error('skill signature invalid — cannot promote')
      const existing = [...skills.values()].find(
        (x) => x.status === 'published' && x.scopeId === targetScopeId && x.name === s.name,
      )
      const at = Date.now()
      const promoted: SkillRecord = {
        id: existing?.id ?? randomUUID(),
        scopeId: targetScopeId,
        name: s.name,
        description: s.description,
        body: s.body,
        requiredCapabilities: [...s.requiredCapabilities],
        status: 'published',
        createdBy: s.createdBy,
        version: (existing?.version ?? 0) + 1,
        createdAt: at,
        updatedAt: at,
        signature: s.signature,
        grantedCapabilities: [...(s.grantedCapabilities ?? [])],
        approvals: [...(s.approvals ?? [])],
        ...(s.files ? { files: [...s.files] } : {}),
        ...(s.pack ? { pack: { ...s.pack } } : {}),
      }
      skills.set(promoted.id, promoted)
      return promoted
    },

    async move(id, toScopeId) {
      const s = requireSkill(id)
      assertSafeSkillName(s.name)
      if (parseScopeId(toScopeId).kind === 'org')
        throw new Error('ceding a skill to the org goes through promote (admin-gated), not move')
      s.scopeId = toScopeId
      s.updatedAt = Date.now()
      return s
    },
  }
}
