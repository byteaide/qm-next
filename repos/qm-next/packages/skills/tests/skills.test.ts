/**
 * Skills suite (14.0): SkillStore parity across the in-process and
 * Postgres implementations (name validation, publish-name collisions,
 * scope-chain shadowing, lifecycle, usage tracking) plus the index
 * renderer and resolution seam. Postgres cases skip when QM_NEXT_PG_URL
 * is unreachable; memory cases always run.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScopeId } from '@qm/types'
import type { SkillStore } from '../src/index.ts'
import {
  assertSafeSkillName,
  createMemorySkillStore,
  createPostgresSkillStore,
  isSafeSkillName,
  skillsIndex,
  wrapResolutionWithSkills,
} from '../src/index.ts'
import { SKILLS_SCHEMA_STATEMENTS } from '../src/postgres-store.ts'
import { Pool } from 'pg'

const T0 = 1_757_000_000_000
const PERSONAL: ScopeId = 'personal:u_owner'
const ORG: ScopeId = 'org:default'
const pgUrl = process.env.QM_NEXT_PG_URL

interface Harness {
  store: SkillStore
  close(): Promise<void>
}

function memoryHarness(): () => Promise<Harness> {
  return async () => ({ store: createMemorySkillStore(), close: async () => undefined })
}

async function resetSkillsTables(): Promise<boolean> {
  if (!pgUrl) return false
  const probe = new Pool({ connectionString: pgUrl, connectionTimeoutMillis: 3000 })
  try {
    await probe.query('SELECT 1')
  } catch {
    return false
  } finally {
    await probe.end().catch(() => undefined)
  }
  const { createPgPool } = await import('@qm/store')
  const pool = createPgPool(pgUrl, SKILLS_SCHEMA_STATEMENTS)
  await pool.query('SELECT 1')
  await pool.q('DROP TABLE IF EXISTS skills')
  await pool.close()
  return true
}

function pgHarness(): () => Promise<Harness> {
  return async () => {
    await resetSkillsTables()
    const store = createPostgresSkillStore(pgUrl!)
    return { store, close: async () => store.close?.() }
  }
}

function registerInput(overrides: Record<string, unknown> = {}): {
  scopeId: ScopeId
  name: string
  description: string
  body: string
  createdBy: string
  requiredCapabilities?: string[]
} {
  return {
    scopeId: ORG,
    name: `demo-skill-${Math.random().toString(36).slice(2, 8)}`,
    description: 'a demo skill',
    body: '# Demo\nStep one: wave.',
    createdBy: 'u_owner',
    ...overrides,
  }
}

async function skillStoreCases(t: import('node:test').TestContext, make: () => Promise<Harness>): Promise<void> {
  await t.test('register creates a published, resolvable skill; get and list round-trip', async () => {
    const h = await make()
    try {
      const skill = await h.store.register(registerInput({ requiredCapabilities: ['egress:http'] }))
      assert.equal(skill.status, 'published')
      assert.equal(skill.version, 1)
      assert.deepEqual(skill.requiredCapabilities, ['egress:http'])
      assert.deepEqual(await h.store.get(skill.id), skill)
      assert.ok((await h.store.list()).some((s) => s.id === skill.id))
      const resolution = await h.store.resolve(skill.name, [ORG])
      assert.equal(resolution.skill?.id, skill.id)
      assert.match(resolution.skill?.body ?? '', /Step one: wave/)
      assert.deepEqual(resolution.shadowed, [])
    } finally {
      await h.close()
    }
  })

  await t.test('names are validated and immutable through update', async () => {
    const h = await make()
    try {
      assert.equal(isSafeSkillName('ok.name-1'), true)
      assert.equal(isSafeSkillName('../evil'), false)
      assert.equal(isSafeSkillName('.hidden'), false)
      assert.equal(isSafeSkillName('ends-with-dot.'), false)
      assert.equal(isSafeSkillName('-starts-dash'), false)
      assert.throws(() => assertSafeSkillName('has space'))
      const skill = await h.store.register(registerInput())
      await assert.rejects(h.store.register(registerInput({ scopeId: skill.scopeId, name: '../evil' })), /skill name must be/)
      const updated = await h.store.update(skill.id, { body: '# Demo\nStep two: wave harder.', description: 'updated' })
      assert.equal(updated.version, 2)
      assert.equal(updated.description, 'updated')
      assert.equal(updated.name, skill.name)
      assert.match((await h.store.resolve(skill.name, [ORG])).skill?.body ?? '', /wave harder/)
      await assert.rejects(h.store.update('missing', { body: 'x' }), /unknown skill/)
    } finally {
      await h.close()
    }
  })

  await t.test('register rejects a published same-name skill in the same scope; archive frees the name', async () => {
    const h = await make()
    try {
      const input = registerInput()
      const first = await h.store.register(input)
      await assert.rejects(h.store.register(input), new RegExp(`skill name collision in scope ${ORG}`))
      await h.store.archive(first.id)
      const second = await h.store.register(input)
      assert.notEqual(second.id, first.id)
      await assert.rejects(h.store.publish(first.id), /skill name collision/)
      assert.ok((await h.store.resolve(first.name, [ORG])).skill)
    } finally {
      await h.close()
    }
  })

  await t.test('resolve walks the scope chain: nearest scope wins, broader scopes shadow', async () => {
    const h = await make()
    try {
      const org = await h.store.register(registerInput({ scopeId: ORG, name: 'shared-skill' }))
      const personal = await h.store.register(registerInput({ scopeId: PERSONAL, name: 'shared-skill' }))
      const resolved = await h.store.resolve('shared-skill', [PERSONAL, ORG])
      assert.equal(resolved.skill?.id, personal.id)
      assert.deepEqual(
        resolved.shadowed.map((s) => s.id),
        [org.id],
      )
      const orgOnly = await h.store.resolve('shared-skill', [ORG])
      assert.equal(orgOnly.skill?.id, org.id)
      assert.deepEqual(orgOnly.shadowed, [])
      assert.deepEqual(await h.store.resolve('shared-skill', ['channel:c1']), { skill: null, shadowed: [] })
      assert.deepEqual(await h.store.resolve('not-registered', [ORG]), { skill: null, shadowed: [] })
      assert.deepEqual(await h.store.resolve('../evil', [ORG]), { skill: null, shadowed: [] })
    } finally {
      await h.close()
    }
  })

  await t.test('visibleFor lists chain skills sorted by name with shadow notes', async () => {
    const h = await make()
    try {
      await h.store.register(registerInput({ scopeId: ORG, name: 'beta-skill' }))
      await h.store.register(registerInput({ scopeId: ORG, name: 'alpha-skill' }))
      await h.store.register(registerInput({ scopeId: PERSONAL, name: 'alpha-skill' }))
      await h.store.register(registerInput({ scopeId: 'channel:c1', name: 'ghost-skill' }))
      const outOfChain = await h.store.register(registerInput({ scopeId: PERSONAL, name: 'draftish' }))
      await h.store.archive(outOfChain.id)
      const visible = await h.store.visibleFor([PERSONAL, ORG])
      assert.deepEqual(
        visible.map((r) => r.skill?.name),
        ['alpha-skill', 'beta-skill'],
      )
      const alpha = visible[0]!
      assert.equal(alpha.skill?.scopeId, PERSONAL)
      assert.deepEqual(
        alpha.shadowed.map((s) => s.id),
        [await resolveId(h, 'alpha-skill', ORG)],
      )
      assert.equal((await h.store.visibleFor([ORG])).map((r) => r.skill?.name).join(','), 'alpha-skill,beta-skill')
    } finally {
      await h.close()
    }
  })

  await t.test('publish/archive lifecycle and recordUse tracking', async () => {
    const h = await make()
    try {
      const skill = await h.store.register(registerInput())
      await h.store.archive(skill.id)
      assert.deepEqual(await h.store.resolve(skill.name, [ORG]), { skill: null, shadowed: [] })
      const again = await h.store.archive(skill.id)
      assert.equal(again.status, 'archived')
      const republished = await h.store.publish(skill.id)
      assert.equal(republished.status, 'published')
      assert.equal((await h.store.resolve(skill.name, [ORG])).skill?.id, skill.id)
      await h.store.recordUse(skill.id, T0)
      assert.equal((await h.store.get(skill.id))?.lastUsedAt, T0)
      await h.store.delete(skill.id)
      assert.equal(await h.store.get(skill.id), null)
      await assert.rejects(h.store.recordUse('missing'), /unknown skill/)
    } finally {
      await h.close()
    }
  })
}

async function resolveId(h: Harness, name: string, scope: ScopeId): Promise<string> {
  const r = await h.store.resolve(name, [scope])
  return r.skill?.id ?? ''
}

test('skill store (in-process)', async (t) => {
  await skillStoreCases(t, memoryHarness())
})

if (pgUrl) {
  const pgReady = await resetSkillsTables()
  if (pgReady) {
    test('skill store (postgres parity)', async (t) => {
      await skillStoreCases(t, pgHarness())
    })
  } else {
    test('skill store (postgres parity) — server unreachable, skipped', async () => {
      assert.equal(pgReady, false)
    })
  }
}

test('postgres skill parity: identical registrations converge to identical resolutions', async (t) => {
  if (!pgUrl || !(await resetSkillsTables())) return t.skip('QM_NEXT_PG_URL not reachable')
  const mem = createMemorySkillStore()
  const pg = createPostgresSkillStore(pgUrl!)
  try {
    const shared = { name: 'parity-skill', description: 'parity', body: '# Parity\nDo it twice.', createdBy: 'u' }
    const memSkill = await mem.register({ ...shared, scopeId: ORG })
    const pgSkill = await pg.register({ ...shared, scopeId: ORG })
    for (const store of [mem, pg]) {
      await store.register({ ...shared, name: 'parity-outer', scopeId: 'personal:u1' })
    }
    const chain = ['personal:u1', ORG] as ScopeId[]
    for (const name of ['parity-skill', 'parity-outer', 'missing']) {
      const a = await mem.resolve(name, chain)
      const b = await pg.resolve(name, chain)
      assert.equal(b.skill?.name, a.skill?.name)
      assert.equal(b.skill === null, a.skill === null)
      assert.equal(b.shadowed.length, a.shadowed.length)
      if (a.skill) {
        assert.equal(b.skill!.body, a.skill!.body)
        assert.equal(b.skill!.status, a.skill!.status)
      }
    }
    const memVisible = await mem.visibleFor(chain)
    const pgVisible = await pg.visibleFor(chain)
    assert.deepEqual(
      pgVisible.map((r) => [r.skill!.name, r.shadowed.length]),
      memVisible.map((r) => [r.skill!.name, r.shadowed.length]),
    )
    await assert.rejects(pg.register({ ...shared, scopeId: ORG }), /skill name collision/)
    await assert.rejects(mem.register({ ...shared, scopeId: ORG }), /skill name collision/)
    assert.equal(pgSkill.status, memSkill.status)
  } finally {
    await pg.close?.()
  }
})

test('skills index renders sorted entries with shadow notes', () => {
  assert.equal(skillsIndex([]), '')
  const rendered = skillsIndex([
    {
      skill: {
        id: '1', scopeId: ORG, name: 'zeta-skill', description: 'last', body: '', requiredCapabilities: [],
        status: 'published', createdBy: 'u', version: 1, createdAt: T0, updatedAt: T0,
      },
      shadowed: [],
    },
    {
      skill: {
        id: '2', scopeId: PERSONAL, name: 'alpha-skill', description: 'first', body: '', requiredCapabilities: [],
        status: 'published', createdBy: 'u', version: 1, createdAt: T0, updatedAt: T0,
      },
      shadowed: [
        {
          id: '3', scopeId: ORG, name: 'alpha-skill', description: 'first', body: '', requiredCapabilities: [],
          status: 'published', createdBy: 'u', version: 1, createdAt: T0, updatedAt: T0,
        },
      ],
    },
  ])
  const lines = rendered.split('\n')
  assert.equal(lines[0], '## Skills')
  assert.match(lines[2]!, /- \*\*alpha-skill\*\* — first \(shadows a broader-scope skill of the same name\)$/)
  assert.match(lines[3]!, /- \*\*zeta-skill\*\* — last$/)
})

test('resolution seam lists registered skills in the harness input context and fails open', async (t) => {
  const inner = {
    resolve: async () => ({ systemPrompt: 'base prompt', orgScopeId: ORG }),
    scopeFor: () => ORG,
  }
  const conversation = { kind: 'dm' as const, threadRef: 't', audience: [] }
  const actor = { id: 'u1', type: 'internal' as const }

  await t.test('a registered skill appears in the system prompt', async () => {
    const store = createMemorySkillStore()
    await store.register(registerInput({ scopeId: ORG, name: 'onboarding' }))
    const wrapped = wrapResolutionWithSkills(inner, store, () => [PERSONAL, ORG])
    const result = await wrapped.resolve(conversation, actor)
    assert.match(result.systemPrompt, /^base prompt\n\n## Skills\n/)
    assert.match(result.systemPrompt, /- \*\*onboarding\*\* — a demo skill/)
  })

  await t.test('empty registry and absent selection leave the prompt untouched', async () => {
    const store = createMemorySkillStore()
    const wrapped = wrapResolutionWithSkills(inner, store, () => [ORG])
    assert.equal((await wrapped.resolve(conversation, actor)).systemPrompt, 'base prompt')
    const off = wrapResolutionWithSkills(inner, store, () => undefined)
    assert.equal((await off.resolve(conversation, actor)).systemPrompt, 'base prompt')
  })

  await t.test('a broken store skips the index instead of failing the turn', async () => {
    const broken = createMemorySkillStore()
    ;(broken as { visibleFor: unknown }).visibleFor = async () => {
      throw new Error('storage down')
    }
    const wrapped = wrapResolutionWithSkills(inner, broken, () => [ORG])
    assert.equal((await wrapped.resolve(conversation, actor)).systemPrompt, 'base prompt')
  })
})
