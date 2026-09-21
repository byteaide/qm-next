/**
 * Materialize hook tests (cluster 1 MVP). Round-trips DeployFile
 * entries through `DurableByteStore.open()` and confirms the bytes land
 * at the right paths in a workspace directory. The default
 * `workspaceRoot` lives under `os.tmpdir()`; tests pass an isolated
 * root via `MaterializerOptions` to keep artifacts off the host.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMemoryByteStore } from '@qm/store'
import type { DeployFile } from '@qm/types'
import { createMaterializer } from '../src/index.ts'

test('materialize writes each blob to its target path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-next-deploy-mat-'))
  try {
    const byteStore = createMemoryByteStore()
    const { blobKey: serverKey } = await byteStore.put(Buffer.from('console.log("hello")'))
    const { blobKey: pkgKey } = await byteStore.put(Buffer.from('{"name":"app","version":"1.0.0"}'))
    const files: DeployFile[] = [
      { path: 'server.js', blobKey: serverKey },
      { path: 'package.json', blobKey: pkgKey },
    ]
    const materializer = createMaterializer(byteStore, { workspaceRoot: root })
    const dir = await materializer.materialize({
      deploymentId: 'd-1',
      version: 1,
      entrypoint: 'node server.js',
      files,
    })
    assert.equal(readFileSync(join(dir, 'server.js'), 'utf8'), 'console.log("hello")')
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), '{"name":"app","version":"1.0.0"}')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('materialize creates intermediate directories for nested paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-next-deploy-mat-'))
  try {
    const byteStore = createMemoryByteStore()
    const { blobKey } = await byteStore.put(Buffer.from('nested'))
    const files: DeployFile[] = [{ path: 'src/server/index.js', blobKey }]
    const materializer = createMaterializer(byteStore, { workspaceRoot: root })
    const dir = await materializer.materialize({
      deploymentId: 'd-2',
      version: 1,
      entrypoint: 'node src/server/index.js',
      files,
    })
    assert.equal(readFileSync(join(dir, 'src/server/index.js'), 'utf8'), 'nested')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('materialize throws when a blob is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-next-deploy-mat-'))
  try {
    const byteStore = createMemoryByteStore()
    const files: DeployFile[] = [{ path: 'server.js', blobKey: 'files/0000000000000000000000000000000000000000000000000000000000000000' }]
    const materializer = createMaterializer(byteStore, { workspaceRoot: root })
    await assert.rejects(
      materializer.materialize({ deploymentId: 'd-3', version: 1, entrypoint: 'node server.js', files }),
      /blob not found/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('materialize rejects path traversal attempts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-next-deploy-mat-'))
  try {
    const byteStore = createMemoryByteStore()
    const { blobKey } = await byteStore.put(Buffer.from('pwn'))
    const materializer = createMaterializer(byteStore, { workspaceRoot: root })
    await assert.rejects(
      materializer.materialize({
        deploymentId: 'd-4',
        version: 1,
        entrypoint: 'node',
        files: [{ path: '../escape', blobKey }],
      }),
      /unsafe file path/,
    )
    await assert.rejects(
      materializer.materialize({
        deploymentId: 'd-4',
        version: 1,
        entrypoint: 'node',
        files: [{ path: '/abs/path', blobKey }],
      }),
      /unsafe file path/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('materialize keeps per-version workspaces disjoint for rollback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-next-deploy-mat-'))
  try {
    const byteStore = createMemoryByteStore()
    const { blobKey: v1Key } = await byteStore.put(Buffer.from('v1-bytes'))
    const { blobKey: v2Key } = await byteStore.put(Buffer.from('v2-bytes'))
    const materializer = createMaterializer(byteStore, { workspaceRoot: root })
    const dirV1 = await materializer.materialize({
      deploymentId: 'd-5',
      version: 1,
      entrypoint: 'node',
      files: [{ path: 'app.js', blobKey: v1Key }],
    })
    const dirV2 = await materializer.materialize({
      deploymentId: 'd-5',
      version: 2,
      entrypoint: 'node',
      files: [{ path: 'app.js', blobKey: v2Key }],
    })
    assert.notEqual(dirV1, dirV2)
    assert.equal(readFileSync(join(dirV1, 'app.js'), 'utf8'), 'v1-bytes')
    assert.equal(readFileSync(join(dirV2, 'app.js'), 'utf8'), 'v2-bytes')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})