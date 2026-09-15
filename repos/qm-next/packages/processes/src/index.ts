/**
 * `@qm/processes` — process session registry (parity 16.0).
 *
 * Memory and Postgres dual impl for tracking long-running processes
 * (`build`, `dev-server`, `background`) registered by the orchestrator;
 * plus a reaper that kills expired sessions under a leader lease, and a
 * reconcile helper that flips stale `running` records to `exited` after
 * a scope restart.
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
export {
  createProcessReaper,
  createReaperKillHook,
  type ProcessReaper,
  type ProcessReaperOptions,
  type ReaperKillHookOptions,
} from './process-reaper.ts'
export { reconcileProcesses } from './reconcile.ts'
export { createNoopLeaderLease, type ReaperLeaderLease } from './leader-lease.ts'