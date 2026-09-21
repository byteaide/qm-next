/**
 * @qm/deploy-runtime — cluster 1 deploy runtime: Docker provider +
 * materialize hook + DeployGitStore (cluster 1 phase 2). Wires the
 * frozen `@qm/types` ports to the byte-store layer so the deployment
 * store can `apply()`/`destroy()` and the git HTTP backend can serve
 * `git clone` / `git push` without touching docker / git directly.
 */
export * from './port.ts'
export { spawnDockerExec } from './docker-exec.ts'
export { createDockerDeployProvider, dockerDaemonFailure } from './docker.ts'
export { createMaterializer } from './materialize.ts'
export type { MaterializerOptions } from './materialize.ts'
export { createDeployGitStore } from './git-store.ts'
export type { DeployGitStoreOptions, GitArchiveStore } from './git-store.ts'
export {
  createMockDockerDeployProvider,
  createRecordingDockerExec,
  createStaticDeployProvider,
  newFakeDockerState,
} from './testing.ts'
export type { FakeContainer, FakeDockerExecState, StaticDeployProviderOptions } from './testing.ts'