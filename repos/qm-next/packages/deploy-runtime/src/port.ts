import type {
  DeployApplyInput,
  DeployEndpoint,
  DeployLogsInput,
  DeployMaterializer,
  DeployProfile,
  DeployProvider,
  DeployFile,
} from '@qm/types'

export type {
  DeployApplyInput,
  DeployEndpoint,
  DeployFile,
  DeployLogsInput,
  DeployMaterializer,
  DeployProfile,
  DeployProvider,
}

export interface MaterializeOptions {
  /** Root directory under which per-deployment/per-version workspaces live. Default `os.tmpdir()/qm-next-deployments`. */
  workspaceRoot?: string
}

export interface DockerDeployProviderOptions {
  image?: string
  dockerBin?: string
  basePort?: number
  dockerExec?: DockerExec
}

export type DockerExec = (
  args: string[],
  timeoutMs?: number,
) => Promise<{ code: number; stdout: string; stderr: string }>

export interface DockerDaemonProbeOptions {
  dockerBin?: string
  dockerExec?: DockerExec
}