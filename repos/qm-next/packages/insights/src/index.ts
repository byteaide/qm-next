/**
 * `@qm/insights` — out-of-band insight notifiers (parity 16.0).
 *
 * The reach-denied notifier relays `deployment.reach_denied` audit events
 * to a downstream channel under a leader lease so only one instance
 * fans out per tick.
 */
export {
  createReachDeniedNotifier,
  createNoopLeaderLease,
  type ReachDeniedCursor,
  type ReachDeniedLeaderLease,
  type ReachDeniedNotifierDeps,
} from './reach-denied-notifier.ts'