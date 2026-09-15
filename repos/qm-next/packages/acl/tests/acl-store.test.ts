/**
 * Memory ACL tests (parity 16.0): conditional replace preserves
 * newer writes, prefix-aware kind filtering fails closed on personal
 * grants outside the grantee's session, membership-managed scopes
 * (channel/group) gate grants via a pluggable predicate, and
 * org/team scopes remain unguarded.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createAclStore,
  cronRef,
  deployRef,
  encodeRef,
  fileRef,
  parseRef,
  serviceCredRef,
  skillRef,
  type Grant,
  type ScopeManagement,
} from '../src/index.ts'

function P(id: string, teamIds: string[] = []) {
  return { id, type: 'internal' as const, teamIds }
}

const ORG = 'org:default-org'

function aclWith(grantees: string[]) {
  const acl = createAclStore()
  return Promise.all(
    grantees.map((g) =>
      acl.grant({
        ownerScopeId: ORG,
        ref: 'service-cred:x',
        granteeScopeId: g,
        permission: 'read',
        grantedBy: 'admin',
      }),
    ),
  ).then(() => acl)
}

const slugs = (grants: { ref: string }[]) => grants.map((g) => g.ref.slice('service-cred:'.length))

test('org-wide grant is usable by any audience (DM and channel)', async () => {
  const acl = await aclWith([ORG])
  const dm = await acl.grantsOfKind('service-cred', [P('U1')], 'personal:U1', ORG, (p, scope) =>
    scope === ORG ? true : scope === `personal:${p.id}`,
  )
  assert.deepEqual(slugs(dm), ['x'])
  const channel = await acl.grantsOfKind(
    'service-cred',
    [P('U1'), P('U2'), P('U3')],
    'channel:C',
    ORG,
    (_p, scope) => scope === ORG,
  )
  assert.deepEqual(slugs(channel), ['x'])
})

test('personal grant: usable in the grantee DM, fails closed in a mixed channel', async () => {
  const acl = await aclWith(['personal:bob'])
  const bobDm = await acl.grantsOfKind(
    'service-cred',
    [P('bob')],
    'personal:bob',
    ORG,
    (p, scope) => scope === `personal:${p.id}`,
  )
  assert.deepEqual(slugs(bobDm), ['x'])
  const mixed = await acl.grantsOfKind(
    'service-cred',
    [P('bob'), P('alice')],
    'channel:C',
    ORG,
    (p, scope) => scope === `personal:${p.id}`,
  )
  assert.deepEqual(slugs(mixed), [])
  const aliceDm = await acl.grantsOfKind(
    'service-cred',
    [P('alice')],
    'personal:alice',
    ORG,
    (p, scope) => scope === `personal:${p.id}`,
  )
  assert.deepEqual(slugs(aliceDm), [])
})

test('team grant: usable when every member is on the team, fails closed otherwise', async () => {
  const acl = await aclWith(['team:eng'])
  const allEng = await acl.grantsOfKind(
    'service-cred',
    [P('U1', ['eng']), P('U2', ['eng'])],
    'channel:C',
    ORG,
    (p, scope) => (scope === 'team:eng' ? (p.teamIds ?? []).includes('eng') : false),
  )
  assert.deepEqual(slugs(allEng), ['x'])
  const oneOutsider = await acl.grantsOfKind(
    'service-cred',
    [P('U1', ['eng']), P('U2', ['sales'])],
    'channel:C',
    ORG,
    (p, scope) => (scope === 'team:eng' ? (p.teamIds ?? []).includes('eng') : false),
  )
  assert.deepEqual(slugs(oneOutsider), [])
})

test('empty audience is entitled to nothing (fail closed)', async () => {
  const acl = await aclWith([ORG])
  assert.deepEqual(
    await acl.grantsOfKind('service-cred', [], 'personal:U1', ORG, () => true),
    [],
  )
})

test('a service-cred grant owned by a NON-org scope is ignored', async () => {
  const acl = createAclStore()
  await acl.grant({
    ownerScopeId: 'personal:attacker',
    ref: 'service-cred:foo',
    granteeScopeId: ORG,
    permission: 'read',
    grantedBy: 'attacker',
  })
  const sneaky = await acl.grantsOfKind(
    'service-cred',
    [P('U1')],
    'personal:U1',
    ORG,
    (_p, scope) => scope === ORG,
  )
  assert.deepEqual(slugs(sneaky), [])
  await acl.grant({
    ownerScopeId: ORG,
    ref: 'service-cred:foo',
    granteeScopeId: ORG,
    permission: 'read',
    grantedBy: 'admin',
  })
  const legit = await acl.grantsOfKind(
    'service-cred',
    [P('U1')],
    'personal:U1',
    ORG,
    (_p, scope) => scope === ORG,
  )
  assert.deepEqual(slugs(legit), ['foo'])
})

test('the prefix filters: a deployment grant is never returned for the service-cred prefix', async () => {
  const acl = createAclStore()
  await acl.grant({
    ownerScopeId: ORG,
    ref: 'deployment:d1',
    granteeScopeId: ORG,
    permission: 'read',
    grantedBy: 'admin',
  })
  await acl.grant({
    ownerScopeId: ORG,
    ref: 'service-cred:x',
    granteeScopeId: ORG,
    permission: 'read',
    grantedBy: 'admin',
  })
  const got = await acl.grantsOfKind(
    'service-cred',
    [P('U1')],
    'personal:U1',
    ORG,
    () => true,
  )
  assert.deepEqual(slugs(got), ['x'])
})

test('file handles exclude non-file grants — a skill/cron/deploy grant never becomes a bogus shared/ file', async () => {
  const acl = createAclStore()
  const grantee = 'channel:C'
  await acl.grant({
    ownerScopeId: ORG,
    ref: 'artifacts/F1/doc.md',
    granteeScopeId: grantee,
    permission: 'read',
    grantedBy: 'admin',
  })
  for (const r of [skillRef('s1'), cronRef('c1'), deployRef('d1'), serviceCredRef('x')]) {
    await acl.grant({
      ownerScopeId: ORG,
      ref: encodeRef(r),
      granteeScopeId: grantee,
      permission: 'read',
      grantedBy: 'admin',
    })
  }
  const handles = await acl.handlesFor([grantee])
  assert.deepEqual(
    handles.map((h) => h.ownerPath),
    ['artifacts/F1/doc.md'],
  )
  const audienceHandles = await acl.handlesForAudience([P('U1')], grantee, ORG, () => true)
  assert.deepEqual(
    audienceHandles.map((h) => h.ownerPath),
    ['artifacts/F1/doc.md'],
  )
})

test('grantsOfKind selects by kind across all artifact families', async () => {
  const acl = createAclStore()
  for (const r of [
    skillRef('s1'),
    deployRef('d1'),
    cronRef('c1'),
    serviceCredRef('x'),
  ]) {
    await acl.grant({
      ownerScopeId: ORG,
      ref: encodeRef(r),
      granteeScopeId: ORG,
      permission: 'read',
      grantedBy: 'admin',
    })
  }
  const kinds = ['skill', 'deploy', 'cron', 'service-cred'] as const
  for (const kind of kinds) {
    const got = await acl.grantsOfKind(kind, [P('U1')], 'personal:U1', ORG, () => true)
    assert.deepEqual(
      got.map((g) => parseRef(g.ref).kind),
      [kind],
      `only ${kind} grants come back for kind=${kind}`,
    )
  }
})

test('resource ref codec: round-trips through encode/parse for every kind', () => {
  const samples = [
    fileRef('artifacts/x.md'),
    skillRef('s1'),
    deployRef('d1'),
    cronRef('c1'),
    serviceCredRef('cred-1'),
  ] as const
  for (const r of samples) {
    assert.deepEqual(parseRef(encodeRef(r)), r)
  }
  assert.equal(parseRef('skill:s1').kind, 'skill')
  assert.equal(parseRef('artifacts/x.md').kind, 'file')
  assert.equal(parseRef('service-cred:cred-1').id, 'cred-1')
})

const CHAN = 'channel:C1'
const GROUP = 'group:G1'
const CHAN_MEMBERS = new Set(['alice'])
const GROUP_MEMBERS = new Set(['bob'])

const manages: ScopeManagement = async (principalId, scope) => {
  if (scope === CHAN) return CHAN_MEMBERS.has(principalId)
  if (scope === GROUP) return GROUP_MEMBERS.has(principalId)
  return false
}

const ref = encodeRef(deployRef('d1'))
const carol = 'personal:carol'
const grant = (over: Partial<Grant> = {}): Grant => ({
  ownerScopeId: CHAN,
  ref,
  granteeScopeId: carol,
  permission: 'read',
  grantedBy: 'alice',
  ...over,
})

test('a channel member may grant and revoke its artifacts (members manage)', async () => {
  const acl = createAclStore(undefined, { manages })
  await acl.grant(grant({ grantedBy: 'alice' }))
  assert.equal((await acl.grantsFor(CHAN, ref)).length, 1)
  await acl.revoke(CHAN, ref, carol, 'alice')
  assert.equal((await acl.grantsFor(CHAN, ref)).length, 0)
})

test('a non-member cannot grant or revoke a channel artifact', async () => {
  const acl = createAclStore(undefined, { manages })
  await assert.rejects(acl.grant(grant({ grantedBy: 'mallory' })), /only a manager/)
  await acl.grant(grant({ grantedBy: 'alice' }))
  await assert.rejects(acl.revoke(CHAN, ref, carol, 'mallory'), /only a manager/)
  assert.equal((await acl.grantsFor(CHAN, ref)).length, 1)
})

test('personal-scope owner authz is unchanged: only the owner manages', async () => {
  const acl = createAclStore(undefined, { manages })
  const owner = 'personal:U1'
  await assert.rejects(acl.grant(grant({ ownerScopeId: owner, grantedBy: 'U2' })), /only a manager/)
  await acl.grant(grant({ ownerScopeId: owner, grantedBy: 'U1' }))
  assert.equal((await acl.grantsFor(owner, ref)).length, 1)
})

test('org/team home scopes are not membership-managed: grants pass unguarded as before', async () => {
  const acl = createAclStore(undefined, { manages })
  const org = 'org:default-org'
  const team = 'team:eng'
  await acl.grant(grant({ ownerScopeId: org, grantedBy: 'admin' }))
  await acl.grant(grant({ ownerScopeId: team, grantedBy: 'someone' }))
  assert.equal((await acl.grantsFor(org, ref)).length, 1)
  assert.equal((await acl.grantsFor(team, ref)).length, 1)
})

test('conditional grant compensation preserves a newer full-tuple write', async () => {
  const acl = createAclStore()
  const owner = 'org:default-org'
  const ref = 'service-cred:k'
  const original: Grant = {
    ownerScopeId: owner,
    ref,
    granteeScopeId: owner,
    permission: 'write',
    grantedBy: 'original-governor',
  }
  const forward: Grant = {
    ownerScopeId: owner,
    ref,
    granteeScopeId: 'personal:alice',
    permission: 'read',
    grantedBy: 'editor',
  }
  const concurrent: Grant = {
    ownerScopeId: owner,
    ref,
    granteeScopeId: 'team:security',
    permission: 'write',
    grantedBy: 'concurrent-governor',
  }
  await acl.grant(original)
  assert.equal(await acl.replaceGrantsIfCurrent(owner, ref, [original], [forward], 'editor'), true)
  await acl.grant(concurrent)

  assert.equal(await acl.replaceGrantsIfCurrent(owner, ref, [forward], [original], 'editor'), false)
  const grants = await acl.grantsFor(owner, ref)
  assert.equal(grants.length, 2)
  assert.ok(grants.some((g) => sameGrant(g, forward)))
  assert.ok(grants.some((g) => sameGrant(g, concurrent)))
})

function sameGrant(a: Grant, b: Grant): boolean {
  return (
    a.ownerScopeId === b.ownerScopeId &&
    a.ref === b.ref &&
    a.granteeScopeId === b.granteeScopeId &&
    a.permission === b.permission
  )
}

test('revoke: a non-owner cannot revoke a personal-scope grant', async () => {
  const acl = createAclStore()
  const owner = 'personal:U1'
  const carol = 'personal:U2'
  await acl.grant({
    ownerScopeId: owner,
    ref: 'redline.md',
    granteeScopeId: carol,
    permission: 'read',
    grantedBy: 'U1',
  })
  await assert.rejects(acl.revoke(owner, 'redline.md', carol, 'U2'), /only a manager/)
  assert.equal((await acl.grantsFor(owner, 'redline.md')).length, 1)
  await acl.revoke(owner, 'redline.md', carol, 'U1')
  assert.equal((await acl.grantsFor(owner, 'redline.md')).length, 0)
})

test('revoke: org-owned grants have no single owner, so revoke is not owner-gated', async () => {
  const acl = createAclStore()
  const org = 'org:default-org'
  const carol = 'personal:U2'
  await acl.grant({
    ownerScopeId: org,
    ref: 'redline.md',
    granteeScopeId: carol,
    permission: 'read',
    grantedBy: 'admin',
  })
  await acl.revoke(org, 'redline.md', carol, 'someone-else')
  assert.equal((await acl.grantsFor(org, 'redline.md')).length, 0)
})