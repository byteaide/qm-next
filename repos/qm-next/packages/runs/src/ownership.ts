/**
 * Background ownership runtime stubs (ADR-0020, 2026-09-26).
 *
 * Pure type-discipline lane per M-Soul-3 (2026-09-26): the contract lives
 * in `@qm/types/ownership.ts`; this file carries the type guards that
 * cross the wire-format → typed-contract boundary plus the two stub
 * functions that pin the "fail loud, fail closed" discipline until P5
 * 21.0's worker split implements them.
 *
 * Source-of-truth: `docs/adr/0020-background-ownership-types.md`.
 * qm reference: `repos/qm/docs/background-ownership.md`.
 *
 * Implementation deferral (per M-Soul-3 / ADR-0020 §"Implementation deferral"):
 * - No PG twin for `Ownership` / `OwnershipLease` DurableMap tables.
 * - No memory twin (single-process fallback).
 * - No reaper integration that consumes `Ownership.generation`.
 * - No `worker.ts` admission generation fencing.
 * - No `tryHandoverOwnership` / `acceptHandover` real implementation.
 *
 * What lives here today:
 * - `isTransferToken` / `isOwnershipLease` — narrow shape probes that
 *   let the boundary between wire JSON and the typed contract reject
 *   malformed payloads before they reach the runtime. The probes are
 *   structural (typeof + key presence + primitive-kind) and do not
 *   trust `token` / `claimToken` value contents.
 * - `tryHandoverOwnership` / `acceptHandover` — throw `"not yet
 *   implemented"`. Existence here is the contract; the value is the
 *   P5 21.0 worker split.
 */
import type {
  Ownership,
  OwnershipLease,
  TransferToken,
} from '@qm/types'
import { errMessage } from './errors.ts'

// ---------------------------------------------------------------------------
// Wire-format → typed-contract probes
// ---------------------------------------------------------------------------

/**
 * Narrow structural probe for `TransferToken`. Trust nothing about the
 * `token` field's contents; only its shape (string + required identity
 * + future expiry + monotonic nonce). Callers must redact `token` from
 * any log line or error envelope that may surface to operators.
 */
export function isTransferToken(value: unknown): value is TransferToken {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.token === 'string' &&
    v.token.length > 0 &&
    typeof v.acceptedDeploymentId === 'string' &&
    v.acceptedDeploymentId.length > 0 &&
    typeof v.sourceDeploymentId === 'string' &&
    v.sourceDeploymentId.length > 0 &&
    typeof v.expiresAt === 'number' &&
    Number.isFinite(v.expiresAt) &&
    v.expiresAt > 0 &&
    typeof v.nonce === 'string' &&
    v.nonce.length > 0
  )
}

/**
 * Narrow structural probe for `OwnershipLease`. Does not inspect the
 * inner `ownership` field beyond requiring the shape — the caller's
 * contract check on `Ownership` is `isOwnership`-style, deferred to
 * P5 21.0 (today `Ownership` is a single-deployment shape with no
 * boundary crossing, so this probe only validates the outer fields).
 */
export function isOwnershipLease(value: unknown): value is OwnershipLease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.instanceId === 'string' &&
    v.instanceId.length > 0 &&
    typeof v.ownership === 'object' &&
    v.ownership !== null &&
    !Array.isArray(v.ownership) &&
    typeof v.claimKind === 'string' &&
    ['run', 'cron', 'process-session', 'observation', 'inline-http'].includes(v.claimKind) &&
    typeof v.claimId === 'string' &&
    v.claimId.length > 0 &&
    typeof v.claimToken === 'string' &&
    v.claimToken.length > 0 &&
    typeof v.expiresAt === 'number' &&
    Number.isFinite(v.expiresAt) &&
    v.expiresAt > 0
  )
}

// ---------------------------------------------------------------------------
// Stubs — fail loud, fail closed (ADR-0020 §"Implementation deferral")
// ---------------------------------------------------------------------------

/** Reason surfaced by every stub. Pinned string so P5 21.0 work can grep
 *  for it in observability dashboards and detect any silent regression
 *  to a no-op before the protocol boots. */
export const OWNERSHIP_NOT_IMPLEMENTED = 'background ownership not yet implemented (P5 21.0 deferral)'

/**
 * Try to hand over an `OwnershipLease` from one process to another. The
 * lease carries the identity of the worker's instance + the claim token;
 * the function returns an `Ownership` if the handover succeeds, or
 * `undefined` if the source / target deployments don't agree on the
 * current generation.
 *
 * **Stub today**: throws `Error(OWNERSHIP_NOT_IMPLEMENTED)` until P5
 * 21.0's worker split lands. The throw is loud (not a no-op return)
 * because a silent no-op would let callers believe a handover succeeded
 * and start a background work claim under the new deployment — exactly
 * the foot-gun the contract exists to prevent.
 */
export function tryHandoverOwnership(
  lease: OwnershipLease,
  token: TransferToken,
): Ownership | undefined {
  // Touch every parameter so strict-noUnusedParameters doesn't surface
  // the deferral; the throw is the contract until the real impl lands.
  void lease
  void token
  throw new Error(OWNERSHIP_NOT_IMPLEMENTED)
}

/**
 * Accept a handover from a relinquishing process. The transfer token's
 * `acceptedDeploymentId` must match the local deployment; the function
 * returns the accepted `Ownership` on success, `undefined` on
 * generation / scope / token-expiry mismatch.
 *
 * **Stub today**: throws `Error(OWNERSHIP_NOT_IMPLEMENTED)`. Symmetric
 * with `tryHandoverOwnership` — both throw until P5 21.0.
 */
export function acceptHandover(token: TransferToken): Ownership | undefined {
  void token
  throw new Error(OWNERSHIP_NOT_IMPLEMENTED)
}

// Internal helper retained for the P5 21.0 implementation; pinned here
// so callers that import the module today keep a single point of error
// formatting. Not exported; not exercised by tests yet.
export const _ownershipErrorMessage = (err: unknown, context: string): string =>
  `${context}: ${errMessage(err)}`