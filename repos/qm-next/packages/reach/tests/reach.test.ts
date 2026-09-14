/**
 * Reach resolution suite: recipient / channel / group targets resolved
 * against the memory DirectoryStore (structural ReachDirectory slice) —
 * provider sync push → store → resolve → Destination, with member checks
 * and visibility filtering.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PrincipalType } from '@qm/types'
import { createMemoryDirectoryStore, type DirectoryStore } from '@qm/directory'
import { reachDirectory, resolveReachTarget } from '../src/index.ts'

const PROVIDER = 'feishu'

async function seededStore(): Promise<DirectoryStore> {
  const store = createMemoryDirectoryStore()
  await store.apply({
    provider: PROVIDER,
    instanceId: 'test',
    syncedAt: 1_000,
    people: [
      { providerUserId: 'u1', displayName: 'Ada Lovelace', type: 'internal' as PrincipalType },
      { providerUserId: 'u2', displayName: 'Grace Hopper', type: 'internal' as PrincipalType },
      { providerUserId: 'u3', displayName: 'Ada Palmer', type: 'internal' as PrincipalType },
    ],
    spaces: [
      { spaceId: 'oc_pub', name: 'general', kind: 'channel' },
      { spaceId: 'oc_priv', name: 'warroom', kind: 'channel', isPrivate: true },
      { spaceId: 'oc_g1', name: 'Ada & Grace', kind: 'group' },
    ],
    spaceMembers: [
      { spaceId: 'oc_pub', providerUserId: 'u1' },
      { spaceId: 'oc_priv', providerUserId: 'u2' },
      { spaceId: 'oc_g1', providerUserId: 'u1' },
      { spaceId: 'oc_g1', providerUserId: 'u2' },
    ],
    replace: ['spaceMembers'],
  })
  return store
}

test('a synced push lets "@name" resolve to a principal destination', async () => {
  const store = await seededStore()
  const result = await resolveReachTarget(reachDirectory(store), PROVIDER, { recipient: '@grace hopper' }, 'u1')
  assert.ok(result.ok)
  assert.deepEqual(result.destination, {
    type: 'principal',
    target: 'feishu:u2',
    audienceScopeId: 'personal:feishu:u2',
    onBehalfOf: 'feishu:u1',
  })
  assert.deepEqual(result.recipient, { principalId: 'feishu:u2', displayName: 'Grace Hopper' })
})

test('recipient queries report ambiguity and misses', async () => {
  const store = await seededStore()
  const ambiguous = await resolveReachTarget(reachDirectory(store), PROVIDER, { recipient: 'ada' }, 'u1')
  assert.ok(!ambiguous.ok)
  assert.equal(ambiguous.status, 409)
  assert.equal(ambiguous.error, 'ambiguous_recipient')
  assert.equal(ambiguous.candidates?.length, 2)
  const missing = await resolveReachTarget(reachDirectory(store), PROVIDER, { recipient: 'nobody' }, 'u1')
  assert.ok(!missing.ok)
  assert.equal(missing.status, 404)
})

test('channel targets resolve to provider destinations with visibility enforcement', async () => {
  const dir = reachDirectory(await seededStore())
  const member = await resolveReachTarget(dir, PROVIDER, { channel: 'warroom' }, 'u2')
  assert.ok(member.ok)
  assert.deepEqual(member.destination, {
    type: PROVIDER,
    target: 'oc_priv',
    audienceScopeId: `channel:${PROVIDER}:oc_priv`,
  })
  assert.deepEqual(member.channel, { spaceId: 'oc_priv', name: 'warroom' })

  const outsider = await resolveReachTarget(dir, PROVIDER, { channel: 'warroom' }, 'u1')
  assert.ok(!outsider.ok)
  assert.equal(outsider.status, 403)
  assert.equal(outsider.error, 'not_a_member')

  const unknownUser = await resolveReachTarget(dir, PROVIDER, { channel: 'warroom' }, 'ghost')
  assert.ok(!unknownUser.ok)
  assert.equal(unknownUser.error, 'identity_unverified')

  const publicChannel = await resolveReachTarget(dir, PROVIDER, { channel: '#general' }, 'u2')
  assert.ok(publicChannel.ok, 'public channels are visible to everyone')
})

test('group targets resolve by exact participant set and check membership', async () => {
  const dir = reachDirectory(await seededStore())
  const known = await resolveReachTarget(dir, PROVIDER, { participants: ['@grace hopper'] }, 'u1')
  assert.ok(known.ok)
  assert.deepEqual(known.destination, {
    type: PROVIDER,
    target: 'oc_g1',
    audienceScopeId: `group:${PROVIDER}:oc_g1`,
  })
  assert.deepEqual(known.group, { spaceId: 'oc_g1', name: 'Ada & Grace' })

  const unmatched = await resolveReachTarget(dir, PROVIDER, { participants: ['ada palmer'] }, 'u1')
  assert.ok(!unmatched.ok)
  assert.equal(unmatched.status, 404)
  assert.equal(unmatched.error, 'group_not_found')

  const tooLarge = await resolveReachTarget(
    dir,
    PROVIDER,
    { participants: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] },
    'u1',
  )
  assert.ok(!tooLarge.ok)
  assert.equal(tooLarge.error, 'group_too_large')

  const empty = await resolveReachTarget(dir, PROVIDER, { participants: [] }, 'u1')
  assert.ok(!empty.ok)
  assert.equal(empty.error, 'bad_request')
})

test('reach refuses targets that specify more than one field', async () => {
  const dir = reachDirectory(await seededStore())
  const result = await resolveReachTarget(dir, PROVIDER, { recipient: 'ada', channel: 'general' }, 'u1')
  assert.ok(!result.ok)
  assert.equal(result.status, 400)
  assert.equal(result.error, 'bad_request')
})

test('a group needs someone besides the actor', async () => {
  const dir = reachDirectory(await seededStore())
  const solo = await resolveReachTarget(dir, PROVIDER, { participants: ['@ada lovelace'] }, 'u1')
  assert.ok(!solo.ok)
  assert.equal(solo.status, 400)
  assert.equal(solo.error, 'bad_request')
})

function withOpenGroup(
  dir: ReturnType<typeof reachDirectory>,
  impl: (participants: readonly string[]) => Promise<{ spaceId: string } | { error: string } | null>,
  registered?: { spaceId: string; participants: string[] }[],
) {
  return {
    ...dir,
    openGroup: (_provider: string, participants: readonly string[]) => impl(participants),
    registerGroup: async (_provider: string, spaceId: string, participants: readonly string[]) => {
      registered?.push({ spaceId, participants: [...participants] })
    },
  }
}

test('openGroup write-back opens, registers, and resolves the group', async () => {
  const store = await seededStore()
  const registered: { spaceId: string; participants: string[] }[] = []
  const dir = withOpenGroup(
    reachDirectory(store),
    async (participants) => ({ spaceId: `oc_new_${participants.length}` }),
    registered,
  )
  const opened = await resolveReachTarget(dir, PROVIDER, { participants: ['ada palmer'] }, 'u1', {
    mayOpenGroup: true,
  })
  assert.ok(opened.ok)
  assert.equal(opened.destination.type, PROVIDER)
  assert.equal(opened.destination.target, 'oc_new_2')
  assert.deepEqual(opened.group, { spaceId: 'oc_new_2' })
  assert.equal(registered.length, 1)
  assert.deepEqual(registered[0]!.participants, ['u1', 'u3'])

  const writeBack = async (spaceId: string): Promise<void> => {
    await store.apply({
      provider: PROVIDER,
      instanceId: 'test',
      syncedAt: 2_000,
      spaces: [{ spaceId, name: 'Ada & Ada Palmer', kind: 'group' }],
      spaceMembers: [
        { spaceId, providerUserId: 'u1' },
        { spaceId, providerUserId: 'u3' },
      ],
      replace: ['spaceMembers'],
    })
  }
  await writeBack('oc_new_2')
  const known = await resolveReachTarget(reachDirectory(store), PROVIDER, { participants: ['ada palmer'] }, 'u1')
  assert.ok(known.ok)
  assert.equal(known.destination.target, 'oc_new_2')
})

test('openGroup failures map to the qm error ladder', async () => {
  const store = await seededStore()

  const notAllowed = await resolveReachTarget(reachDirectory(store), PROVIDER, { participants: ['ada palmer'] }, 'u1', {
    mayOpenGroup: false,
  })
  assert.ok(!notAllowed.ok)
  assert.equal(notAllowed.status, 404)
  assert.equal(notAllowed.error, 'group_not_found')

  const refused = await resolveReachTarget(
    withOpenGroup(reachDirectory(store), async () => ({ error: 'provider said no' })),
    PROVIDER,
    { participants: ['ada palmer'] },
    'u1',
    { mayOpenGroup: true },
  )
  assert.ok(!refused.ok)
  assert.equal(refused.status, 502)
  assert.equal(refused.error, 'group_open_failed')
  assert.match(refused.message, /provider said no/)

  const failed = await resolveReachTarget(
    withOpenGroup(reachDirectory(store), async () => null),
    PROVIDER,
    { participants: ['ada palmer'] },
    'u1',
    { mayOpenGroup: true },
  )
  assert.ok(!failed.ok)
  assert.equal(failed.status, 502)

  const unknownActor = await resolveReachTarget(
    withOpenGroup(reachDirectory(store), async () => ({ spaceId: 'oc_x' })),
    PROVIDER,
    { participants: ['ada palmer'] },
    'ghost',
    { mayOpenGroup: true },
  )
  assert.ok(!unknownActor.ok)
  assert.equal(unknownActor.status, 403)
  assert.equal(unknownActor.error, 'identity_unverified')
})
