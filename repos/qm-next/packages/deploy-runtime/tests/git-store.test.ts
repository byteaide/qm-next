/**
 * DeployGitStore tests (cluster 1 phase 2). Round-trips commits
 * through a real `git` CLI against bare repos under a temp repoRoot.
 * Skipped when no usable `git` binary answers `--version` (same guard
 * pattern as the pg-boss sink tests).
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test as nodeTest } from 'node:test'
import { createMemoryByteStore } from '@qm/store'
import type { DeployGitInputFile } from '@qm/types'
import { createDeployGitStore, type GitArchiveStore } from '../src/index.ts'
import type { DeployGitArchive } from '@qm/types'

const run = promisify(execFile)

async function gitAvailable(): Promise<boolean> {
  for (const bin of ['git', '/usr/bin/git', '/opt/homebrew/bin/git']) {
    try {
      await run(bin, ['--version'])
      return true
    } catch {
      continue
    }
  }
  return false
}

const gitOk = await gitAvailable()

function makeStore(opts: { repoRoot: string; archiveStore?: GitArchiveStore; archiveBytes?: ReturnType<typeof createMemoryByteStore> }) {
  return createDeployGitStore({
    repoRoot: opts.repoRoot,
    ...(opts.archiveStore ? { archiveStore: opts.archiveStore } : {}),
    ...(opts.archiveBytes ? { archiveBytes: opts.archiveBytes } : {}),
  })
}

function filesOf(entries: Record<string, string>): DeployGitInputFile[] {
  return Object.entries(entries).map(([path, data]) => ({ path, data }))
}

nodeTest('commit + treeOf + filesOf round-trip', { skip: !gitOk }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-next-git-store-'))
  try {
    const store = makeStore({ repoRoot: join(root, 'repos') })
    const v1 = await store.commit({
      deploymentId: 'd-1',
      version: 1,
      files: filesOf({ 'server.js': 'v1', 'package.json': '{"name":"app"}' }),
      message: 'first',
    })
    assert.match(v1, /^[0-9a-f]{40}$/)

    const tree = await store.treeOf('d-1', v1)
    assert.deepEqual(
      tree.map((f) => f.path),
      ['package.json', 'server.js'],
    )
    assert.equal(tree[1]!.size, 2)

    const files = await store.filesOf('d-1', v1)
    assert.equal(files.length, 2)
    const server = files.find((f) => f.path === 'server.js')!
    assert.equal(Buffer.from(server.data).toString('utf8'), 'v1')

    const v2 = await store.commit({
      deploymentId: 'd-1',
      version: 2,
      files: filesOf({ 'server.js': 'v2', 'package.json': '{"name":"app"}' }),
      parent: v1,
      message: 'second',
    })
    assert.notEqual(v2, v1)

    const diff = await store.diff('d-1', v1, v2)
    assert.equal(diff.modified.length, 1)
    assert.equal(diff.modified[0]!.path, 'server.js')
    assert.deepEqual(diff.added, [])
    assert.deepEqual(diff.deleted, [])

    const firstDiff = await store.diff('d-1', undefined, v1)
    assert.equal(firstDiff.added.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

nodeTest('commit without changes returns the parent sha', { skip: !gitOk }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-next-git-store-'))
  try {
    const store = makeStore({ repoRoot: join(root, 'repos') })
    const v1 = await store.commit({
      deploymentId: 'd-2',
      version: 1,
      files: filesOf({ 'server.js': 'same' }),
    })
    const v2 = await store.commit({
      deploymentId: 'd-2',
      version: 2,
      files: filesOf({ 'server.js': 'same' }),
      parent: v1,
    })
    assert.equal(v2, v1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

nodeTest('ref set/delete/get round-trip', { skip: !gitOk }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-next-git-store-'))
  try {
    const store = makeStore({ repoRoot: join(root, 'repos') })
    const sha = await store.commit({
      deploymentId: 'd-3',
      version: 1,
      files: filesOf({ 'a.txt': 'a' }),
    })
    await store.setRef('d-3', 'refs/heads/current', sha)
    assert.equal(await store.refOf('d-3', 'refs/heads/current'), sha)
    assert.equal(await store.refOf('d-3', 'refs/heads/missing'), null)
    await store.deleteRef('d-3', 'refs/heads/current')
    assert.equal(await store.refOf('d-3', 'refs/heads/current'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

nodeTest('bundle carries the committed tree', { skip: !gitOk }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-next-git-store-'))
  try {
    const store = makeStore({ repoRoot: join(root, 'repos') })
    const sha = await store.commit({
      deploymentId: 'd-4',
      version: 1,
      files: filesOf({ 'b.txt': 'bundle-me' }),
    })
    const bundle = await store.bundle('d-4', sha)
    assert.ok(bundle.byteLength > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

nodeTest('unsafe paths are rejected', { skip: !gitOk }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-next-git-store-'))
  try {
    const store = makeStore({ repoRoot: join(root, 'repos') })
    await assert.rejects(
      store.commit({
        deploymentId: 'd-5',
        version: 1,
        files: [{ path: '../escape', data: 'pwn' }],
      }),
      /invalid deploy git path/,
    )
    await assert.rejects(
      store.commit({
        deploymentId: 'd-5',
        version: 1,
        files: [{ path: '.git/config', data: 'pwn' }],
      }),
      /invalid deploy git path/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

nodeTest('archive store restores the repo for a fresh process', { skip: !gitOk }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-next-git-store-'))
  try {
    const archives = new Map<string, DeployGitArchive>()
    const archiveStore: GitArchiveStore = {
      get: async (key) => archives.get(key) ?? null,
      put: async (key, value) => {
        archives.set(key, value)
      },
      delete: async (key) => {
        archives.delete(key)
      },
    }
    const repoRoot = join(root, 'repos')
    const store1 = makeStore({ repoRoot, archiveStore })
    const sha = await store1.commit({
      deploymentId: 'd-6',
      version: 1,
      files: filesOf({ 'c.txt': 'archived' }),
    })
    assert.ok(archives.has('d-6'))

    rmSync(repoRoot, { recursive: true, force: true })

    const store2 = makeStore({ repoRoot, archiveStore })
    const tree = await store2.treeOf('d-6', sha)
    assert.equal(tree.length, 1)
    assert.equal(tree[0]!.path, 'c.txt')

    const files = await store2.filesOf('d-6', sha)
    assert.equal(Buffer.from(files[0]!.data).toString('utf8'), 'archived')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})