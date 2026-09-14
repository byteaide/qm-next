/**
 * Skill pack registry, ported from qm's `skill-pack-store.ts`: memory and
 * Postgres implementations backed by `@qm/store`'s DurableMap. Each pack
 * has a stable id, points at a git ref, and tracks the last import
 * attempt for the sync engine.
 */
import { randomUUID } from 'node:crypto'
import { createMemoryMap, createPgPool, createPostgresMap, type DurableMap, type PgPool } from '@qm/store'
import type { ScopeId } from '@qm/types'

export type PackKind = 'git'
export type SyncMode = 'pinned' | 'tracked'
export type TrustTier = 'internal' | 'third-party'

export interface PackConfig {
  skillGlobs?: string[]
  exclude?: string[]
  fieldOverrides?: Record<string, string>
}

export interface ImportRecord {
  at: number
  commit: string
  status: 'ok' | 'error'
  error?: string
  counts?: Record<string, number>
}

export interface SkillPack {
  id: string
  kind: PackKind
  url: string
  ref: string
  syncMode: SyncMode
  trustTier: TrustTier
  config?: PackConfig
  targetScopeId: ScopeId
  subset: 'all' | string[]
  authCredentialSlug?: string
  createdBy: string
  createdAt: number
  lastImport?: ImportRecord
  updateAvailable?: boolean
  available?: number
}

export type NewSkillPack = Omit<SkillPack, 'id' | 'createdAt' | 'lastImport'>

export interface SkillPackStore {
  create(input: NewSkillPack): Promise<SkillPack>
  get(id: string): Promise<SkillPack | null>
  list(): Promise<SkillPack[]>
  update(id: string, patch: Partial<Omit<SkillPack, 'id' | 'createdAt'>>): Promise<SkillPack>
  remove(id: string): Promise<void>
  recordImport(id: string, result: ImportRecord): Promise<void>
  close?(): Promise<void>
}

export function createMemorySkillPackStore(): SkillPackStore {
  const packs = createMemoryMap<SkillPack>()
  const now = () => Date.now()
  return {
    async create(input) {
      const pack: SkillPack = { ...input, id: randomUUID(), createdAt: now() }
      await packs.put(pack.id, pack)
      return { ...pack }
    },
    get: async (id) => (await packs.get(id)) ?? null,
    list: async () => await packs.all(),
    async update(id, patch) {
      const merged = await packs.merge(id, patch)
      if (!merged) throw new Error(`unknown skill pack: ${id}`)
      return { ...merged }
    },
    remove: async (id) => {
      await packs.delete(id)
    },
    async recordImport(id, result) {
      await packs.merge(id, { lastImport: result })
    },
  }
}

const SKILL_PACKS_TABLE = 'skill_packs'

export function createPostgresSkillPackStore(connectionString: string): SkillPackStore {
  const pool: PgPool = createPgPool(connectionString, [])
  const packs: DurableMap<SkillPack> = createPostgresMap<SkillPack>(pool, SKILL_PACKS_TABLE)
  return {
    create: async (input) => {
      const pack: SkillPack = { ...input, id: randomUUID(), createdAt: Date.now() }
      await packs.put(pack.id, pack)
      return { ...pack }
    },
    get: async (id) => (await packs.get(id)) ?? null,
    list: async () => await packs.all(),
    async update(id, patch) {
      const merged = await packs.merge(id, patch)
      if (!merged) throw new Error(`unknown skill pack: ${id}`)
      return { ...merged }
    },
    remove: async (id) => {
      await packs.delete(id)
    },
    async recordImport(id, result) {
      await packs.merge(id, { lastImport: result })
    },
    close: () => pool.close(),
  }
}
