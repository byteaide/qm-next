/**
 * Process reconcile tests (parity 16.0): running records whose backing
 * process has exited (or vanished from the sandbox) get flipped to
 * `exited` so the registry reflects reality after a scope restart.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProcessSandbox, ProcessSession, SandboxHandle } from '@qm/types'
import { createMemoryProcessRegistry } from '../src/index.ts'
import { reconcileProcesses } from '../src/index.ts'

function fakeSandbox(live: ProcessSession[]): ProcessSandbox {
  return {
    profile: { backend: 'fake', writablePersistence: 'snapshot_to_workspace', processSessions: true },
    async provision() {
      return { id: 'vm', rootDir: '/workspace' } as SandboxHandle
    },
    async teardown() {},
    async run() {
      throw new Error('unused')
    },
    async readFile() {
      return null
    },
    async writeFile() {},
    async writeFileBytes() {},
    async readFileBytes() {
      return null
    },
    async listDir() {
      return []
    },
    async removeDir() {},
    async startProcess() {
      return { processId: 'unused' }
    },
    async readProcess() {
      throw new Error('unused')
    },
    async writeStdin() {},
    async signalProcess() {},
    async listProcesses() {
      return live
    },
  }
}

test('reconcile flips running records whose process exited or vanished', async () => {
  const reg = createMemoryProcessRegistry()
  await reg.register({ processId: 'a', scopeId: 's', kind: 'build', command: 'x', ttlMs: 60_000 })
  await reg.register({ processId: 'b', scopeId: 's', kind: 'background', command: 'y', ttlMs: 60_000 })
  await reg.register({ processId: 'c', scopeId: 's', kind: 'dev-server', command: 'z', ttlMs: 60_000 })
  await reg.markStatus('c', 'exited') // already terminal — should be left alone

  const sandbox = fakeSandbox([
    { processId: 'a', command: 'x', startedAt: 0, status: { state: 'running' } },
    { processId: 'b', command: 'y', startedAt: 0, status: { state: 'exited', code: 0 } },
  ])

  const handle = { id: 'vm', rootDir: '/workspace' } as SandboxHandle
  await reconcileProcesses(sandbox, handle, reg, 's')

  assert.equal((await reg.get('a'))!.status, 'running', 'still running stays running')
  assert.equal((await reg.get('b'))!.status, 'exited', 'exited process is flipped to exited')
  assert.equal((await reg.get('c'))!.status, 'exited', 'already exited untouched')
})

test('reconcile flips running records whose process vanished from the sandbox', async () => {
  const reg = createMemoryProcessRegistry()
  await reg.register({ processId: 'a', scopeId: 's', kind: 'build', command: 'x', ttlMs: 60_000 })
  await reg.register({ processId: 'b', scopeId: 's', kind: 'background', command: 'y', ttlMs: 60_000 })

  const sandbox = fakeSandbox([
    { processId: 'a', command: 'x', startedAt: 0, status: { state: 'running' } },
    // processId 'b' is absent — should still be flipped
  ])

  const handle = { id: 'vm', rootDir: '/workspace' } as SandboxHandle
  await reconcileProcesses(sandbox, handle, reg, 's')

  assert.equal((await reg.get('a'))!.status, 'running')
  assert.equal((await reg.get('b'))!.status, 'exited', 'absent from the live list counts as exited')
})

test('reconcile is a no-op when no records are running', async () => {
  const reg = createMemoryProcessRegistry()
  await reg.register({ processId: 'a', scopeId: 's', kind: 'build', command: 'x', ttlMs: 60_000 })
  await reg.markStatus('a', 'exited')

  const sandbox = fakeSandbox([])
  const handle = { id: 'vm', rootDir: '/workspace' } as SandboxHandle
  await reconcileProcesses(sandbox, handle, reg, 's')

  // Confirm no throws and the entry is left at its terminal status.
  assert.equal((await reg.get('a'))!.status, 'exited')
})