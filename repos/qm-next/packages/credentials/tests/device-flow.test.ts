import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildResidentAuthProbeScript,
  captureDeviceFlowLogins,
  createDeviceFlowCutoverStore,
  createKeychain,
  createLivenessCache,
  deriveConnectorKey,
  DEVICE_FLOW_CUTOVER_MODES,
  DEVICE_FLOW_ORIGIN,
  deviceFlowCredOwner,
  makeTar,
  materializeDeviceFlowLogins,
  mergeConnectors,
  parseTar,
  probeResidentAuth,
  residentAuthProbeIsStale,
  removeDeviceFlowLogins,
  RESIDENT_AUTH_CONNECTORS,
} from '../src/index.ts'
import type { DurableMap } from '@qm/store'
import type { KeychainAsk, KeychainCredential, KeychainGrant, Sandbox, SandboxHandle, ScopeId } from '@qm/types'

function mem<T>(): DurableMap<T> {
  const rows = new Map<string, T>()
  return {
    async all() {
      return [...rows.values()]
    },
    async entries() {
      return [...rows.entries()]
    },
    async get(id) {
      return rows.get(id) ?? null
    },
    async put(id, value) {
      rows.set(id, value)
    },
    async putIfAbsent(id, value) {
      if (rows.has(id)) return rows.get(id)!
      rows.set(id, value)
      return value
    },
    async merge(id, patch) {
      const current = rows.get(id)
      if (!current) return null
      rows.set(id, { ...current, ...patch })
      return rows.get(id)!
    },
    async delete(id) {
      rows.delete(id)
    },
    async take(id) {
      const value = rows.get(id) ?? null
      rows.delete(id)
      return value
    },
  }
}

function keychain() {
  return createKeychain({
    creds: mem<KeychainCredential>(),
    grants: mem<KeychainGrant>(),
    asks: mem<KeychainAsk>(),
    key: deriveConnectorKey('test-key-material', 'keychain-test'),
    now: () => 1_000,
  })
}

type FakeFile = { path: string; data: Buffer }
type RunCall = { command: string; opts?: { timeoutMs?: number } }

function fakeSandbox(files: FakeFile[]) {
  const runs: RunCall[] = []
  const written: FakeFile[] = []
  const sandbox: Sandbox = {
    profile: { backend: 'fake', writablePersistence: 'snapshot_to_workspace', processSessions: false },
    async run(_handle, command, opts) {
      runs.push({ command, ...(opts ? { opts } : {}) })
      const ok = { code: 0, stdout: '', stderr: '', timedOut: false }
      if (command.startsWith('mktemp')) return { code: 0, stdout: '/tmp/cap/agent-cred-capture.X1', stderr: '', timedOut: false }
      if (command.includes('tar -h --null')) {
        await makeTar(files.map((f) => ({ path: f.path, data: f.data }))).then((tar) =>
          files.push({ path: 'agent-cred-capture.X1', data: tar }),
        )
        return ok
      }
      if (command.startsWith('rm -f')) return ok
      if (command.includes('for p in') && command.includes('[ -e "$p" ] && printf')) {
        const quoted = command.split('for p in ')[1]!.split(';')[0]!
        const candidates = quoted.match(/'[^']*'/g)?.map((q) => q.slice(1, -1)) ?? []
        const present = candidates.filter((p) => files.some((f) => f.path === p.replace('/root/', '')))
        return { code: 0, stdout: present.map((p) => `${p}\u0000`).join(''), stderr: '', timedOut: false }
      }
      if (command.includes('chmod 600')) return ok
      if (command.includes('rm -rf --')) return ok
      if (command.startsWith('( if command -v')) {
        const lines = command
          .split('\n')
          .filter((l) => l.includes('command -v'))
          .map((l) => {
            const id = l.match(/echo "([^|]+)\|/)?.[1]
            const bin = l.match(/command -v (\S+)/)?.[1]
            const known = ['gh', 'glab', 'gcloud']
            return `${id}|${bin && known.includes(bin) ? 'active' : 'absent'}`
          })
        return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '', timedOut: false }
      }
      return ok
    },
    async readFileBytes(_handle, relPath) {
      const f = files.find((x) => x.path === relPath)
      return f ? new Uint8Array(f.data) : null
    },
    async writeFileBytes(_handle, relPath, data) {
      written.push({ path: relPath, data: Buffer.from(data) })
      files.push({ path: relPath.replace('/root/', ''), data: Buffer.from(data) })
    },
    provision: async () => {
      throw new Error('not used')
    },
    readFile: async () => null,
    writeFile: async () => undefined,
    listDir: async () => [],
    removeDir: async () => undefined,
    teardown: async () => undefined,
  }
  return { sandbox, runs, written }
}

const handle: SandboxHandle = { id: 'h1', rootDir: '/root/workspace', homeDir: '/root' }

test('resident auth: probe script shape, staleness ttl, merge semantics and probe end to end', async () => {
  const script = buildResidentAuthProbeScript(RESIDENT_AUTH_CONNECTORS, 6)
  assert.ok(script.includes('command -v gh'))
  assert.ok(script.endsWith('\nwait'))
  assert.ok(script.includes('echo "gh|active"'))
  assert.ok(residentAuthProbeIsStale(null, 0))
  assert.equal(residentAuthProbeIsStale({ scopeId: 's', checkedAt: 100, connectors: {} }, 100 + 5 * 60_000), false)
  assert.equal(residentAuthProbeIsStale({ scopeId: 's', checkedAt: 100, connectors: {} }, 100 + 5 * 60_000 + 1), true)
  const merged = mergeConnectors(RESIDENT_AUTH_CONNECTORS, [{ id: 'gh', label: 'GH2', check: 'x', reauth: 'y' }])
  assert.equal(merged.length, 3)
  assert.equal(merged.find((c) => c.id === 'gh')!.label, 'GH2')

  const cache = createLivenessCache(mem())
  const { sandbox } = fakeSandbox([])
  await probeResidentAuth({ sandbox, handle, cache, scopeId: 'personal:u1', now: 5_000 })
  const record = await cache.get('personal:u1')
  assert.equal(record!.checkedAt, 5_000)
  assert.equal(record!.connectors.gh, 'active')
  assert.equal(record!.connectors.gcloud, 'active')
  assert.equal(record!.connectors.glab, 'active')
  const unknown = Object.keys(record!.connectors).filter((id) => !RESIDENT_AUTH_CONNECTORS.some((c) => c.id === id))
  assert.deepEqual(unknown, [])
})

test('device flow capture: saves per-service file credentials and dedupes by fingerprint', async () => {
  const kc = keychain()
  const files: FakeFile[] = [
    { path: '.aws/credentials', data: Buffer.from('[default]\naws_access_key_id=A\n') },
    { path: '.aws/config', data: Buffer.from('[default]\nregion=us-east-1\n') },
    { path: '.config/gh/hosts.yml', data: Buffer.from('github.com:\n  user: octo\n') },
    { path: 'node_modules/junk.txt', data: Buffer.from('pruned') },
  ]
  const { sandbox } = fakeSandbox(files)
  const first = await captureDeviceFlowLogins({ sandbox, handle, keychain: kc, ownerId: 'u1' })
  assert.deepEqual(first.sort(), ['aws', 'gh'])
  const metas = await kc.listByOwner('u1')
  assert.equal(metas.length, 2)
  assert.ok(metas.every((m) => m.origin === DEVICE_FLOW_ORIGIN))
  assert.ok(metas.every((m) => m.kind === 'file'))
  const second = await captureDeviceFlowLogins({ sandbox, handle, keychain: kc, ownerId: 'u1' })
  assert.deepEqual(second, [])
  const changed: FakeFile[] = [{ path: '.aws/credentials', data: Buffer.from('[default]\naws_access_key_id=B\n') }]
  const { sandbox: sandbox2 } = fakeSandbox(changed)
  const third = await captureDeviceFlowLogins({ sandbox: sandbox2, handle, keychain: kc, ownerId: 'u1' })
  assert.deepEqual(third, ['aws'])
})

test('device flow capture honors service filters and anomaly caps', async () => {
  const kc = keychain()
  const chunk = Buffer.alloc(900_000, 7)
  const files: FakeFile[] = [
    { path: '.aws/a', data: chunk },
    { path: '.aws/b', data: chunk },
    { path: '.aws/c', data: chunk },
    { path: '.aws/d', data: chunk },
    { path: '.aws/e', data: chunk },
    { path: '.config/gh/hosts.yml', data: Buffer.from('x') },
  ]
  const { sandbox } = fakeSandbox(files)
  const anomalies: string[] = []
  const saved = await captureDeviceFlowLogins({
    sandbox,
    handle,
    keychain: kc,
    ownerId: 'u1',
    onAnomaly: (service) => anomalies.push(service),
  })
  assert.deepEqual(saved, ['gh'])
  assert.deepEqual(anomalies, ['aws'])
  const bigSkip = fakeSandbox([{ path: '.aws/huge', data: Buffer.alloc(1024 * 1024, 1) }])
  const skipped = await captureDeviceFlowLogins({ sandbox: bigSkip.sandbox, handle, keychain: kc, ownerId: 'u2' })
  assert.deepEqual(skipped, [])
  assert.deepEqual(await kc.listByOwner('u2'), [])
})

test('device flow materialize restores absent files only, remove quarantines', async () => {
  const kc = keychain()
  const files: FakeFile[] = [
    { path: '.aws/credentials', data: Buffer.from('[default]\naws_access_key_id=A\n') },
    { path: '.config/gh/hosts.yml', data: Buffer.from('github.com:\n  user: octo\n') },
  ]
  const { sandbox } = fakeSandbox(files)
  await captureDeviceFlowLogins({ sandbox, handle, keychain: kc, ownerId: 'u1' })

  const fresh = fakeSandbox([{ path: '.aws/credentials', data: Buffer.from('[default]\naws_access_key_id=A\n') }])
  const restored = await materializeDeviceFlowLogins({ sandbox: fresh.sandbox, handle, keychain: kc, ownerId: 'u1' })
  assert.deepEqual(restored, ['gh'])
  assert.equal(fresh.written.length, 1)
  assert.equal(fresh.written[0]!.path, '.config/gh/hosts.yml')

  const again = await materializeDeviceFlowLogins({ sandbox: fresh.sandbox, handle, keychain: kc, ownerId: 'u1' })
  assert.deepEqual(again, [])

  const { sandbox: rmSandbox } = fakeSandbox([])
  const removed = await removeDeviceFlowLogins({
    sandbox: rmSandbox,
    handle,
    keychain: kc,
    ownerId: 'u1',
    services: ['gh', 'aws'],
  })
  assert.equal(removed.length >= 2, true)
  assert.deepEqual(await removeDeviceFlowLogins({ sandbox: rmSandbox, handle, keychain: kc, ownerId: 'u1', services: [] }), [])
})

test('device flow cutover: modes, org inheritance and resident reset generations', async () => {
  assert.deepEqual(DEVICE_FLOW_CUTOVER_MODES, ['legacy', 'prefer_ephemeral', 'ephemeral_only'])
  assert.equal(deviceFlowCredOwner('personal:u1' as ScopeId, 'u1'), 'u1')
  assert.equal(deviceFlowCredOwner('personal:u2' as ScopeId, 'u1'), 'personal:u2')
  const backing = mem<any>()
  const resets = mem<any>()
  let clock = 1_000
  const store = createDeviceFlowCutoverStore(backing, { orgId: 'org-1', now: () => clock, resetId: () => `gen-${clock++}`, resets })
  const org: ScopeId = 'org:org-1'
  const personal: ScopeId = 'personal:u1'
  assert.equal(await store.resolve(personal, 'gh'), 'legacy')
  await store.set(org, 'GH', 'prefer_ephemeral', 'admin')
  assert.equal((await store.resolvePolicy(personal, 'gh'))!.mode, 'prefer_ephemeral')
  assert.equal(await store.resolve(personal, 'gh'), 'prefer_ephemeral')
  await assert.rejects(store.set(personal, 'gh', 'bogus' as any, 'admin'))
  await assert.rejects(store.set(personal, '  ', 'legacy', 'admin'))
  await assert.rejects(store.set(personal, 'gh', 'legacy', '  '))
  const gen = await store.residentResetGeneration(org, 'gh')
  assert.equal(gen, null)
  await store.set(org, 'gh', 'legacy', 'admin')
  const resetGen = await store.residentResetGeneration(org, 'gh')
  assert.ok(resetGen?.startsWith('gen-'))
  await store.markResidentReset(org, 'gh', resetGen!)
  assert.equal(await store.residentResetGeneration(org, 'gh'), null)
  await store.set(personal, 'gh', 'ephemeral_only', 'u1')
  await store.clear(personal, 'gh')
  const personalReset = await store.residentResetGeneration(personal, 'gh')
  assert.ok(personalReset?.startsWith('gen-'))
  await store.markResidentReset(personal, 'gh', personalReset!)
  assert.equal(await store.residentResetGeneration(personal, 'gh'), null)
})

test('tar codec round-trips entries and rejects truncated archives', async () => {
  const tar = await makeTar([
    { path: './a.txt', data: Buffer.from('alpha') },
    { path: 'b/c.txt', data: Buffer.from('beta') },
  ])
  const entries = await parseTar(tar)
  assert.equal(entries.length, 2)
  assert.equal(entries[0]!.path, './a.txt')
  assert.equal(entries[1]!.data.toString(), 'beta')
  await assert.rejects(parseTar(tar.subarray(0, 512)))
})
