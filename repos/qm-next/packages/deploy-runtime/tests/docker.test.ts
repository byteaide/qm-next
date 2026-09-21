/**
 * Docker deploy provider tests (cluster 1 MVP).
 *
 * Mirrors qm's `test/docker-deploy-provider.test.ts` (190 lines) but
 * keyed off the qm-next `DeployProvider` port: `apply`/`destroy`/
 * `resolveEndpoint`/`logs`/`dockerDaemonFailure` all use the new
 * `DeployApplyInput` shape (deploymentId + version + workspaceDir +
 * entrypoint + env). The fake exec records calls so we can assert
 * against docker CLI arguments; the docker daemon is not running.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createDockerDeployProvider,
  createRecordingDockerExec,
  dockerDaemonFailure,
  newFakeDockerState,
  type DockerExec,
  type FakeDockerExecState,
} from '../src/index.ts'

function recordingExec(state: FakeDockerExecState): DockerExec {
  return createRecordingDockerExec(state)
}

test('Docker deployments use isolated networks and remove them on destroy', async () => {
  const state = newFakeDockerState()
  const provider = createDockerDeployProvider({ dockerExec: recordingExec(state) })
  await provider.apply({
    deploymentId: '11111111-1111-1111-1111-111111111111',
    version: 1,
    workspaceDir: '/snap/one',
    entrypoint: 'node server.js',
    env: {},
  })
  await provider.apply({
    deploymentId: '22222222-2222-2222-2222-222222222222',
    version: 1,
    workspaceDir: '/snap/two',
    entrypoint: 'node server.js',
    env: {},
  })
  await provider.destroy('11111111-1111-1111-1111-111111111111')
  const firstName = 'agent-deploy-11111111-111'
  const secondName = 'agent-deploy-22222222-222'
  assert.ok(state.calls.some((args) => args.join(' ') === `network create ${firstName}-net`))
  assert.ok(state.calls.some((args) => args.join(' ') === `network create ${secondName}-net`))
  assert.ok(state.calls.some((args) => args.join(' ').includes(`--name ${firstName} --network ${firstName}-net`)))
  assert.ok(state.calls.some((args) => args.join(' ').includes(`--name ${secondName} --network ${secondName}-net`)))
  assert.ok(state.calls.some((args) => args.join(' ') === `network rm ${firstName}-net`))
})

test('the daemon probe reports nothing when Docker answers', async () => {
  const calls: string[][] = []
  const dockerExec: DockerExec = async (args) => {
    calls.push(args)
    return { code: 0, stdout: '29.1.3\n', stderr: '' }
  }
  assert.equal(await dockerDaemonFailure({ dockerExec }), null)
  assert.deepEqual(calls, [['version', '-f', '{{.Server.Version}}']])
})

test('the daemon probe reports why Docker is unreachable', async () => {
  const dockerExec: DockerExec = async () => ({
    code: 1,
    stdout: '',
    stderr: 'dial unix /var/run/docker.sock: connect: no such file or directory\n',
  })
  assert.equal(
    await dockerDaemonFailure({ dockerExec }),
    'dial unix /var/run/docker.sock: connect: no such file or directory',
  )
})

test('the daemon probe reports a failed probe rather than throwing', async () => {
  const dockerExec: DockerExec = async () => {
    throw new Error('spawn docker ENOENT')
  }
  assert.equal(await dockerDaemonFailure({ dockerExec }), 'spawn docker ENOENT')
})

test('the daemon probe reports the exit code when Docker is silent', async () => {
  const dockerExec: DockerExec = async () => ({ code: 7, stdout: '', stderr: '' })
  assert.equal(await dockerDaemonFailure({ dockerExec }), 'exit 7')
})

test('the daemon probe reports a hung daemon as a timeout', async () => {
  const dockerExec: DockerExec = async () => ({ code: -1, stdout: '', stderr: '' })
  assert.equal(await dockerDaemonFailure({ dockerExec }), 'no response within 10s')
})

test('apply() allocates a host port per deployment and returns the endpoint', async () => {
  const state = newFakeDockerState()
  const provider = createDockerDeployProvider({ dockerExec: recordingExec(state) })
  const a = await provider.apply({
    deploymentId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    version: 1,
    workspaceDir: '/snap/a',
    entrypoint: 'node a.js',
    env: {},
  })
  const b = await provider.apply({
    deploymentId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    version: 1,
    workspaceDir: '/snap/b',
    entrypoint: 'node b.js',
    env: { PORT: '8080' },
  })
  assert.deepEqual(a, { host: '127.0.0.1', port: 9200 })
  assert.deepEqual(b, { host: '127.0.0.1', port: 9201 })
  const runs = state.calls.filter((c) => c[0] === 'run')
  assert.ok(runs[0]!.join(' ').includes('-p 127.0.0.1:9200:8080'))
  assert.ok(runs[1]!.join(' ').includes('-p 127.0.0.1:9201:8080'))
})

test('destroy() frees the host port so the next deploy reuses it', async () => {
  const state = newFakeDockerState()
  const provider = createDockerDeployProvider({ dockerExec: recordingExec(state), basePort: 9500 })
  await provider.apply({
    deploymentId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    version: 1,
    workspaceDir: '/snap/c',
    entrypoint: 'node c.js',
    env: {},
  })
  await provider.destroy('cccccccc-cccc-cccc-cccc-cccccccccccc')
  const reused = await provider.apply({
    deploymentId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    version: 1,
    workspaceDir: '/snap/d',
    entrypoint: 'node d.js',
    env: {},
  })
  assert.equal(reused.port, 9500)
})

test('resolveEndpoint() returns the live endpoint while the container is up', async () => {
  const state = newFakeDockerState()
  const provider = createDockerDeployProvider({ dockerExec: recordingExec(state) })
  await provider.apply({
    deploymentId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    version: 1,
    workspaceDir: '/snap/e',
    entrypoint: 'node e.js',
    env: {},
  })
  const endpoint = await provider.resolveEndpoint('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 1)
  assert.deepEqual(endpoint, { host: '127.0.0.1', port: 9200 })
})

test('resolveEndpoint() returns null after destroy', async () => {
  const state = newFakeDockerState()
  const provider = createDockerDeployProvider({ dockerExec: recordingExec(state) })
  await provider.apply({
    deploymentId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    version: 1,
    workspaceDir: '/snap/f',
    entrypoint: 'node f.js',
    env: {},
  })
  await provider.destroy('ffffffff-ffff-ffff-ffff-ffffffffffff')
  const endpoint = await provider.resolveEndpoint('ffffffff-ffff-ffff-ffff-ffffffffffff', 1)
  assert.equal(endpoint, null)
})

test('logs() returns the recorded stdout from the fake docker daemon', async () => {
  const state = newFakeDockerState()
  const provider = createDockerDeployProvider({ dockerExec: recordingExec(state) })
  await provider.apply({
    deploymentId: '99999999-9999-9999-9999-999999999999',
    version: 1,
    workspaceDir: '/snap/log',
    entrypoint: 'node log.js',
    env: {},
  })
  const logs = await provider.logs('99999999-9999-9999-9999-999999999999', { tailLines: 200 })
  assert.equal(logs, 'log line\n')
})

test('profile reports the MVP shape', () => {
  const state = newFakeDockerState()
  const provider = createDockerDeployProvider({ dockerExec: recordingExec(state) })
  assert.deepEqual(provider.profile, { managedScaleToZero: false })
})