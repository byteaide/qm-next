/**
 * Docker deploy provider (cluster 1 MVP) — ported from qm's
 * `src/deploy/docker-deploy-provider.ts`. Each deployment runs as a
 * detached container on an isolated bridge network, with a host port
 * bound to the container's `APP_PORT`. Port allocation is in-process
 * (`basePort` + monotonically incrementing counter, with a freed-list
 * recycle) — the docker daemon is the source of truth for what's
 * actually running (`resolveEndpoint` self-heals via container
 * inspection).
 *
 * The provider is decoupled from `DeploymentRecord`: `apply()` takes
 * an opaque `workspaceDir` produced by the materializer, so the
 * byte-store layer stays behind the store and the provider knows nothing
 * about blob keys.
 */
import type { DeployApplyInput, DeployEndpoint, DeployLogsInput, DeployProfile, DeployProvider } from '@qm/types'
import { spawnDockerExec } from './docker-exec.ts'
import type { DockerDeployProviderOptions, DockerExec, DockerDaemonProbeOptions } from './port.ts'

const APP_PORT = 8080
const LEGACY_NETWORK = 'agent-deploynet'
const DAEMON_PROBE_TIMEOUT_MS = 10_000

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function dockerDaemonFailure(opts: DockerDaemonProbeOptions = {}): Promise<string | null> {
  const dexec = opts.dockerExec ?? spawnDockerExec(opts.dockerBin ?? 'docker')
  try {
    const r = await dexec(['version', '-f', '{{.Server.Version}}'], DAEMON_PROBE_TIMEOUT_MS)
    if (r.code === 0) return null
    const stderr = r.stderr.trim()
    if (stderr) return stderr
    return r.code < 0 ? `no response within ${DAEMON_PROBE_TIMEOUT_MS / 1000}s` : `exit ${r.code}`
  } catch (e) {
    return errMessage(e)
  }
}

export function createDockerDeployProvider(opts: DockerDeployProviderOptions = {}): DeployProvider {
  const dockerBin = opts.dockerBin ?? 'docker'
  const image = opts.image ?? 'node:24-alpine'
  let nextPort = opts.basePort ?? 9200
  const ports = new Map<string, number>()
  const freed: number[] = []
  const allocPort = (name: string): number => {
    const existing = ports.get(name)
    if (existing !== undefined) return existing
    const port = freed.pop() ?? nextPort++
    ports.set(name, port)
    return port
  }
  const freePort = (name: string): void => {
    const p = ports.get(name)
    if (p !== undefined) {
      freed.push(p)
      ports.delete(name)
    }
  }

  const dexec: DockerExec = opts.dockerExec ?? spawnDockerExec(dockerBin)

  const containerName = (deploymentId: string): string => `agent-deploy-${deploymentId.slice(0, 12)}`
  const networkName = (deploymentId: string): string => `${containerName(deploymentId)}-net`

  const ensureNetwork = async (net: string): Promise<string> => {
    if ((await dexec(['network', 'inspect', net])).code !== 0) {
      const r = await dexec(['network', 'create', net])
      if (r.code !== 0 && !/already exists/i.test(r.stderr)) {
        throw new Error(`docker network create ${net} failed: ${r.stderr.trim()}`)
      }
    }
    return net
  }

  const migrateContainer = async (name: string): Promise<boolean> => {
    const inspected = await dexec(['inspect', '--format', '{{json .NetworkSettings.Networks}}', name])
    if (inspected.code !== 0) {
      if (/no such (?:object|container)|not found/i.test(inspected.stderr)) return false
      throw new Error(`docker inspect ${name} failed: ${inspected.stderr.trim()}`)
    }
    let attached: Record<string, unknown>
    try {
      attached = JSON.parse(inspected.stdout) as Record<string, unknown>
    } catch {
      throw new Error(`docker inspect ${name} returned invalid network state`)
    }
    const target = `${name}-net`
    await ensureNetwork(target)
    if (!(target in attached)) {
      const connected = await dexec(['network', 'connect', target, name])
      if (connected.code !== 0) throw new Error(`docker network connect ${target} failed: ${connected.stderr.trim()}`)
    }
    if (LEGACY_NETWORK in attached) {
      const disconnected = await dexec(['network', 'disconnect', LEGACY_NETWORK, name])
      if (disconnected.code !== 0)
        throw new Error(`docker network disconnect ${LEGACY_NETWORK} failed: ${disconnected.stderr.trim()}`)
    }
    return true
  }
  const migrateTarget = async (name: string): Promise<boolean> => {
    try {
      return await migrateContainer(name)
    } catch {
      return migrateContainer(name)
    }
  }

  const profile: DeployProfile = { managedScaleToZero: false }

  return {
    profile,

    async apply(input: DeployApplyInput): Promise<DeployEndpoint> {
      const net = await ensureNetwork(networkName(input.deploymentId))
      await dexec(['rm', '-f', containerName(input.deploymentId)])
      const hostPort = allocPort(containerName(input.deploymentId))
      const envArgs = Object.entries(input.env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
      const r = await dexec([
        'run',
        '-d',
        '--name',
        containerName(input.deploymentId),
        '--network',
        net,
        '--memory',
        '512m',
        '--cpus',
        '1',
        '--pids-limit',
        '256',
        '-p',
        `127.0.0.1:${hostPort}:${APP_PORT}`,
        '-v',
        `${input.workspaceDir}:/app:ro`,
        '-w',
        '/app',
        '-e',
        `PORT=${APP_PORT}`,
        ...envArgs,
        image,
        'sh',
        '-c',
        input.entrypoint,
      ])
      if (r.code !== 0) {
        await dexec(['rm', '-f', containerName(input.deploymentId)])
        await dexec(['network', 'rm', net])
        freePort(containerName(input.deploymentId))
        throw new Error(`deploy run failed: ${r.stderr.trim()}`)
      }
      return { host: '127.0.0.1', port: hostPort }
    },

    async logs(deploymentId: string, opts: DeployLogsInput): Promise<string | null> {
      const name = containerName(deploymentId)
      if (!(await migrateTarget(name))) return null
      const lines = Math.max(1, Math.min(2000, Math.floor(opts.tailLines)))
      const r = await dexec(['logs', '--tail', String(lines), name])
      if (r.code !== 0) return null
      return `${r.stdout}${r.stderr}`
    },

    async destroy(deploymentId: string): Promise<void> {
      await dexec(['rm', '-f', containerName(deploymentId)])
      await dexec(['network', 'rm', networkName(deploymentId)])
      freePort(containerName(deploymentId))
    },

    async resolveEndpoint(deploymentId: string, _version: number): Promise<DeployEndpoint | null> {
      const name = containerName(deploymentId)
      if (!(await migrateTarget(name))) return null
      const allocated = ports.get(name)
      if (allocated === undefined) return null
      return { host: '127.0.0.1', port: allocated }
    },
  }
}