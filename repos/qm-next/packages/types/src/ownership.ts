/**
 * Background ownership contract (ADR-0020, 2026-09-26).
 *
 * A core deployment owns the background work it has admitted (cron polling,
 * IM ingress, inline HTTP, sync turns, in-flight runs, scheduled callbacks,
 * process sessions, web-ui long-poll, reaper + lease controller). Another
 * deployment may take over only when the durable ownership record says
 * so — the reaper, lease controller, and process sessions all live under
 * that record; switching it is the deployment boundary, not the worker
 * boundary.
 *
 * Source-of-truth: `docs/adr/0020-background-ownership-types.md` (proposed,
 * M-Soul-3 deferral; full implementation lands with P5 21.0 worker split).
 * qm reference: `repos/qm/docs/background-ownership.md`. The qm-next shape
 * is narrower and platform-neutral — `Ownership.deploymentId` carries the
 * deployment identity directly (qm splits it across `BACKGROUND_DEPLOYMENT_ID`
 * env + pg record; qm-next collapses to one typed string for the contract).
 *
 * qm-next discipline:
 * - Pure interface module; no runtime exports.
 * - Zero `@qm/runs` dependencies (the type consumer is `@qm/runs`, not the
 *   other way around — keeps the layering from cycling).
 * - No IM platform symbols (covered by `check:im`); the credential fields
 *   use opaque string placeholders that log-redaction must mask.
 */

/** A deployed revision's durable claim to all background work it admitted.
 *  One record per `(deploymentId, generation)` pair; CAS-on-generation
 *  increments move the deployment forward (admits the successor) or
 *  pause it (`null` desired). */
export interface Ownership {
  /** Stable identity shared by every replica of one deployment revision. */
  deploymentId: string
  /** CAS-on-increment; only the expected generation accepts mutations. */
  generation: number
  /** Unix-ms when the successor deployment's first replica acknowledged. */
  acceptedAt: number | null
  /** Per-instance acknowledgment rows (each replica enrolls separately). */
  members: OwnershipMember[]
}

/** One replica's enrollment row. `instanceId` is the local process id;
 *  `taskArn` is the ECS container metadata URI V4 (or null for non-ECS). */
export interface OwnershipMember {
  instanceId: string
  deploymentId: string
  taskArn: string | null
  /** `admitted` → started background resources; `ready` → activation
   *  complete; `relinquished` → stopped new claims; `drained` → background
   *  work finished. `retired` is set by operator-driven termination
   *  evidence, never by a process alone. */
  state: 'admitted' | 'ready' | 'relinquished' | 'drained' | 'retired'
  /** Generation this member was admitted under (must match `Ownership.generation`
   *  while the member is `admitted` or `ready`). */
  generation: number
  /** Unix-ms; null for members still admitting. */
  acknowledgedAt: number | null
}

/** Sealed credential a relinquishing process issues to a successor. The
 *  `token` field is opaque — never log it, never include it in error
 *  messages, never reflect it back into observation surfaces. The
 *  acceptor proves possession via a separate bearer header. */
export interface TransferToken {
  /** Sealed opaque credential string. Treat as `[redacted-credential]`
   *  in logs and error messages. */
  token: string
  /** Deployment identity the token is bound to (the successor). */
  acceptedDeploymentId: string
  /** Deployment identity that issued the token (the relinquisher). */
  sourceDeploymentId: string
  /** Unix-ms; the request must reject any token whose expiresAt has passed. */
  expiresAt: number
  /** Monotonic nonce; the server dedupes by this so a retry of the same
   *  logical mutation does not double-issue. */
  nonce: string
}

/** Per-claim handle a worker holds while doing work under an `Ownership`.
 *  The reaper / lease controller pair see an `OwnershipLease.expired`
 *  fence new local work; force-release is gated on the deployment's
 *  `Ownership.generation` being one the lease was admitted under. */
export interface OwnershipLease {
  instanceId: string
  ownership: Ownership
  /** What the lease covers — used by the controller to decide which
   *  durable map (run / cron / process-session / observation) to fence. */
  claimKind: 'run' | 'cron' | 'process-session' | 'observation' | 'inline-http'
  /** Identifier inside the claimKind (`runId`, `cronId`, `pid`, etc.). */
  claimId: string
  /** Sealed bearer the worker presents to the durable store to fence
   *  reads/writes under this lease. Same redacted-credential discipline
   *  as `TransferToken.token`. */
  claimToken: string
  /** Unix-ms; absolute expiry (relative leases renew via the lease
   *  controller; this field is the wall-clock hard cap). */
  expiresAt: number
}