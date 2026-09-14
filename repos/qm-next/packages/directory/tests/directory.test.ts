/**
 * Directory parity suite: the same behavioral cases run against the
 * in-memory and Postgres implementations of the frozen DirectoryStore
 * contract. Postgres cases activate when QM_NEXT_PG_URL points at a
 * reachable server; otherwise they skip (memory cases always run).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DirectorySyncPush } from '@qm/im-core'
import type { PrincipalType } from '@qm/types'
import {
  isVisible,
  normDirectoryQuery,
  pickMatch,
  principalIdFor,
  samePerson,
  samePersonInDirectory,
  samePersonMatcher,
  type DirectoryPersonLookup,
  type DirectoryStore,
} from '../src/index.ts'
import { createMemoryDirectoryStore } from '../src/memory-directory-store.ts'
import { DIRECTORY_SCHEMA_STATEMENTS, createPostgresDirectoryStore } from '../src/postgres-directory-store.ts'
import { Pool } from 'pg'

const pgUrl = process.env.QM_NEXT_PG_URL

function push(overrides: Partial<DirectorySyncPush> = {}): DirectorySyncPush {
  return {
    provider: 'feishu',
    instanceId: 'test',
    syncedAt: 1_000,
    ...overrides,
  }
}

function personPush(overrides: Partial<DirectorySyncPush> = {}): DirectorySyncPush {
  return push({
    people: [
      { providerUserId: 'u1', displayName: 'Ada Lovelace', type: 'internal' as PrincipalType },
      { providerUserId: 'u2', displayName: 'Ada Palmer', type: 'internal' as PrincipalType },
      { providerUserId: 'u3', displayName: 'Grace Hopper', type: 'internal' as PrincipalType, email: 'grace@example.com' },
      { providerUserId: 'ubot', displayName: 'Notifier', type: 'guest' as PrincipalType },
    ],
    ...overrides,
  })
}

function spacePush(overrides: Partial<DirectorySyncPush> = {}): DirectorySyncPush {
  return push({
    spaces: [
      { spaceId: 'oc_pub', name: 'general', kind: 'channel' as const },
      { spaceId: 'oc_priv', name: 'secret-plan', kind: 'channel' as const, isPrivate: true },
      { spaceId: 'oc_ext', name: 'partners', kind: 'channel' as const, isPrivate: true, isExternal: true },
      { spaceId: 'oc_g1', name: 'Ada & Grace', kind: 'group' as const },
      { spaceId: 'oc_pa', name: 'project-alpha', kind: 'channel' as const },
      { spaceId: 'oc_pb', name: 'project-beta', kind: 'channel' as const },
    ],
    spaceMembers: [
      { spaceId: 'oc_pub', providerUserId: 'u1' },
      { spaceId: 'oc_priv', providerUserId: 'u1' },
      { spaceId: 'oc_g1', providerUserId: 'u1' },
      { spaceId: 'oc_g1', providerUserId: 'u3' },
    ],
    ...overrides,
  })
}

interface Harness {
  store: DirectoryStore
  close(): Promise<void>
}

async function resetDirectoryTables(): Promise<boolean> {
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
  const pool = createPgPool(pgUrl, DIRECTORY_SCHEMA_STATEMENTS)
  await pool.query('SELECT 1')
  for (const table of ['directory_people', 'directory_spaces', 'directory_space_members', 'directory_rosters', 'directory_sync_state']) {
    await pool.q(`DELETE FROM ${table}`)
  }
  await pool.close()
  return true
}

function pgHarness(): () => Promise<Harness> {
  return async () => {
    await resetDirectoryTables()
    const store = createPostgresDirectoryStore(pgUrl!)
    return { store, close: async () => store.close?.() }
  }
}

function memoryHarness(): () => Promise<Harness> {
  return async () => ({ store: createMemoryDirectoryStore(), close: async () => undefined })
}

async function directoryStoreCases(t: import('node:test').TestContext, make: () => Promise<Harness>): Promise<void> {
  await t.test('apply upserts people with provider-scoped principal ids', async () => {
    const h = await make()
    try {
      assert.equal(await h.store.apply(personPush()), true)
      const ada = await h.store.getPerson('feishu', 'u1')
      assert.ok(ada)
      assert.equal(ada.principalId, 'feishu:u1')
      assert.equal(ada.displayName, 'Ada Lovelace')
      assert.equal(ada.type, 'internal')
      const grace = await h.store.getPerson('feishu', 'u3')
      assert.ok(grace)
      assert.equal(grace.email, 'grace@example.com')
      assert.equal(await h.store.getPerson('feishu', 'missing'), null)
      assert.equal(await h.store.getPerson('slack', 'u1'), null)
    } finally {
      await h.close()
    }
  })

  await t.test('apply upserts spaces and members; roster known only after a replace push', async () => {
    const h = await make()
    try {
      await h.store.apply(spacePush({ spaceMembers: [{ spaceId: 'oc_pub', providerUserId: 'u1' }] }))
      assert.equal(await h.store.spaceMember('feishu', 'oc_pub', 'u1'), true)
      assert.equal(await h.store.spaceMember('feishu', 'oc_pub', 'u2'), false)
      assert.equal(await h.store.spaceMemberIds('feishu', 'oc_pub'), undefined, 'partial push leaves roster unknown')

      await h.store.apply(spacePush({ replace: ['spaceMembers'] }))
      assert.deepEqual((await h.store.spaceMemberIds('feishu', 'oc_priv'))?.sort(), ['u1'])
      assert.deepEqual(await h.store.spaceMemberIds('feishu', 'oc_pub'), ['u1'])
      assert.equal((await h.store.spaceMemberIds('feishu', 'oc_g1'))?.length, 2)
    } finally {
      await h.close()
    }
  })

  await t.test('replace revokes memberships absent from the push', async () => {
    const h = await make()
    try {
      await h.store.apply(spacePush({ replace: ['spaceMembers'] }))
      assert.equal(await h.store.spaceMember('feishu', 'oc_g1', 'u3'), true)
      await h.store.apply(
        spacePush({
          replace: ['spaceMembers'],
          spaceMembers: [{ spaceId: 'oc_g1', providerUserId: 'u1' }],
        }),
      )
      assert.equal(await h.store.spaceMember('feishu', 'oc_g1', 'u3'), false, 'u3 was revoked')
      assert.equal(await h.store.spaceMember('feishu', 'oc_g1', 'u1'), true)
    } finally {
      await h.close()
    }
  })

  await t.test('a stale push is refused section-wise without clobbering fresh state', async () => {
    const h = await make()
    try {
      assert.equal(await h.store.apply(personPush({ syncedAt: 2_000 })), true)
      assert.equal(await h.store.apply(personPush({ syncedAt: 1_000, people: [{ providerUserId: 'old', type: 'internal' as PrincipalType }] })), false)
      assert.equal(await h.store.getPerson('feishu', 'old'), null, 'stale push wrote nothing')
      assert.ok(await h.store.getPerson('feishu', 'u1'))
      // a newer section still applies even when another section is stale-guarded
      assert.equal(await h.store.apply(spacePush({ syncedAt: 3_000 })), true)
    } finally {
      await h.close()
    }
  })

  await t.test('resolvePerson matches id, exact name, prefix and substring; ties are ambiguous', async () => {
    const h = await make()
    try {
      await h.store.apply(personPush())
      const byId = await h.store.resolvePerson('feishu', 'u3')
      assert.ok(byId.kind === 'one' && byId.person.providerUserId === 'u3')
      const exact = await h.store.resolvePerson('feishu', '@grace hopper')
      assert.ok(exact.kind === 'one' && exact.person.providerUserId === 'u3')
      const ambiguous = await h.store.resolvePerson('feishu', 'ada')
      assert.ok(ambiguous.kind === 'ambiguous' && ambiguous.candidates.length === 2)
      const none = await h.store.resolvePerson('feishu', 'nobody')
      assert.deepEqual(none, { kind: 'none' })
      const guest = await h.store.resolvePerson('feishu', 'notifier')
      assert.ok(guest.kind === 'one', 'guests stay in the directory; consumers filter by type')
    } finally {
      await h.close()
    }
  })

  await t.test('resolveSpace matches name and id; visibility filters private/external for non-members', async () => {
    const h = await make()
    try {
      await h.store.apply(personPush())
      await h.store.apply(spacePush({ replace: ['spaceMembers'] }))
      const byName = await h.store.resolveSpace('feishu', '#secret-plan')
      assert.ok(byName.kind === 'one' && byName.space.spaceId === 'oc_priv')
      const amb = await h.store.resolveSpace('feishu', 'project')
      assert.ok(amb.kind === 'ambiguous' && amb.candidates.length === 2)

      const priv = await h.store.getSpace('feishu', 'oc_priv')
      assert.ok(priv)
      assert.equal(await isVisible(h.store, 'feishu', 'u1', priv), true, 'member sees the private channel')
      assert.equal(await isVisible(h.store, 'feishu', 'u2', priv), false, 'non-member cannot see the private channel')
      const pub = await h.store.getSpace('feishu', 'oc_pub')
      assert.ok(pub)
      assert.equal(await isVisible(h.store, 'feishu', 'u2', pub), true, 'public channels are visible to everyone')

      const visibleU2 = (await h.store.listVisibleSpaces('feishu', 'u2')).map((s) => s.spaceId).sort()
      assert.deepEqual(visibleU2, ['oc_pa', 'oc_pb', 'oc_pub'], 'external and private spaces are filtered out for u2')
      const visibleU1 = (await h.store.listVisibleSpaces('feishu', 'u1')).map((s) => s.spaceId).sort()
      assert.deepEqual(visibleU1, ['oc_g1', 'oc_pa', 'oc_pb', 'oc_priv', 'oc_pub'])
    } finally {
      await h.close()
    }
  })

  await t.test('resolveGroupByParticipants matches the exact member set', async () => {
    const h = await make()
    try {
      await h.store.apply(spacePush({ replace: ['spaceMembers'] }))
      const hit = await h.store.resolveGroupByParticipants('feishu', ['u3', 'u1'])
      assert.ok(hit.kind === 'one' && hit.space.spaceId === 'oc_g1')
      const miss = await h.store.resolveGroupByParticipants('feishu', ['u1'])
      assert.deepEqual(miss, { kind: 'none' })
    } finally {
      await h.close()
    }
  })

  await t.test('replace revokes people and spaces absent from the push', async () => {
    const h = await make()
    try {
      await h.store.apply(personPush())
      await h.store.apply(spacePush())
      await h.store.apply(
        personPush({
          syncedAt: 2_000,
          replace: ['people'],
          people: [{ providerUserId: 'u1', displayName: 'Ada Lovelace', type: 'internal' as PrincipalType }],
        }),
      )
      assert.ok(await h.store.getPerson('feishu', 'u1'))
      assert.equal(await h.store.getPerson('feishu', 'u2'), null, 'revoked person is gone')
      await h.store.apply(
        spacePush({
          syncedAt: 2_000,
          replace: ['spaces', 'spaceMembers'],
          spaces: [{ spaceId: 'oc_pub', name: 'general', kind: 'channel' as const }],
          spaceMembers: [{ spaceId: 'oc_pub', providerUserId: 'u1' }],
        }),
      )
      assert.equal(await h.store.getSpace('feishu', 'oc_priv'), null, 'revoked space is gone')
      assert.equal(await h.store.getSpace('feishu', 'oc_g1'), null)
      assert.ok(await h.store.getSpace('feishu', 'oc_pub'))
    } finally {
      await h.close()
    }
  })
}

test('directory store: memory implementation', async (t) => {
  await directoryStoreCases(t, memoryHarness())
})

test('directory store: postgres implementation', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  if (!(await resetDirectoryTables())) return t.skip('postgres unreachable at QM_NEXT_PG_URL')
  await directoryStoreCases(t, pgHarness())
})

test('directory roster state survives a restart on postgres', { skip: pgUrl ? false : 'QM_NEXT_PG_URL not set' }, async (t) => {
  if (!(await resetDirectoryTables())) return t.skip('postgres unreachable at QM_NEXT_PG_URL')
  const first = createPostgresDirectoryStore(pgUrl!)
  await first.apply(personPush())
  await first.apply(spacePush({ replace: ['spaceMembers'] }))
  await first.close?.()
  const restarted = createPostgresDirectoryStore(pgUrl!)
  try {
    assert.ok(await restarted.getPerson('feishu', 'u1'))
    const ids = await restarted.spaceMemberIds('feishu', 'oc_g1')
    assert.deepEqual(ids?.sort(), ['u1', 'u3'])
  } finally {
    await restarted.close?.()
  }
})

test('directory query helpers', () => {
  assert.equal(normDirectoryQuery('  @Ada L '), 'ada l')
  assert.equal(normDirectoryQuery('#general'), 'general')
  const items = [
    { id: 'u1', name: 'Ada Lovelace' },
    { id: 'u2', name: 'Ada Palmer' },
  ]
  const ambiguous = pickMatch(items, 'ada', (i) => i.id, (i) => i.name)
  assert.equal(ambiguous.kind, 'ambiguous')
  const exact = pickMatch(items, 'ada palmer', (i) => i.id, (i) => i.name)
  assert.ok(exact.kind === 'one' && exact.item.id === 'u2')
  const prefix = pickMatch([items[0]!], 'ada', (i) => i.id, (i) => i.name)
  assert.ok(prefix.kind === 'one')
  assert.equal(principalIdFor('feishu', 'u1'), 'feishu:u1')
})

test('person identity matching', async () => {
  assert.equal(samePerson('Ada@Example.com', 'ada@example.com'), true)
  assert.equal(samePerson('u1', 'u1'), true)
  assert.equal(samePerson('u1', 'u2'), false)
  assert.equal(samePerson('', ''), false)

  const lookup: DirectoryPersonLookup = {
    listPeople: async () => [
      {
        provider: 'feishu',
        providerUserId: 'u1',
        principalId: 'feishu:u1',
        email: 'ada@example.com',
        type: 'internal' as PrincipalType,
      },
    ],
  }
  assert.equal(await samePersonInDirectory(lookup, 'feishu', 'feishu:u1', 'ada@example.com'), true)
  assert.equal(await samePersonInDirectory(lookup, 'feishu', 'feishu:u1', 'feishu:u2'), false)

  const matcher = await samePersonMatcher(lookup, 'feishu', 'feishu:u1')
  assert.equal(await matcher('ada@example.com'), true)
  assert.equal(await matcher('feishu:u9'), false)

  const unknownActor = await samePersonMatcher(
    { listPeople: async () => [] },
    'feishu',
    'feishu:ghost',
  )
  assert.equal(await unknownActor('feishu:ghost'), true)
})
