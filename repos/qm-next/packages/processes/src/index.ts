/**
 * `@qm/processes` — process session registry (parity 16.0).
 *
 * Memory and Postgres dual impl for tracking long-running processes
 * (`build`, `dev-server`, `background`) registered by the orchestrator.
 * Consumed by `process-reaper`, `monitor-broker`, and `background-exec-broker`.
 */
export {
  createMemoryProcessRegistry,
  createPostgresProcessRegistry,
  isDeclaredKind,
  type PostgresProcessRegistry,
  type ProcessKind,
  type ProcessRecord,
  type ProcessRegistry,
  type ProcessStatus,
} from './process-registry.ts'