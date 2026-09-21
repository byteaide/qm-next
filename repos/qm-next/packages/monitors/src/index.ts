/**
 * `@qm/monitors` — background-job watches: durable monitor store
 * (memory/Postgres), a broker that arms/re-arms/unwatches a watch, and
 * the poller that drives armed watches (poll → classify → fire →
 * advance → sweep).
 *
 * The store extends the trigger shape (owner/ownerScopeId/destination)
 * so the same consent and escalation guards cover monitors, skills,
 * and crons. The poller takes its process/fire surfaces as structural
 * interfaces; the composition root binds the local sandbox and the
 * shared fire engine.
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
export {
  createMonitorPoller,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_MIN_FIRE_INTERVAL_MS,
  DEFAULT_TICK_INTERVAL_MS,
  MAX_EVENT_CHARS,
  MAX_READ_BYTES,
  MAX_TAIL_CHARS,
  type MonitorFireEngine,
  type MonitorPoller,
  type MonitorPollerDeps,
  type MonitorProcessGate,
  type MonitorProcessLookup,
} from './monitor-poller.ts'