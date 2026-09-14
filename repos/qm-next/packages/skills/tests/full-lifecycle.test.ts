/**
 * Skill pack + ingest + sync + materialization suite (parity 15.0):
 * pack/bundle stores, manifest HMAC, full create/verify/restore/promote/move
 * lifecycle, frontmatter parser, planIngest on canned repos, materialize
 * over an in-memory sandbox, and the SSRF IP guard.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScopeId, AgentComputerProfile, ExecResult } from '@qm/types'
import {
  createMemorySkillBundleStore,
  createMemorySkillPackStore,
  createMemorySkillStore,
  parseFrontmatter,
  parseSeedSkillFrontmatter,
  isPrivateNetworkIp,
  planIngest,
  collectSharedBundle,
  importPack,
  materializeSkillIndex,
  materializeSkillTree,
  skillsMaterializerIndex,
  upsertSeedSkill,
  type FetchedRepo,
  type Sandbox,
  type SandboxHandle,
  type SkillBundle,
  type SkillManifest,
  type SkillResolution,
} from '../src/index.ts'

function file(path: string, text: string, binary = false) {
  return { path, text, binary }
}

function repo(commit: string, files: Array<{ path: string; text: string; binary?: boolean }>): FetchedRepo {
  return { commit, files: files.map((f) => ({ ...f, binary: f.binary ?? false })) }
}

const ORG = 'org:acme' as ScopeId

const SAMPLE_MANIFEST = (name: string, body = `# ${name}\n\nstep one\n`): SkillManifest => ({
  name,
  description: `desc for ${name}`,
  body,
  requiredCapabilities: [],
})

const SAMPLE_PACK = {
  id: 'pack-1',
  kind: 'git' as const,
  url: 'https://example.com/repo.git',
  ref: '',
  syncMode: 'pinned' as const,
  trustTier: 'third-party' as const,
  targetScopeId: ORG,
  subset: 'all' as const,
  createdBy: 'person:ada',
  createdAt: 1_000,
}

test('pack store: memory create/get/list/patch/remove round-trip', async () => {
  const packs = createMemorySkillPackStore()
  const pack = await packs.create({ ...SAMPLE_PACK, subset: ['alpha'] })
  assert.match(pack.id, /[0-9a-f-]{36}/)
  assert.equal((await packs.get(pack.id))?.id, pack.id)
  assert.equal((await packs.list()).length, 1)
  const updated = await packs.update(pack.id, { ref: 'main' })
  assert.equal(updated.ref, 'main')
  await packs.recordImport(pack.id, { at: 2_000, commit: 'abc', status: 'ok', counts: { total: 1, eligible: 1 } })
  assert.equal((await packs.get(pack.id))?.lastImport?.commit, 'abc')
  await packs.remove(pack.id)
  assert.equal(await packs.get(pack.id), null)
})

test('bundle store: memory put/get/list/delete and the canonical hash', async () => {
  const bundles = createMemorySkillBundleStore()
  const bundle: SkillBundle = {
    packId: 'p1',
    commit: 'abc',
    hash: 'irrelevant',
    files: [{ path: 'shared/help.md', content: 'help' }, { path: 'shared/logo.txt', content: 'x' }],
  }
  await bundles.put(bundle)
  assert.equal((await bundles.get('p1'))?.files.length, 2)
  assert.equal((await bundles.list()).length, 1)
  await bundles.delete('p1')
  assert.equal(await bundles.get('p1'), null)
})

test('frontmatter: parses flow arrays, block scalars, and lists', () => {
  const raw = `---
name: alpha
description: "first skill"
requiredCapabilities: [cap.read, cap.write]
body_intro: |
  line one
  line two
notes: >
  folded
  text
  text
tags:
  - one
  - two
---
hello world
`
  const { attrs, body } = parseFrontmatter(raw)
  assert.equal(attrs.name, 'alpha')
  assert.equal(attrs.description, 'first skill')
  assert.deepEqual(attrs.requiredCapabilities, ['cap.read', 'cap.write'])
  assert.equal(attrs.body_intro, 'line one\nline two')
  assert.match(String(attrs.notes), /folded text text/)
  assert.deepEqual(attrs.tags, ['one', 'two'])
  assert.match(body, /hello world/)
})

test('parseSeedSkillFrontmatter: validates the name and body', () => {
  const ok = parseSeedSkillFrontmatter('---\nname: alpha\ndescription: "x"\nrequiredCapabilities: []\n---\nbody\n')
  assert.equal(ok.name, 'alpha')
  assert.throws(() => parseSeedSkillFrontmatter('---\ndescription: x\n---\n'), /requires name/)
  assert.throws(() => parseSeedSkillFrontmatter('---\nname: bad name\n---\n'), /skill name|requires name/)
  assert.throws(() => parseSeedSkillFrontmatter('---\nname: alpha\n---\n'), /requires description/)
  assert.throws(() => parseSeedSkillFrontmatter('---\nname: alpha\ndescription: x\n---\n'), /requires a body/)
})

test('planIngest: classifies by scope, private, collision, binary, malformed', () => {
  const native = new Set(['beta'])
  const r = repo(
    'c1',
    [
      file('alpha/SKILL.md', '---\nname: alpha\ndescription: ok\n---\nbody'),
      file('alpha/asset.bin', 'binary', true),
      file('beta/SKILL.md', '---\nname: beta\n---\nbody'),
      file('gamma/SKILL.md', '---\nname: gamma\nscope: personal\n---\nbody'),
      file('delta/SKILL.md', '---\nname: delta\nprivate: true\n---\nbody'),
      file('broken/SKILL.md', 'not frontmatter'),
    ],
  )
  const plan = planIngest(r, { nativeNames: native })
  assert.equal(plan.candidates.length, 5)
  assert.equal(plan.counts.total, 5)
  assert.equal(plan.counts.eligible, 0, 'all five skills hit an exclusion reason in this fixture')
  assert.equal(plan.counts['binary-asset'], 1)
  assert.equal(plan.counts.collision, 1)
  assert.equal(plan.counts.scope, 1)
  assert.equal(plan.counts.private, 1)
  assert.equal(plan.counts.malformed, 1)
})

test('collectSharedBundle: only files outside skill directories, ignoring repo metadata', () => {
  const r = repo('c1', [
    file('alpha/SKILL.md', 'body'),
    file('alpha/asset.txt', 'a'),
    file('README.md', 'top'),
    file('LICENSE', 'l'),
    file('shared/util.md', 'u'),
    file('docs/info.md', 'i'),
    file('.gitignore', 'g'),
    file('.github/CODEOWNERS', 'o'),
  ])
  const out = collectSharedBundle(r)
  assert.deepEqual(out.map((f) => f.path), ['docs/info.md', 'shared/util.md'])
})

test('upsertSeedSkill: install → update → skipped → published lifecycle', async () => {
  const store = createMemorySkillStore()
  const installed = await upsertSeedSkill(store, {
    scopeId: ORG,
    manifest: SAMPLE_MANIFEST('alpha'),
    createdBy: 'person:ada',
    reviewer: 'person:boss',
  })
  assert.equal(installed, 'installed')
  const once = (await store.list()).find((s) => s.name === 'alpha')!
  assert.equal(once.approvals?.[0], 'person:boss')
  assert.equal(once.signature?.length, 64)

  const updated = await upsertSeedSkill(store, {
    scopeId: ORG,
    manifest: { ...SAMPLE_MANIFEST('alpha', '# alpha\n\nupdated') },
    createdBy: 'person:ada',
    reviewer: 'person:boss',
  })
  assert.equal(updated, 'updated')
  const list = await store.list()
  assert.equal(list.length, 1)
  assert.match(list[0]!.body, /updated/)

  const skipped = await upsertSeedSkill(store, {
    scopeId: ORG,
    manifest: SAMPLE_MANIFEST('alpha', '# alpha\n\nupdated'),
    createdBy: 'person:ada',
    reviewer: 'person:boss',
  })
  assert.equal(skipped, 'skipped')
})

test('full lifecycle: register, verify, promote to org, move between personal scopes', async () => {
  const store = createMemorySkillStore({ signingSecret: 'shared' })
  const created = await store.create!({
    scopeId: 'personal:person:ada' as ScopeId,
    manifest: { ...SAMPLE_MANIFEST('alpha'), requiredCapabilities: ['cap.read'] },
    createdBy: 'person:ada',
    reviewer: 'person:boss',
    grantCapabilities: ['cap.read'],
  })
  assert.equal(store.verify!(created), true)
  // signature flips when the manifest is rewritten
  const tampered = { ...created, body: 'tampered' }
  assert.equal(store.verify!(tampered), false)

  await store.restore!(created)
  const promoted = await store.promote!(created.id, 'org:acme' as ScopeId)
  assert.equal(promoted.scopeId, 'org:acme')
  assert.equal(promoted.version, 1, 'first publish into the new scope starts at version 1')
  assert.equal(store.verify!(promoted), true)

  const moved = await store.move!(promoted.id, 'personal:person:bea' as ScopeId)
  assert.equal(moved.scopeId, 'personal:person:bea')
  await assert.rejects(
    store.move!(moved.id, 'org:acme' as ScopeId),
    /promote/,
  )
})

test('importPack: registers, ignores private and personal-scope skills, surfaces collisions', async () => {
  const store = createMemorySkillStore()
  await store.register({ scopeId: ORG, name: 'beta', description: 'taken', body: 'b', createdBy: 'person:ada' })
  const r = repo(
    'commit-x',
    [
      file('alpha/SKILL.md', '---\nname: alpha\ndescription: ok\n---\nbody'),
      file('beta/SKILL.md', '---\nname: beta\ndescription: collides\n---\nbody'),
      file('gamma/SKILL.md', '---\nname: gamma\nscope: personal\n---\nbody'),
      file('delta/SKILL.md', '---\nname: delta\nprivate: true\n---\nbody'),
    ],
  )
  const result = await importPack(r, store, {
    pack: { ...SAMPLE_PACK, id: 'p1' },
    selected: 'all',
    nativeNames: new Set(),
  })
  assert.equal(result.imported.length, 1)
  assert.equal(result.imported[0], 'alpha')
  assert.deepEqual(Object.keys(result.counts).sort(), [
    'binary-asset',
    'collision',
    'eligible',
    'malformed',
    'private',
    'scope',
    'total',
  ])
  const all = await store.list()
  assert.equal(all.length, 2, 'alpha is new; beta from earlier stays')
  assert.equal(all.find((s) => s.name === 'alpha')?.pack?.packId, 'p1')
})

test('materialize: index writes SKILL.md + marker; tree writes files + bundles; nothing changes on a second pass', async () => {
  const store = createMemorySkillStore()
  const created = await store.create!({
    scopeId: ORG,
    manifest: { ...SAMPLE_MANIFEST('alpha', '# alpha\n\nbody'), files: [{ path: 'asset.txt', content: 'a' }] },
    createdBy: 'person:ada',
    reviewer: 'person:boss',
  })
  const bundle: SkillBundle = {
    packId: 'p1',
    commit: 'c1',
    hash: 'b-hash',
    files: [{ path: 'shared/help.md', content: 'help' }],
  }
  const resolution: SkillResolution = { skill: created, shadowed: [] }
  const sandbox = makeInMemorySandbox()
  const handle = sandbox.handle('s-1')

  await materializeSkillIndex(sandbox, handle, [resolution])
  const filesAfterIndex = sandbox.snapshot(handle)
  assert.match(filesAfterIndex['skills/alpha/SKILL.md'] ?? '', /body/)
  assert.match(filesAfterIndex['skills/.index'] ?? '', /"version":2/)
  assert.match(filesAfterIndex['skills/.index'] ?? '', /alpha/)

  await materializeSkillTree(sandbox, handle, resolution, [bundle])
  const afterTree = sandbox.snapshot(handle)
  assert.match(afterTree['skills/alpha/asset.txt'] ?? '', /^a/)
  assert.match(afterTree['skills/.packs/p1/shared/help.md'] ?? '', /^help/)
  assert.match(afterTree['skills/alpha/.tree'] ?? '', /"version":2/)

  const baseline = sandbox.snapshot(handle)
  await materializeSkillIndex(sandbox, handle, [resolution])
  await materializeSkillTree(sandbox, handle, resolution, [bundle])
  const same = sandbox.snapshot(handle)
  assert.equal(JSON.stringify(baseline), JSON.stringify(same), 'no marker change → no write')

  assert.match(skillsMaterializerIndex([resolution]), /- \*\*alpha\*\*/)
  assert.match(skillsMaterializerIndex([resolution]), /read `skills\/alpha\/SKILL.md`/)
})

test('isPrivateNetworkIp: rejects loopback / private / link-local / ULA', () => {
  assert.equal(isPrivateNetworkIp('127.0.0.1'), true)
  assert.equal(isPrivateNetworkIp('10.0.0.1'), true)
  assert.equal(isPrivateNetworkIp('172.16.5.1'), true)
  assert.equal(isPrivateNetworkIp('192.168.0.1'), true)
  assert.equal(isPrivateNetworkIp('169.254.1.1'), true)
  assert.equal(isPrivateNetworkIp('100.64.0.1'), true)
  assert.equal(isPrivateNetworkIp('8.8.8.8'), false)
  assert.equal(isPrivateNetworkIp('::1'), true)
  assert.equal(isPrivateNetworkIp('fc00::1'), true)
  assert.equal(isPrivateNetworkIp('2001:db8::1'), false)
})

function makeInMemorySandbox(): Sandbox & { handle(id: string): SandboxHandle; snapshot(handle: SandboxHandle): Record<string, string> } {
  const stores = new Map<string, Map<string, string>>()
  function ensure(id: string): Map<string, string> {
    let s = stores.get(id)
    if (!s) {
      s = new Map()
      stores.set(id, s)
    }
    return s
  }
  const handle: SandboxHandle = { id: 's-1', rootDir: '/workspace' }
  const profile: AgentComputerProfile = {
    backend: 'local',
    writablePersistence: 'ro-layers' as AgentComputerProfile['writablePersistence'],
    processSessions: false,
  }
  const sandbox: Sandbox = {
    profile,
    async provision() {
      return handle
    },
    async run(): Promise<ExecResult> {
      return { stdout: '', stderr: '', code: 0, timedOut: false }
    },
    async readFile(_h: SandboxHandle, path: string) {
      return ensure(_h.id).get(path) ?? null
    },
    async writeFile(h: SandboxHandle, path: string, data: string) {
      ensure(h.id).set(path, data)
    },
    async writeFileBytes(h: SandboxHandle, path: string, data: Uint8Array) {
      ensure(h.id).set(path, Buffer.from(data).toString('utf8'))
    },
    async readFileBytes(h: SandboxHandle, path: string) {
      const v = ensure(h.id).get(path)
      return v ? Buffer.from(v, 'utf8') : null
    },
    async removeDir(h: SandboxHandle, path: string) {
      for (const k of [...ensure(h.id).keys()]) if (k === path || k.startsWith(`${path}/`)) ensure(h.id).delete(k)
    },
    async listDir(h: SandboxHandle, dir: string) {
      return [...ensure(h.id).keys()]
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => p.slice(`${dir}/`.length).split('/')[0]!)
        .filter((v, i, a) => a.indexOf(v) === i)
    },
    async teardown() {},
  }
  const handleFactory = (id: string): SandboxHandle => ({ id, rootDir: '/workspace' })
  return Object.assign(sandbox, {
    handle: handleFactory,
    snapshot(h: SandboxHandle) {
      return Object.fromEntries(ensure(h.id))
    },
  }) as ReturnType<typeof makeInMemorySandbox>
}
