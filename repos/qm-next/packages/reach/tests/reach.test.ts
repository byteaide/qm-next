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
