/**
 * `@qm/monitors` — background-job watches: durable monitor store
 * (memory/Postgres) plus a broker that arms/re-arms/unwatches a watch.
 *
 * The store extends the trigger shape (owner/ownerScopeId/destination)
 * so the same consent and escalation guards cover monitors, skills,
 * and crons. The poller that drives a fired monitor lives outside this
 * package; it consumes `@qm/processes` and the running-process surface
 * that has not landed in qm-next yet.
 */
export {
  createMemoryMonitorStore,
  createPostgresMonitorStore,
  type CreateMonitorInput,
  type Monitor,
  type MonitorStore,
} from './monitor-store.ts'
export {
  compileMonitorPattern,
  createMonitorBroker,
  readBackgroundOutputTail,
  type BackgroundOutputTail,
  type BackgroundUnwatchResult,
  type BackgroundWatchArmedResult,
  type BackgroundWatchResult,
  type MonitorBroker,
  type MonitorBrokerDeps,
} from './monitor-broker.ts'