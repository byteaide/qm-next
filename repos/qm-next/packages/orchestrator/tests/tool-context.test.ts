/**
 * Sandbox-backed ToolContext tests over a fake Sandbox: the P1 face
 * (execute/read/write/computer/background) plus the graceful-unavailable
 * answers every M3 surface must return so harness tools stay honest.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecOptions, Sandbox, SandboxHandle } from '@qm/types'
import { createSandboxToolContext } from '../src/index.ts'

function fakeHandle(): SandboxHandle {
  return { id: 'sbx-1', rootDir: '/workspace' }
}

interface RunCall {
  command: string
  opts: ExecOptions | undefined
}

function fakeSandbox(over: Partial<Sandbox> = {}): Sandbox & { runs: RunCall[] } {
  const runs: RunCall[] = []
  const sandbox: Sandbox & { runs: RunCall[] } = {
    runs,
    profile: { backend: 'fake', writablePersistence: 'resident_disk', processSessions: false },
    provision: async () => fakeHandle(),
    run: async (_handle, command, opts) => {
      runs.push({ command, opts })
      return { stdout: `ran ${command}`, stderr: '', code: 0, timedOut: false }
    },
    readFile: async (_handle, path) => (path === 'notes.md' ? 'hello notes' : null),
    writeFile: async (_handle, _path, _data) => undefined,
    writeFileBytes: async () => undefined,
    readFileBytes: async () => null,
    listDir: async () => [],
    removeDir: async () => undefined,
    teardown: async () => undefined,
    reapDeepIdle: async () => ({ reaped: 0 }),
    ...over,
  }
  return sandbox
}

test('execute: commands run through the sandbox with default and ceiling-capped timeouts', async () => {
  const sandbox = fakeSandbox()
  const ctx = createSandboxToolContext({ sandbox, handle: fakeHandle(), scopeId: 'org:test' })
  const r = await ctx.execute('ls -la')
  assert.equal(r.code, 0)
  assert.equal(r.stdout, 'ran ls -la')
  assert.deepEqual(sandbox.runs, [{ command: 'ls -la', opts: { timeoutMs: 120_000 } }])

  await ctx.execute('sleep forever', { timeoutSeconds: 30 })
  assert.deepEqual(sandbox.runs[1], { command: 'sleep forever', opts: { timeoutMs: 30_000 } })

  const capped = createSandboxToolContext({
    sandbox,
    handle: fakeHandle(),
    scopeId: 'org:test',
    execTimeoutCeilingMs: 10_000,
  })
  await capped.execute('big job', { timeoutSeconds: 600 })
  assert.deepEqual(sandbox.runs[2], { command: 'big job', opts: { timeoutMs: 10_000 } })
})

test('execute: scratch, owner-auth and reach targets are refused with honest errors', async () => {
  const ctx = createSandboxToolContext({ sandbox: fakeSandbox(), handle: fakeHandle(), scopeId: 'org:test' })
  await assert.rejects(ctx.execute('x', { scratch: true }), /scratch execution is not available/)
  await assert.rejects(ctx.execute('x', { ownerAuth: true }), /owner-auth execution is not available/)
  await assert.rejects(ctx.execute('x', { reachTarget: '#room' }), /reach execution is not available/)
})

test('read and write: sandbox file ops with path escape guards', async () => {
  const sandbox = fakeSandbox()
  const ctx = createSandboxToolContext({ sandbox, handle: fakeHandle(), scopeId: 'org:test' })
  const read = await ctx.read('notes.md')
  assert.deepEqual(read, { content: 'hello notes', sourceScopeId: 'org:test' })
  const missing = await ctx.read('nope.md')
  assert.deepEqual(missing, { content: null, sourceScopeId: null })
  const write = await ctx.write('out.md', 'body')
  assert.deepEqual(write, { shared: [] })
  await assert.rejects(ctx.read('../etc/passwd'), /paths must stay inside the workspace/)
  await assert.rejects(ctx.write('a/../b.md', 'x'), /paths must stay inside the workspace/)
})

test('computer status: sandbox status passes through; absence falls back; restart without support is refused', async () => {
  const sandbox = fakeSandbox({
    computerStatus: async () => ({ machine: 'up', guestResponsive: true }),
  })
  const ctx = createSandboxToolContext({ sandbox, handle: fakeHandle(), scopeId: 'org:test' })
  assert.deepEqual(await ctx.computerStatus(), { machine: 'up', guestResponsive: true })
  await assert.rejects(ctx.restartComputer(), /does not support computer restart/)

  const bare = createSandboxToolContext({ sandbox: fakeSandbox(), handle: fakeHandle(), scopeId: 'org:test' })
  assert.deepEqual(await bare.computerStatus(), { machine: 'unknown', guestResponsive: false })
})

test('background: process-session backends map start/poll/list; watch is refused', async () => {
  const sandbox = fakeSandbox({
    profile: { backend: 'fake', writablePersistence: 'resident_disk', processSessions: true },
    startProcess: async (_handle, command) => ({ processId: `p-${command.length}` }),
    readProcess: async (_handle, processId) => ({
      chunks: `out of ${processId}`,
      cursor: 11,
      status: { state: 'running' },
    }),
    signalProcess: async () => undefined,
    writeStdin: async () => undefined,
    listProcesses: async () => [
      { processId: 'p-1', command: 'npm run dev', startedAt: 5, status: { state: 'running' } },
    ],
  })
  const ctx = createSandboxToolContext({ sandbox, handle: fakeHandle(), scopeId: 'org:test' })
  const start = await ctx.backgroundStart('npm run dev')
  assert.deepEqual(start, {
    processId: 'p-11',
    output: 'out of p-11',
    cursor: 11,
    status: { state: 'running' },
    reattached: false,
  })
  const poll = await ctx.backgroundPoll('p-11', { waitSeconds: 2 })
  assert.deepEqual(poll, { processId: 'p-11', chunks: 'out of p-11', cursor: 11, status: { state: 'running' } })
  const jobs = await ctx.backgroundList()
  assert.deepEqual(jobs, [
    {
      processId: 'p-1',
      command: 'npm run dev',
      status: { state: 'running' },
      registryStatus: 'running',
      startedAt: 5,
    },
  ])
  await assert.rejects(ctx.backgroundWatch('p-1'), /does not support background watch/)

  const bare = createSandboxToolContext({ sandbox: fakeSandbox(), handle: fakeHandle(), scopeId: 'org:test' })
  await assert.rejects(bare.backgroundStart('x'), /does not support background processes/)
})

test('unavailable surfaces answer gracefully so tools render honest messages', async () => {
  const ctx = createSandboxToolContext({ sandbox: fakeSandbox(), handle: fakeHandle(), scopeId: 'org:test' })
  assert.equal(await ctx.memorySearch('q'), null)
  assert.equal(await ctx.memoryRead(), null)
  assert.deepEqual(await ctx.history('q', 5), [])
  assert.deepEqual(ctx.mcpToolDefs(), [])
  await assert.rejects(ctx.publish({ title: 't', files: [] } as never), /publishing is not available/)
  const crons = (await ctx.cronList()) as { ok: boolean; code: string }
  assert.equal(crons.ok, false)
  assert.equal(crons.code, 'control_unavailable')
  const silent = await ctx.staySilent('nothing to add')
  assert.deepEqual(silent, { ok: true, message: 'noted' })
  const post = await ctx.post('hello')
  assert.equal(post.ok, false)
})
