import assert from 'node:assert/strict'
import { test } from 'node:test'
import { supportsProcessSessions, type ProcessSandbox } from '@qm/types'
import {
  createLocalSandbox,
  forceThroughProxyEnv,
  killableScript,
  killScript,
  localContainerName,
  nonInteractiveShellPrefix,
  pgidMarkerPath,
  proxyExportPrefix,
  redactCommand,
  type DockerExec,
} from '../src/index.ts'
import { parseTar } from '../src/tar.ts'

const LIST_ID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789'

interface DaemonCall {
  path: string
  body: unknown
}

interface ExecResponder {
  match(cmd: string): boolean
  respond(cmd: string): Promise<{ code: number; stdout: string; stderr: string }>
}

function createBackend(opts: { imageMissing?: boolean; failPrep?: boolean } = {}) {
  const files = new Map<string, Uint8Array>()
  const docker: string[][] = []
  const daemonCalls: DaemonCall[] = []
  const responders: ExecResponder[] = []
  let containerRunning = false
  let containerExists = false
  let volumeExists = false
  const ok = { code: 0, stdout: 'ok', stderr: '' }

  if (opts.failPrep) {
    responders.push({
      match: (cmd) => cmd.includes('mkdir -p'),
      respond: async () => ({ code: 1, stdout: '', stderr: 'prep refused' }),
    })
  }

  responders.push({
    match: (cmd) => cmd.includes('tar -xf'),
    respond: async (cmd) => {
      const root = /cd '([^']+)'/.exec(cmd)?.[1] ?? '/root/workspace'
      const name = /tar -xf '([^']+)'/.exec(cmd)?.[1]
      if (!name) return { code: 1, stdout: '', stderr: 'no tar name' }
      const raw = files.get(`${root}/${name}`)
      if (!raw) return { code: 1, stdout: '', stderr: `missing tar ${name}` }
      for (const entry of await parseTar(raw)) files.set(`${root}/${entry.path}`, entry.data)
      files.delete(`${root}/${name}`)
      return { code: 0, stdout: '', stderr: '' }
    },
  })

  responders.push({
    match: (cmd) => cmd.includes('agent-proc') && cmd.includes('mkfifo'),
    respond: async () => ({ code: 0, stdout: 'OK\n', stderr: '' }),
  })

  const dockerExec: DockerExec = async (args) => {
    docker.push(args)
    const [verb, sub] = args
    if (verb === 'version') return { code: 0, stdout: 'Docker version 27', stderr: '' }
    if (verb === 'image') {
      return opts.imageMissing
        ? { code: 1, stdout: '', stderr: 'no such image' }
        : { code: 0, stdout: 'sha256:img1', stderr: '' }
    }
    if (verb === 'inspect') {
      return containerExists && containerRunning
        ? { code: 0, stdout: 'true sha256:img1', stderr: '' }
        : { code: 1, stdout: '', stderr: 'no such object' }
    }
    if (verb === 'port') return { code: 0, stdout: '127.0.0.1:32777\n', stderr: '' }
    if (verb === 'volume') {
      if (sub === 'inspect') return volumeExists ? ok : { code: 1, stdout: '', stderr: 'no such volume' }
      if (sub === 'create') {
        volumeExists = true
        return ok
      }
      if (sub === 'rm') {
        volumeExists = false
        return ok
      }
    }
    if (verb === 'network') return ok
    if (verb === 'run') {
      containerExists = true
      containerRunning = true
      return { code: 0, stdout: 'cid\n', stderr: '' }
    }
    if (verb === 'start') {
      containerRunning = true
      return ok
    }
    if (verb === 'stop') {
      containerRunning = false
      return ok
    }
    if (verb === 'rm') {
      containerExists = false
      containerRunning = false
      return ok
    }
    return ok
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
    daemonCalls.push({ path: url.pathname, body })
    if (url.pathname === '/health') return new Response('ok', { status: 200 })
    if (url.pathname === '/exec') {
      const cmd = (body as { cmd: string }).cmd
      for (const responder of responders) {
        if (responder.match(cmd)) {
          const out = await responder.respond(cmd)
          return new Response(JSON.stringify({ ...out, timedOut: false }), { status: 200 })
        }
      }
      return new Response(JSON.stringify({ code: 0, stdout: 'ok\n', stderr: '', timedOut: false }), { status: 200 })
    }
    if (url.pathname === '/write') {
      const { path: p, b64 } = body as { path: string; b64: string }
      files.set(p, Buffer.from(b64, 'base64'))
      return new Response('ok', { status: 200 })
    }
    if (url.pathname === '/read') {
      const p = (body as { path: string }).path
      const f = files.get(p)
      if (!f) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify({ b64: Buffer.from(f).toString('base64') }), { status: 200 })
    }
    return new Response('nope', { status: 404 })
  }) as typeof fetch

  const execCmds = () => daemonCalls.filter((c) => c.path === '/exec').map((c) => (c.body as { cmd: string }).cmd)
  return { files, docker, daemonCalls, responders, dockerExec, fetchImpl, execCmds }
}

const rw = (scopeId: string) => ({ scopeId, mountPath: '', mode: 'rw' as const })

test('provision: cold start materializes ro layers once, warm start reuses the manifest', async () => {
  const b = createBackend()
  const sandbox = createLocalSandbox({
    dockerExec: b.dockerExec,
    fetchImpl: b.fetchImpl,
    repoRoot: '/nonexistent-repo-root',
    layerData: (layers) =>
      layers
        .filter((l) => l.mode === 'ro')
        .map((l) => ({ layer: l, files: [{ path: 'note.md', data: Buffer.from('hello') }] })),
  })
  const layers = [
    { scopeId: 's1', mountPath: 'docs', mode: 'ro' as const },
    { scopeId: 's1', mountPath: '', mode: 'rw' as const },
  ]
  const h1 = await sandbox.provision(layers, { env: { FOO: 'bar' } })
  assert.equal(h1.coldStart, true)
  assert.equal(h1.id, localContainerName('s1'))
  assert.equal(h1.env?.FOO, 'bar')
  assert.equal(Buffer.from(b.files.get('/root/workspace/docs/note.md')!).toString(), 'hello')
  assert.ok(b.files.has('/root/workspace/.ro-layers.manifest'))
  assert.ok(!b.files.has('/root/workspace/.ro-layers.tar'))

  const writesBefore = b.daemonCalls.filter((c) => c.path === '/write').length
  const h2 = await sandbox.provision(layers)
  assert.equal(h2.coldStart, false)
  const writesAfter = b.daemonCalls.filter((c) => c.path === '/write').length
  assert.equal(writesAfter, writesBefore)
})

test('provision serializes per scope; concurrent calls share one container', async () => {
  const b = createBackend()
  const sandbox = createLocalSandbox({ dockerExec: b.dockerExec, fetchImpl: b.fetchImpl, repoRoot: '/x' })
  const layers = [rw('s-par')]
  const [h1, h2] = await Promise.all([sandbox.provision(layers), sandbox.provision(layers)])
  assert.equal(h1.id, h2.id)
  assert.equal(b.docker.filter((a) => a[0] === 'run').length, 1)
})

test('run: wraps commands with the noninteractive prefix, env exports and abort kill', async () => {
  const b = createBackend()
  const sandbox = createLocalSandbox({ dockerExec: b.dockerExec, fetchImpl: b.fetchImpl, repoRoot: '/x' })
  const handle = await sandbox.provision([rw('s-run')], { env: { FOO: 'bar' } })

  let releaseMain: (r: { code: number; stdout: string; stderr: string }) => void = () => {}
  const mainPromise = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    releaseMain = resolve
  })
  let mainStarted = false
  b.responders.push({
    match: (cmd) => cmd.includes('echo hello') && cmd.includes('PAGER'),
    respond: () => {
      mainStarted = true
      return mainPromise
    },
  })

  const ac = new AbortController()
  const runPromise = sandbox.run(handle, 'echo hello', { signal: ac.signal })
  while (!mainStarted) await new Promise((resolve) => setTimeout(resolve, 1))
  ac.abort()
  await new Promise((resolve) => setTimeout(resolve, 0))
  releaseMain({ code: 0, stdout: 'hello\n', stderr: '' })
  const result = await runPromise
  assert.equal(result.stdout, 'hello\n')

  const cmds = b.execCmds()
  const main = cmds.at(-2) ?? ''
  assert.ok(main.includes('exec </dev/null;'))
  assert.ok(main.includes('export FOO='))
  assert.ok(main.includes('bar'))
  assert.ok(main.includes('setsid'))
  assert.ok(cmds.at(-1)!.includes('kill -KILL'))
  assert.ok(cmds.at(-1)!.includes('.pgid'))
})

test('file ops: write/read bytes, listDir via find, extractFiles via tar', async () => {
  const b = createBackend()
  const sandbox = createLocalSandbox({ dockerExec: b.dockerExec, fetchImpl: b.fetchImpl, repoRoot: '/x' })
  const handle = await sandbox.provision([rw('s-io')])
  await sandbox.writeFile(handle, 'a/b.txt', 'hi')
  assert.equal(await sandbox.readFile(handle, 'a/b.txt'), 'hi')
  assert.equal(await sandbox.readFile(handle, 'missing.txt'), null)

  b.responders.push({
    match: (cmd) => cmd.includes('find '),
    respond: async () => ({ code: 0, stdout: './x.txt\n./y.log\n', stderr: '' }),
  })
  assert.deepEqual(await sandbox.listDir(handle, '.'), ['x.txt', 'y.log'])

  await sandbox.extractFiles!(handle, [{ path: 'z.txt', data: Buffer.from('zz') }])
  assert.equal(Buffer.from(b.files.get('/root/workspace/z.txt')!).toString(), 'zz')
})

test('process sessions: start/read/write/signal/list over the exec daemon', async () => {
  const b = createBackend()
  const sandbox = createLocalSandbox({ dockerExec: b.dockerExec, fetchImpl: b.fetchImpl, repoRoot: '/x' })
  const handle = await sandbox.provision([rw('s-proc')], { env: { API_TOKEN: 'tok_abcdef123456' } })
  const ps: ProcessSandbox = supportsProcessSessions(sandbox) ? sandbox : (null as never)
  assert.ok(ps)

  b.responders.push({
    match: (cmd) => cmd.includes('agent-proc') && cmd.includes('CURSOR='),
    respond: async () => ({
      code: 0,
      stdout: `CURSOR=5\nSTATUS=exited:0\nDATA=\n${Buffer.from('hello').toString('base64')}\n`,
      stderr: '',
    }),
  })
  b.responders.push({
    match: (cmd) => cmd.includes('agent-proc') && cmd.includes('for d in "$B"/*'),
    respond: async () => {
      const cmdB64 = Buffer.from('echo tok_abcdef123456 | gh auth login --with-token').toString('base64')
      return { code: 0, stdout: `${LIST_ID}|1700000000|running|${cmdB64}\n`, stderr: '' }
    },
  })

  const { processId } = await ps.startProcess(handle, 'sleep 100')
  assert.match(processId, /^[0-9a-f-]{36}$/)
  assert.ok(b.execCmds().at(-1)!.includes('mkfifo'))

  const read = await ps.readProcess(handle, processId, { sinceCursor: 0 })
  assert.equal(read.chunks, 'hello')
  assert.equal(read.cursor, 5)
  assert.deepEqual(read.status, { state: 'exited', code: 0 })

  await ps.writeStdin(handle, processId, 'yes\n')
  await ps.signalProcess(handle, processId, 'SIGKILL')
  await assert.rejects(ps.signalProcess(handle, processId, 'USR1'), /unsupported signal/)
  await assert.rejects(ps.readProcess(handle, 'short', {}), /invalid process id/)

  const sessions = await ps.listProcesses(handle)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0]!.processId, LIST_ID)
  assert.ok(!sessions[0]!.command.includes('tok_abcdef123456'))
  assert.ok(sessions[0]!.command.includes('echo <redacted>'))
})

test('teardown: reference-counted park, then destroy removes container, network and volume', async () => {
  const b = createBackend()
  const sandbox = createLocalSandbox({ dockerExec: b.dockerExec, fetchImpl: b.fetchImpl, repoRoot: '/x' })
  const layers = [rw('s-td')]
  const h1 = await sandbox.provision(layers)
  const h2 = await sandbox.provision(layers)
  await sandbox.teardown(h1)
  assert.ok(!b.docker.some((a) => a[0] === 'stop'))
  await sandbox.teardown(h2)
  assert.ok(b.docker.some((a) => a[0] === 'stop' && a.at(-1) === localContainerName('s-td')))

  const h3 = await sandbox.provision(layers)
  await sandbox.teardown(h3, { destroy: true })
  assert.ok(b.docker.some((a) => a[0] === 'rm' && a.includes('-f') && a.at(-1) === localContainerName('s-td')))
  assert.ok(b.docker.some((a) => a[0] === 'volume' && a[1] === 'rm'))
  assert.ok(b.docker.some((a) => a[0] === 'network' && a[1] === 'rm'))
})

test('scratch containers provision and teardown without volumes', async () => {
  const b = createBackend()
  const sandbox = createLocalSandbox({ dockerExec: b.dockerExec, fetchImpl: b.fetchImpl, repoRoot: '/x' })
  const handle = await sandbox.provision([], { scratch: { key: 'k1' } })
  assert.equal(handle.scratch, true)
  assert.ok(handle.id.startsWith('qm-scratch-'))
  assert.ok(!b.docker.some((a) => a[0] === 'volume' && a[1] === 'create'))
  assert.ok(!b.docker.some((a) => a.includes('-v')))
  await sandbox.teardown(handle, { destroy: true })
  assert.ok(b.docker.some((a) => a[0] === 'rm' && a.includes('-f') && a.at(-1) === handle.id))
})

test('a failed provision tears the container back down', async () => {
  const b = createBackend({ failPrep: true })
  const sandbox = createLocalSandbox({ dockerExec: b.dockerExec, fetchImpl: b.fetchImpl, repoRoot: '/x' })
  await assert.rejects(
    sandbox.provision([rw('s-fail')], { env: { FOO: 'bar' } }),
    /provision prep failed/,
  )
  assert.ok(b.docker.some((a) => a[0] === 'stop'))
})

test('missing docker image fails preflight with the build hint', async () => {
  const b = createBackend({ imageMissing: true })
  const sandbox = createLocalSandbox({ dockerExec: b.dockerExec, fetchImpl: b.fetchImpl, repoRoot: '/x' })
  await assert.rejects(sandbox.provision([rw('s-img')]), /not found/)
})

test('redactCommand masks env values and flag values', () => {
  const env = { API_TOKEN: 'tok_supersecret99' }
  assert.equal(
    redactCommand('curl -H "Authorization: Bearer tok_supersecret99"', env),
    'curl -H "Authorization: Bearer [redacted]"',
  )
  assert.equal(redactCommand('login --password=hunter2', {}), 'login --password=<redacted>')
  assert.ok(redactCommand('gh auth login --with-token < f', env).includes('--with-token'))
  assert.ok(redactCommand('a'.repeat(600)).length <= 500)
})

test('env prefix and kill scripts are shell-safe', () => {
  const prefix = nonInteractiveShellPrefix()
  assert.ok(prefix.startsWith('exec </dev/null;'))
  assert.ok(prefix.includes('export PAGER="${PAGER:-cat}"'))
  assert.ok(prefix.includes('export AWS_PAGER="${AWS_PAGER-}"'))

  const handle = { id: 'c', rootDir: '/root/workspace', env: { HTTPS_PROXY: 'http://p:1', NO_PROXY: 'x' } }
  assert.equal(proxyExportPrefix(handle), `export HTTPS_PROXY='http://p:1'; export NO_PROXY='x'; `)

  const proxied = forceThroughProxyEnv('http://proxy:3128', 'tok')
  assert.equal(proxied.HTTP_PROXY, 'http://x:tok@proxy:3128')
  assert.equal(proxied.NO_PROXY, 'localhost,127.0.0.1,::1')

  assert.ok(killableScript('echo hi', 'uid1').startsWith('exec setsid sh -c'))
  assert.ok(killScript('uid1').includes('kill -KILL'))
  assert.equal(pgidMarkerPath('uid1'), '/tmp/.exec-uid1.pgid')
})
