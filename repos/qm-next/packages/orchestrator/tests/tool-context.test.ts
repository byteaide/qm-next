/**
 * Sandbox-backed ToolContext tests over a fake Sandbox: the P1 face
 * (execute/read/write/computer/background) plus the graceful-unavailable
 * answers every M3 surface must return so harness tools stay honest.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecOptions, ProcessState, Sandbox, SandboxHandle } from '@qm/types'
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

test('background: starts register into the process registrar and terminal reads mark exited', async () => {
  const registered: Array<{ processId: string; scopeId: string; kind: string; command: string; ttlMs: number }> = []
  const marked: Array<{ processId: string; status: string }> = []
  let readStatus: ProcessState = { state: 'running' }
  const sandbox = fakeSandbox({
    profile: { backend: 'fake', writablePersistence: 'resident_disk', processSessions: true },
    startProcess: async (_handle, command) => ({ processId: `p-${command.length}` }),
    readProcess: async (_handle, processId) => ({
      chunks: `out of ${processId}`,
      cursor: 11,
      status: readStatus,
    }),
    signalProcess: async () => undefined,
    writeStdin: async () => undefined,
    listProcesses: async () => [],
  })
  const ctx = createSandboxToolContext({
    sandbox,
    handle: fakeHandle(),
    scopeId: 'org:test',
    processRegistrar: {
      register: async (rec) => {
        registered.push(rec)
        return rec
      },
      markStatus: async (processId, status) => {
        marked.push({ processId, status })
      },
    },
  })
  const start = await ctx.backgroundStart('npm run dev')
  assert.deepEqual(registered, [
    { processId: 'p-11', scopeId: 'org:test', kind: 'background', command: 'npm run dev', ttlMs: 1_800_000 },
  ])
  assert.equal(marked.length, 0)

  readStatus = { state: 'exited', code: 0 }
  await ctx.backgroundPoll('p-11')
  assert.deepEqual(marked, [{ processId: 'p-11', status: 'exited' }])

  marked.length = 0
  await ctx.backgroundStop('p-11')
  assert.deepEqual(marked, [{ processId: 'p-11', status: 'exited' }])
  assert.equal(start.processId, 'p-11')
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

function fakeLedger() {
  const rows = new Map<string, string>()
  return {
    rows,
    begin: async (runId: string, attempt: number, callIndex: number) => {
      const output = rows.get(`${runId}:${attempt}:${callIndex}`)
      return output !== undefined ? { cached: true, output } : { cached: false }
    },
    record: async (runId: string, attempt: number, callIndex: number, output: string) => {
      rows.set(`${runId}:${attempt}:${callIndex}`, output)
    },
  }
}

test('replay: execute/read cache through the ledger keyed by (runId, attempt, callIndex) (#28)', async () => {
  const ledger = fakeLedger()
  const sandbox = fakeSandbox({
    run: async (_handle, command) => {
      sandbox.runs.push({ command, opts: undefined })
      if (command === 'boom') return { stdout: '', stderr: 'nope', code: 7, timedOut: false }
      return { stdout: `ran ${command}`, stderr: '', code: 0, timedOut: false }
    },
  })
  const deps = {
    sandbox,
    handle: fakeHandle(),
    scopeId: 'org:test' as const,
    runId: 'run-1',
    attempt: 2,
    ledger,
  }

  const first = createSandboxToolContext(deps)
  const liveExec = await first.execute('ls -la')
  assert.deepEqual(liveExec, { stdout: 'ran ls -la', stderr: '', code: 0, timedOut: false })
  assert.equal((await first.execute('boom')).code, 7)
  const liveRead = await first.read('notes.md')
  assert.deepEqual(liveRead, { content: 'hello notes', sourceScopeId: 'org:test' })
  const afterLive = sandbox.runs.length

  const replay = createSandboxToolContext(deps)
  const cachedExec = await replay.execute('ls -la')
  assert.deepEqual(cachedExec, liveExec, 'same (runId, attempt, callIndex) replays the recorded output')
  const afterCachedExec = sandbox.runs.length
  assert.equal(afterCachedExec, afterLive, 'cached execute never touches the sandbox')

  const retried = await replay.execute('boom')
  assert.equal(retried.code, 7)
  assert.equal(sandbox.runs.length, afterCachedExec + 1, 'failed calls always re-execute')

  const cachedRead = await replay.read('notes.md')
  assert.deepEqual(cachedRead, liveRead)
  const miss = await replay.read('nope.md')
  assert.equal(miss.content, null)
  assert.equal(ledger.rows.size, 2, 'only successful calls are recorded')
})

test('replay: a context without runId executes live every call (#28)', async () => {
  const ledger = fakeLedger()
  const sandbox = fakeSandbox()
  const ctx = createSandboxToolContext({ sandbox, handle: fakeHandle(), scopeId: 'org:test', ledger })
  await ctx.execute('ls -la')
  await ctx.execute('ls -la')
  assert.equal(sandbox.runs.length, 2, 'no runId means no caching')
  assert.equal(ledger.rows.size, 0)
})

test('guidance: soulRead answers unavailable without the seam, composed with it', () => {
  const sandbox = fakeSandbox()
  const bare = createSandboxToolContext({ sandbox, handle: fakeHandle(), scopeId: 'org:test' })
  const bareView = bare.soulRead()
  assert.equal('effectiveSoul' in bareView, false)
  if ('effectiveSoul' in bareView) return
  assert.equal(bareView.code, 'control_unavailable')
  const ctx = createSandboxToolContext({
    sandbox,
    handle: fakeHandle(),
    scopeId: 'personal:u1',
    soul: {
      read: () => ({ effectiveSoul: 'org policy\n\npersonal voice', soul: 'personal voice', soulVersion: 3 }),
      write: async () => ({ ok: true, version: 4 }),
    },
  })
  const view = ctx.soulRead()
  assert.equal('effectiveSoul' in view, true)
  if (!('effectiveSoul' in view)) return
  assert.equal(view.effectiveSoul, 'org policy\n\npersonal voice')
  assert.equal(view.soulVersion, 3)
})

test('guidance: soulWrite denies org scopes (admin surface owns org policy) and writes elsewhere', async () => {
  const writes: string[] = []
  const sandbox = fakeSandbox()
  const orgCtx = createSandboxToolContext({
    sandbox,
    handle: fakeHandle(),
    scopeId: 'org:acme',
    soul: {
      read: () => ({ effectiveSoul: '', soul: null, soulVersion: 0 }),
      write: async (content) => {
        writes.push(content)
        return { ok: true, version: writes.length }
      },
    },
  })
  const denied = await orgCtx.soulWrite('try')
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.equal(denied.code, 'soul_update_denied')
  assert.equal(writes.length, 0, 'org denial happens before the store is touched')

  const personalCtx = createSandboxToolContext({
    sandbox,
    handle: fakeHandle(),
    scopeId: 'personal:u1',
    soul: {
      read: () => ({ effectiveSoul: '', soul: null, soulVersion: 0 }),
      write: async (content) => {
        writes.push(content)
        return { ok: true, version: writes.length }
      },
    },
  })
  const allowed = await personalCtx.soulWrite('my voice')
  assert.deepEqual(allowed, { ok: true, version: 1 })
  assert.deepEqual(writes, ['my voice'])
})

test('control surfaces: ports execute, absent ports keep the honest unavailable answers', async () => {
  const created: unknown[] = []
  const ctx = createSandboxToolContext({
    sandbox: fakeSandbox(),
    handle: fakeHandle(),
    scopeId: 'org:test',
    actorId: 'person:ada',
    crons: {
      cronCreate: async (req) => {
        created.push(req)
        return { ok: true, cron: { id: 'cron-1', ownerScopeId: 'org:test', owner: 'person:ada', createdBy: 'person:ada', enabled: true, createdAt: 1, schedule: {} } as never }
      },
      cronList: async () => ({ crons: [], visible: [] }),
      cronGet: async () => ({ ok: false, code: 'not_found', message: 'no cron x' }),
      cronRuns: async () => ({ ok: false, code: 'not_found', message: 'no cron x' }),
      cronPatch: async () => ({ ok: false, code: 'forbidden', message: 'not your cron' }),
      cronDelete: async () => ({ ok: true }),
      cronSetEnabled: async () => ({ ok: false, code: 'forbidden', message: 'not your cron' }),
      cronRun: async () => ({ ok: true }),
      cronRetarget: async () => ({ ok: false, code: 'unknown_destination', message: 'nope' }),
    },
    webhooks: {
      webhookCreate: async () => ({ ok: true, webhook: { id: 'wh-1' } as never, url: '/v1/webhooks/incoming/wh-1' }),
      webhookList: async () => [],
      webhookDisable: async () => ({ ok: true }),
    },
    mcp: {
      mcpToolDefs: () => [{ name: 'srv1_search', serverId: 'srv1', remoteName: 'search', description: '', inputSchema: {}, readOnly: true }],
      callMcpTool: async (name) => `called ${name}`,
    },
    share: {
      shareArtifact: async () => ({ ok: true, verb: 'share', type: 'file', id: 'f1', target: { scope: 'org:test', label: 'org' }, permission: 'read' }),
    },
  })

  const made = await ctx.cronCreate({ schedule: { everyMs: 1000 }, action: 'ping' })
  assert.equal(made.ok, true)
  assert.deepEqual(created, [{ schedule: { everyMs: 1000 }, action: 'ping' }])
  const listed = await ctx.cronList()
  assert.equal('crons' in listed, true, 'wired port answers the list, not CONTROL_UNAVAILABLE')
  if ('crons' in listed) assert.deepEqual(listed.crons, [])
  assert.equal((await ctx.cronGet('x')).ok, false)
  assert.equal((await ctx.cronRun('cron-1')).ok, true)
  const webhook = await ctx.webhookCreate({ action: 'relay', verification: { scheme: 'github', secret: 'k' } })
  assert.equal(webhook.ok, true)
  assert.deepEqual(ctx.mcpToolDefs().map((t) => t.name), ['srv1_search'])
  assert.equal(await ctx.callMcpTool('srv1_search', {}), 'called srv1_search')
  const shared = await ctx.shareArtifact({ type: 'file', id: 'f1', scope: 'org' })
  assert.equal(shared.ok, true)

  const bare = createSandboxToolContext({ sandbox: fakeSandbox(), handle: fakeHandle(), scopeId: 'org:test' })
  const unavailableList = await bare.cronList()
  assert.equal('ok' in unavailableList, true)
  if ('ok' in unavailableList) assert.equal(unavailableList.code, 'control_unavailable')
  const bareWebhooks = await bare.webhookList()
  assert.equal('ok' in bareWebhooks, true)
  assert.deepEqual(bare.mcpToolDefs(), [])
  await assert.rejects(bare.callMcpTool('x', {}), /MCP tools is not available/)
  await assert.rejects(bare.shareArtifact({ type: 'file', id: 'f1' }), /artifact sharing is not available/)
})

test('shared files: read resolves granted handles — text inline, ambiguous refused, missing falls through', async () => {
  const materialized: Record<string, Uint8Array> = {}
  const sandbox = fakeSandbox({
    readFile: async (_handle, path) => (path === 'workspace-local.md' ? 'from the sandbox' : null),
    writeFileBytes: async (_handle, path, data) => {
      materialized[path] = data
    },
  })
  const handles = [
    { handlePath: 'shared/report.md', ownerScopeId: 'personal:ada', ownerPath: 'f1', permission: 'read' as const },
    { handlePath: 'shared/dup.md', ownerScopeId: 'personal:ada', ownerPath: 'dup-a', permission: 'read' as const },
    { handlePath: 'shared/dup.md', ownerScopeId: 'personal:bob', ownerPath: 'dup-b', permission: 'read' as const },
  ]
  const ctx = createSandboxToolContext({
    sandbox,
    handle: fakeHandle(),
    scopeId: 'org:test',
    sharedFiles: {
      handles: async () => handles,
      readBytes: async (ref) => Buffer.from(`bytes of ${ref}`, 'utf8'),
    },
  })

  const text = await ctx.read('shared/report.md')
  assert.deepEqual(text, { content: 'bytes of f1', sourceScopeId: 'personal:ada' })

  const ambiguous = await ctx.read('shared/dup.md')
  assert.match(String(ambiguous.content), /ambiguous shared handle/)
  assert.equal(ambiguous.sourceScopeId, null)

  const missing = await ctx.read('shared/nope.md')
  assert.deepEqual(missing, { content: null, sourceScopeId: null }, 'unmatched shared/ paths fall through to the sandbox')

  const local = await ctx.read('workspace-local.md')
  assert.deepEqual(local, { content: 'from the sandbox', sourceScopeId: 'org:test' })

  const binaryCtx = createSandboxToolContext({
    sandbox: fakeSandbox({
      writeFileBytes: async (_handle, path, data) => {
        materialized[path] = data
      },
    }),
    handle: fakeHandle(),
    scopeId: 'org:test',
    sharedFiles: {
      handles: async () => [{ handlePath: 'shared/blob.bin', ownerScopeId: 'personal:ada', ownerPath: 'binary', permission: 'read' }],
      readBytes: async () => new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
    },
  })
  const binary = await binaryCtx.read('shared/blob.bin')
  assert.match(String(binary.content), /binary file materialized into the sandbox at blob\.bin/)
  assert.equal(binary.sourceScopeId, 'personal:ada')
  assert.ok(materialized['blob.bin'])
})
