/**
 * Test helpers: a recording `dockerExec` for unit tests, and a
 * `createMockDockerDeployProvider` that wraps `createDockerDeployProvider`
 * with the recording exec pre-installed. The fake mirrors qm's
 * `fake-docker.ts` — a Map of container names plus a Set of networks,
 * enough for `apply`/`destroy`/`resolveEndpoint` to exercise the
 * real provider without a docker daemon.
 */
import type { DeployApplyInput, DeployEndpoint, DeployLogsInput, DeployProfile, DeployProvider } from '@qm/types'
import { createDockerDeployProvider } from './docker.ts'
import type { DockerExec } from './port.ts'

export interface FakeContainer {
  name: string
  image: string
  args: string[]
  port?: number
}

export interface FakeDockerExecState {
  calls: string[][]
  containers: Map<string, FakeContainer>
  networks: Set<string>
  inspectFailures: Set<string>
  nextInspectPort: Map<string, number>
}

export function createRecordingDockerExec(state: FakeDockerExecState): DockerExec {
  return async (args) => {
    state.calls.push(args)
    const cmd = args[0]
    if (cmd === 'network') {
      const sub = args[1]
      const name = args[2] ?? ''
      if (sub === 'inspect') return state.networks.has(name) ? { code: 0, stdout: name, stderr: '' } : { code: 1, stdout: '', stderr: 'No such network' }
      if (sub === 'create') {
        state.networks.add(name)
        return { code: 0, stdout: name, stderr: '' }
      }
      if (sub === 'rm') {
        state.networks.delete(name)
        return { code: 0, stdout: name, stderr: '' }
      }
      if (sub === 'connect' || sub === 'disconnect') return { code: 0, stdout: '', stderr: '' }
    }
    if (cmd === 'inspect') {
      const target = args[args.length - 1] ?? ''
      if (state.inspectFailures.has(target)) return { code: 1, stdout: '', stderr: 'daemon unavailable' }
      if (state.containers.has(target)) {
        const port = state.containers.get(target)?.port
        const networks: Record<string, unknown> = { [`${target}-net`]: {} }
        if (port !== undefined) networks['agent-deploynet'] = {}
        return { code: 0, stdout: JSON.stringify(networks), stderr: '' }
      }
      return { code: 1, stdout: '', stderr: 'No such object' }
    }
    if (cmd === 'rm') return { code: 0, stdout: '', stderr: '' }
    if (cmd === 'run') {
      const nameIdx = args.indexOf('--name')
      const name = nameIdx >= 0 ? args[nameIdx + 1] ?? '' : ''
      const portIdx = args.findIndex((a) => a === '-p')
      const port = portIdx >= 0 ? Number((args[portIdx + 1] ?? '').split(':').pop()) : undefined
      const container: FakeContainer = { name, image: args.find((a) => !a.startsWith('-')) ?? '', args }
      if (port !== undefined && !Number.isNaN(port)) container.port = port
      state.containers.set(name, container)
      return { code: 0, stdout: 'deadbeef', stderr: '' }
    }
    if (cmd === 'logs') return { code: 0, stdout: 'log line\n', stderr: '' }
    if (cmd === 'version') return { code: 0, stdout: '29.1.3\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
}

export function createMockDockerDeployProvider(state: FakeDockerExecState): DeployProvider {
  return createDockerDeployProvider({
    image: 'node:24-alpine',
    basePort: 9200,
    dockerExec: createRecordingDockerExec(state),
  })
}

export function newFakeDockerState(): FakeDockerExecState {
  return {
    calls: [],
    containers: new Map(),
    networks: new Set(),
    inspectFailures: new Set(),
    nextInspectPort: new Map(),
  }
}

export interface StaticDeployProviderOptions {
  endpoint?: DeployEndpoint
  profile?: DeployProfile
  /** Per-call log output (cycles through entries when more calls than entries). */
  logs?: string[]
}

export function createStaticDeployProvider(opts: StaticDeployProviderOptions = {}): DeployProvider & {
  applyCalls: DeployApplyInput[]
  destroyCalls: string[]
  logsCalls: { deploymentId: string; opts: DeployLogsInput }[]
} {
  const endpoint: DeployEndpoint = opts.endpoint ?? { host: '127.0.0.1', port: 9100 }
  const profile: DeployProfile = opts.profile ?? { managedScaleToZero: false }
  let logCursor = 0
  const provider = {
    applyCalls: [] as DeployApplyInput[],
    destroyCalls: [] as string[],
    logsCalls: [] as { deploymentId: string; opts: DeployLogsInput }[],
    profile,
    async apply(input: DeployApplyInput): Promise<DeployEndpoint> {
      this.applyCalls.push(input)
      return endpoint
    },
    async destroy(deploymentId: string): Promise<void> {
      this.destroyCalls.push(deploymentId)
    },
    async resolveEndpoint(_deploymentId: string, _version: number): Promise<DeployEndpoint | null> {
      return endpoint
    },
    async logs(deploymentId: string, logOpts: DeployLogsInput): Promise<string | null> {
      this.logsCalls.push({ deploymentId, opts: logOpts })
      if (!opts.logs || opts.logs.length === 0) return null
      const value = opts.logs[logCursor % opts.logs.length] ?? null
      logCursor++
      return value
    },
  }
  return provider
}