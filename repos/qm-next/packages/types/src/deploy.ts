/**
 * Deploy runtime contracts (cluster 1 MVP — parity deviation #45b):
 * the `DeployProvider` port, the `DeployMaterializer` hook, and the
 * `DeployEndpoint` / `DeployProfile` shapes the deployment store
 * hands back to its callers. The MVP ships one provider (Docker)
 * implemented in `@qm/deploy-runtime/docker.ts`; future providers
 * (Fly, AWS) drop in here without touching the store or routes.
 *
 * Decoupling: the provider receives an opaque workspace directory
 * string rather than the deployment record itself, so the byte-store
 * layer is the only thing that knows about blob keys. The store
 * materializes on `deploy`/`redeploy`/`restore`/`rollback` and
 * hands the path to `provider.apply()`.
 */
export interface DeployEndpoint {
  host: string
  port: number
}

export interface DeployProfile {
  managedScaleToZero: boolean
  inPlaceReconcile?: boolean
  dataDir?: string
}

export interface DeployFile {
  /** Target path within the workspace (e.g. "server.js", "package.json"). */
  path: string
  /** Content-addressed blob key from DurableByteStore (`files/<sha256>`). Preferred for runtime paths. */
  blobKey?: string
  /** Inline bytes (string or Buffer). Lane-A fallback for tests / tiny payloads. */
  content?: string | Uint8Array
}

export interface DeployMaterializer {
  /**
   * Resolve the workspace directory for a deployment/version. Reads each
   * blob via `DurableByteStore.open()` and writes it to `path` inside the
   * returned directory. The caller passes the returned directory to
   * `provider.apply()`. Implementations MUST keep version-specific paths
   * disjoint so a rollback can re-materialize an old version.
   */
  materialize(input: {
    deploymentId: string
    version: number
    entrypoint: string
    files: DeployFile[]
  }): Promise<string>
}

export interface DeployApplyInput {
  deploymentId: string
  version: number
  workspaceDir: string
  entrypoint: string
  env: Record<string, string>
}

export interface DeployLogsInput {
  tailLines: number
}

export interface DeployProvider {
  readonly profile: DeployProfile
  apply(input: DeployApplyInput): Promise<DeployEndpoint>
  destroy(deploymentId: string): Promise<void>
  resolveEndpoint(deploymentId: string, version: number): Promise<DeployEndpoint | null>
  logs(deploymentId: string, opts: DeployLogsInput): Promise<string | null>
}