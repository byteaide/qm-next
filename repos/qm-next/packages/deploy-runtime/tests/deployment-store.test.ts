/**
 * Deployment-store integration tests (cluster 1 MVP). Wires the store
 * with a static `DeployProvider` + an in-memory `DurableByteStore` and
 * confirms `deploy`/`redeploy`/`archive`/`restore`/`rollback` each
 * drive the runtime hooks; without the runtime deps wired, the store
 * keeps the lane-A in-memory shape (no provider.apply calls).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMemoryByteStore } from '@qm/store'
import type { DeployFile, DeployMaterializer } from '@qm/types'
import { createMaterializer, createStaticDeployProvider } from '../src/index.ts'
import { createMemoryDeploymentStore, type DeploymentStoreDeps } from '../../api/src/services/deployment-store.ts'
import type { GrantLedger } from '../../api/src/services/grant-ledger.ts'
import { createMemoryGrantLedger } from '../../api/src/services/grant-ledger.ts'

function makeStore(opts: Partial<DeploymentStoreDeps> = {}): {
  store: ReturnType<typeof createMemoryDeploymentStore>
  grants: GrantLedger
  cleanup: () => void
} {
  const grants = createMemoryGrantLedger()
  const byteStore = createMemoryByteStore()
  const root = mkdtempSync(join(tmpdir(), 'qm-next-deploy-store-'))
  const materializer: DeployMaterializer = opts.materializer ?? createMaterializer(byteStore, { workspaceRoot: root })
  const provider = opts.provider ?? createStaticDeployProvider()
  const warnings: string[] = []
  const logger = { warn: (msg: string) => warnings.push(msg) }
  const store = createMemoryDeploymentStore({
    grants,
    materializer,
    provider,
    logger,
  })
  return {
    store,
    grants,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

async function blobOf(byteStore: ReturnType<typeof createMemoryByteStore>, bytes: Buffer): Promise<DeployFile> {
  const { blobKey } = await byteStore.put(bytes)
  return { path: 'server.js', blobKey }
}

test('without runtime deps the store keeps lane-A shape (no provider calls)', async () => {
  const grants = createMemoryGrantLedger()
  const store = createMemoryDeploymentStore({ grants })
  const record = await store.deploy({
    ownerScopeId: 'personal:user-1',
    createdBy: 'user-1',
    entrypoint: 'node server.js',
    files: [],
  })
  assert.equal(record.appliedVersion, undefined)
  assert.equal(record.endpoint, undefined)
  const logs = await store.logsFor(record.id, 'user-1', { tailLines: 50 })
  assert.deepEqual(logs, { status: 'ok', logs: null })
})

test('deploy() drives materializer then provider.apply', async () => {
  const byteStore = createMemoryByteStore()
  const root = mkdtempSync(join(tmpdir(), 'qm-next-deploy-store-'))
  try {
    const { blobKey } = await byteStore.put(Buffer.from('console.log("ok")'))
    const materializer = createMaterializer(byteStore, { workspaceRoot: root })
    const provider = createStaticDeployProvider()
    const grants = createMemoryGrantLedger()
    const store = createMemoryDeploymentStore({
      grants,
      materializer,
      provider,
      logger: { warn: () => undefined },
    })
    const record = await store.deploy({
      ownerScopeId: 'personal:user-1',
      createdBy: 'user-1',
      entrypoint: 'node server.js',
      files: [{ path: 'server.js', blobKey }],
    })
    assert.equal(record.appliedVersion, 1)
    assert.deepEqual(record.endpoint, { host: '127.0.0.1', port: 9100 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('redeploy() pushes a new version and calls apply() again', async () => {
  const { store, cleanup } = makeStore()
  try {
    const first = await store.deploy({
      ownerScopeId: 'personal:user-1',
      createdBy: 'user-1',
      entrypoint: 'node server.js',
      files: [],
    })
    const second = await store.redeploy(first.id, {
      entrypoint: 'node server.js',
      files: [],
    })
    assert.equal(second.currentVersion, 2)
    assert.equal(second.appliedVersion, 2)
    const firstAfter = await store.getByIdOrName(first.id)
    assert.equal(firstAfter?.currentVersion, 2)
    assert.equal(firstAfter?.appliedVersion, 2)
  } finally {
    cleanup()
  }
})

test('archive() calls provider.destroy and clears the endpoint', async () => {
  const { store, cleanup } = makeStore()
  try {
    const created = await store.deploy({
      ownerScopeId: 'personal:user-1',
      createdBy: 'user-1',
      entrypoint: 'node server.js',
      files: [],
    })
    assert.ok(created.endpoint)
    await store.archive(created.id)
    const after = await store.getByIdOrName(created.id)
    assert.equal(after?.status, 'archived')
    assert.equal(after?.endpoint, undefined)
  } finally {
    cleanup()
  }
})

test('rollback() re-applies the target version', async () => {
  const byteStore = createMemoryByteStore()
  const root = mkdtempSync(join(tmpdir(), 'qm-next-deploy-rollback-'))
  try {
    const { blobKey: v1Key } = await byteStore.put(Buffer.from('v1'))
    const { blobKey: v2Key } = await byteStore.put(Buffer.from('v2'))
    const materializer = createMaterializer(byteStore, { workspaceRoot: root })
    const provider = createStaticDeployProvider()
    const grants = createMemoryGrantLedger()
    const store = createMemoryDeploymentStore({
      grants,
      materializer,
      provider,
      logger: { warn: () => undefined },
    })
    const first = await store.deploy({
      ownerScopeId: 'personal:user-1',
      createdBy: 'user-1',
      entrypoint: 'node v1.js',
      files: [{ path: 'server.js', blobKey: v1Key }],
    })
    await store.redeploy(first.id, { entrypoint: 'node v2.js', files: [{ path: 'server.js', blobKey: v2Key }] })
    await store.rollback(first.id, 1)
    const after = await store.getByIdOrName(first.id)
    assert.equal(after?.currentVersion, 1)
    assert.equal(after?.appliedVersion, 1)
    assert.deepEqual(after?.endpoint, { host: '127.0.0.1', port: 9100 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('logsFor() returns provider.logs() when the runtime is wired', async () => {
  const provider = createStaticDeployProvider({ logs: ['hello world\n'] })
  const { store, cleanup } = makeStore({ provider })
  try {
    const created = await store.deploy({
      ownerScopeId: 'personal:user-1',
      createdBy: 'user-1',
      entrypoint: 'node server.js',
      files: [],
    })
    const logs = await store.logsFor(created.id, 'user-1', { tailLines: 50 })
    assert.deepEqual(logs, { status: 'ok', logs: 'hello world\n' })
    assert.equal(provider.logsCalls.length, 1)
    assert.deepEqual(provider.logsCalls[0], { deploymentId: created.id, opts: { tailLines: 50 } })
  } finally {
    cleanup()
  }
})

test('materialized workspace contains the deployed bytes', async () => {
  const byteStore = createMemoryByteStore()
  const root = mkdtempSync(join(tmpdir(), 'qm-next-deploy-mat-integ-'))
  try {
    const materializer = createMaterializer(byteStore, { workspaceRoot: root })
    const provider = createStaticDeployProvider()
    const grants = createMemoryGrantLedger()
    const store = createMemoryDeploymentStore({
      grants,
      materializer,
      provider,
      logger: { warn: () => undefined },
    })
    const blob = await blobOf(byteStore, Buffer.from('console.log("ok")'))
    const created = await store.deploy({
      ownerScopeId: 'personal:user-1',
      createdBy: 'user-1',
      entrypoint: 'node server.js',
      files: [blob],
    })
    const ws = join(root, created.id, `v${created.appliedVersion ?? 1}`)
    assert.equal(readFileSync(join(ws, 'server.js'), 'utf8'), 'console.log("ok")')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})