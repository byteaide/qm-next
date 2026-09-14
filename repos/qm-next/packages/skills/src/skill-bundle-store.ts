/**
 * Skill bundle store, ported from qm's `skill-bundle-store.ts`: memory and
 * Postgres implementations of `SkillBundleStore`. Bundles are shared files
 * imported alongside a skill and materialized under `skills/.packs/`.
 */
import { createHash } from 'node:crypto'
import { createMemoryMap, createPgPool, createPostgresMap, type DurableMap, type PgPool } from '@qm/store'
import type { SkillFile } from './contract.ts'

export interface SkillBundle {
  packId: string
  commit: string
  files: SkillFile[]
  hash: string
}

export function computeBundleHash(files: SkillFile[]): string {
  const h = createHash('sha256')
  for (const e of [...files].map((f) => `${f.path}\0${f.content}`).sort()) {
    h.update(e)
    h.update('\n')
  }
  return h.digest('hex')
}

export interface SkillBundleStore {
  get(packId: string): Promise<SkillBundle | null>
  put(bundle: SkillBundle): Promise<void>
  delete(packId: string): Promise<void>
  list(): Promise<SkillBundle[]>
  close?(): Promise<void>
}

export function createMemorySkillBundleStore(): SkillBundleStore {
  const bundles = createMemoryMap<SkillBundle>()
  return {
    get: async (packId) => (await bundles.get(packId)) ?? null,
    async put(bundle) {
      await bundles.put(bundle.packId, bundle)
    },
    delete: async (packId) => {
      await bundles.delete(packId)
    },
    list: async () => await bundles.all(),
  }
}

const SKILL_BUNDLES_TABLE = 'skill_bundles'

export function createPostgresSkillBundleStore(connectionString: string): SkillBundleStore {
  const pool: PgPool = createPgPool(connectionString, [])
  const bundles: DurableMap<SkillBundle> = createPostgresMap<SkillBundle>(pool, SKILL_BUNDLES_TABLE)
  return {
    get: async (packId) => (await bundles.get(packId)) ?? null,
    async put(bundle) {
      await bundles.put(bundle.packId, bundle)
    },
    delete: async (packId) => {
      await bundles.delete(packId)
    },
    list: async () => await bundles.all(),
    close: () => pool.close(),
  }
}
