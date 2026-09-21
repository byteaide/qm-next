/**
 * @qm/deploy-runtime — cluster 1 deploy runtime MVP: Docker provider
 * + materialize hook + test fixtures. Wires the frozen
 * `@qm/types` DeployProvider port to the byte-store layer so the
 * deployment store can `apply()`/`destroy()` without touching docker
 * directly.
 */
export * from './port.ts'
export { spawnDockerExec } from './docker-exec.ts'
export { createDockerDeployProvider, dockerDaemonFailure } from './docker.ts'
export { createMaterializer } from './materialize.ts'
export type { MaterializerOptions } from './materialize.ts'
export {
  createMockDockerDeployProvider,
  createRecordingDockerExec,
  createStaticDeployProvider,
  newFakeDockerState,
} from './testing.ts'
export type { FakeContainer, FakeDockerExecState, StaticDeployProviderOptions } from './testing.ts'