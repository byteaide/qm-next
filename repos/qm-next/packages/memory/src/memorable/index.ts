/**
 * Memorable procedural-memory family, ported from qm's
 * `src/memory/memorable/`. Recall shells out to `memorable inject` with the
 * turn's task; capture derives a tool-call trace from the session that
 * produced the turn and relays it through `memorable record`. The spawned
 * CLI gets an allow-listed environment — never the process environment.
 */
export { stripTerminalControl, clampChars, memorableInject, type MemorableSpawnOpts } from './inject.ts'
export { worthOffering, captureSession, type MemorableCapture, type MemorableToolCall, type MemorableWorkflow } from './capture.ts'
export { relayRecord, type RelayOutcome } from './relay.ts'
export {
  parseMemorableProvider,
  type MemorableMemoryProviderConfig,
  MEMORABLE_BASE_ENV_ALLOWLIST,
} from './config.ts'
export { createMemorableMemoryProvider, type MemorableProviderDeps } from './provider.ts'
