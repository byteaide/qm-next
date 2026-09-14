/**
 * Lane-A skill-pack store: qm SkillPack records in memory. Git fetching is
 * not available in lane A, so register records the qm fetch-failure import
 * row and catalog/sync/import surface the fetch error; the pack fetcher
 * lands with the real skills integration.
 */
import { randomUUID } from 'node:crypto'

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
  kind: 'git'
  url: string
  ref: string
  syncMode: SyncMode
  trustTier: TrustTier
  config?: PackConfig
  targetScopeId: string
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
}

export class SkillPackFetchError extends Error {
  constructor(message = 'git pack fetching is not available in this deployment') {
    super(message)
  }
}

export function createMemorySkillPackStore(): SkillPackStore {
  const packs = new Map<string, SkillPack>()
  return {
    async create(input) {
      const pack: SkillPack = { ...input, id: randomUUID(), createdAt: Date.now() }
      packs.set(pack.id, pack)
      return { ...pack }
    },
    async get(id) {
      const p = packs.get(id)
      return p ? { ...p } : null
    },
    async list() {
      return [...packs.values()].map((p) => ({ ...p }))
    },
    async update(id, patch) {
      const pack = packs.get(id)
      if (!pack) throw new Error(`unknown skill pack: ${id}`)
      Object.assign(pack, patch)
      return { ...pack }
    },
    async remove(id) {
      packs.delete(id)
    },
    async recordImport(id, result) {
      const pack = packs.get(id)
      if (!pack) throw new Error(`unknown skill pack: ${id}`)
      pack.lastImport = result
    },
  }
}
