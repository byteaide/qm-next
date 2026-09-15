/**
 * `@qm/egress-authz` — capability-token gated egress CONNECT proxy.
 *
 * The authz server validates a host against a per-scope policy
 * (`egress.allowedHosts`/`deniedHosts`/`denyPrivateNetworks`),
 * resolves the host, and rejects any resolved IP that is loopback,
 * link-local, a metadata endpoint, in the deny list, or in a private
 * range that the policy forbids. Every decision is recorded via the
 * sink; the relay buffers and posts signed batches upstream.
 *
 * The policy parser is exposed so admin routes can validate
 * `EgressPolicy` from JSON before persisting it.
 */
export {
  buildEgressAuthzServer,
  createRelayAuditSink,
  hostFromAuthority,
  isBlockedDestinationIp,
  tokenFromRequest,
  type EgressAuditRecorder,
  type EgressAuthzDeps,
} from './egress-authz.ts'
export {
  egressDecision,
  hostMatches,
  isHostDenied,
  parseEgressPolicy,
  type EgressDecision,
  type EgressVerdict,
} from './egress-policy.ts'
export { isPrivateNetworkIp } from './network.ts'