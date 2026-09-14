/**
 * Pack sync engine + planIngest + importPack (parity 15.0): tick calls
 * under a leader lease, tracked mode reconciles on new head, pinned mode
 * flips `updateAvailable` only.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScopeId } from '@qm/types'
import {
  createMemoryLeaderLease,
} from '@qm/triggers'
import {
  createMemorySkillPackStore,
  createMemorySkillStore,
  createSkillSyncEngine,
  importPack,
  planIngest,
  upsertSeedSkill,
  type FetchedRepo,
  type SkillPack,
  type SkillPackFetcher,
  type SkillPackStore,
  type SkillStore,
} from '../src/index.ts'

const ORG = 'org:acme' as ScopeId

const basePack = (overrides: Partial<SkillPack> = {}): SkillPack => ({
  id: 'pack-x',
  kind: 'git',
  url: 'https://example.com/repo.git',
  ref: 'main',
  syncMode: 'pinned',
  trustTier: 'third-party',
  targetScopeId: ORG,
  subset: 'all',
  createdBy: 'person:ada',
  createdAt: 1_000,
  ...overrides,
})

function file(path: string, text: string) {
  return { path, text, binary: false }
}

function fakeFetcher(map: Map<string, string>): SkillPackFetcher {
  return {
    async fetch(pack) {
      const commit = map.get(pack.id) ?? 'c0'
      return {
        commit,
        files: [
          file('alpha/SKILL.md', `---\nname: alpha\ndescription: ok\n---\nbody for ${pack.id}@${commit}`),
        ],
      }
    },
    async resolveRef(pack) {
      return map.get(pack.id) ?? 'c0'
    },
  }
}

test('tracked mode reconciles when the head changes; pinned mode flips updateAvailable only', async () => {
  const packs: SkillPackStore = createMemorySkillPackStore()
  const skills: SkillStore = createMemorySkillStore()
  const heads = new Map<string, string>([['pack-a', 'c1'], ['pack-b', 'c1']])
  const fetcher = fakeFetcher(heads)
  const tracked = await packs.create(basePack({ id: 'pack-a', syncMode: 'tracked' }))
  const pinned = await packs.create(basePack({ id: 'pack-b', syncMode: 'pinned' }))
  // Seed the pinned pack with a prior successful import so the second
  // tick has something to compare the head against.
  await packs.recordImport(pinned.id, { at: 1, commit: 'c0', status: 'ok' })

  const reconcileCalls: string[] = []
  const engine = createSkillSyncEngine({
    packs,
    fetcher,
    leaderLease: createMemoryLeaderLease(),
    reconcile: async (packId) => {
      reconcileCalls.push(packId)
      const pack = await packs.get(packId)
      if (!pack) return
      const repo = await fetcher.fetch(pack)
      await importPack(repo, skills, {
        pack,
        selected: 'all',
        nativeNames: new Set(),
      })
      await packs.recordImport(packId, { at: Date.now(), commit: repo.commit, status: 'ok' })
    },
  })
  await engine.tick()
  assert.deepEqual(reconcileCalls, [tracked.id], 'tracked pack reconciles; pinned does not')
  assert.equal((await packs.get(pinned.id))?.updateAvailable, undefined, 'pinned does not flip before the head moves')

  // A second tick with the same head: no extra reconcile.
  await engine.tick()
  assert.equal(reconcileCalls.length, 1)

  // Move the head: tracked reconciles again, pinned flips updateAvailable.
  heads.set(tracked.id, 'c2')
  heads.set(pinned.id, 'c2')
  await engine.tick()
  assert.equal(reconcileCalls.length, 2)
  assert.equal((await packs.get(pinned.id))?.updateAvailable, true)
})

test('planIngest: scoped globs filter skills; pack config field overrides copy attrs', () => {
  const r: FetchedRepo = {
    commit: 'c1',
    files: [
      file('group/alpha/SKILL.md', '---\nname: alpha\n---\nbody'),
      file('other/beta/SKILL.md', '---\nname: beta\n---\nbody'),
    ],
  }
  const plan = planIngest(r, {
    config: { skillGlobs: ['group/*'], exclude: [] },
    nativeNames: new Set(),
  })
  assert.equal(plan.counts.total, 1)
  assert.equal(plan.counts.eligible, 1)
})

test('upsertSeedSkill: detects foreign-scope collisions and skips', async () => {
  const store = createMemorySkillStore()
  await store.register({ scopeId: ORG, name: 'alpha', description: 'mine', body: 'a', createdBy: 'person:ada' })
  // Different createdBy in the same scope: foreign collision → "foreign" (skipped).
  const outcome = await upsertSeedSkill(store, {
    scopeId: ORG,
    manifest: { name: 'alpha', description: 'yours', body: 'b', requiredCapabilities: [] },
    createdBy: 'person:mallory',
    reviewer: 'person:boss',
  })
  assert.equal(outcome, 'foreign')
})
