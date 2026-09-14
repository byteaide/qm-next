/**
 * Delivery claim contracts: the durable outbound queue every reply and
 * notification flows through. Generalized from qm's DeliveryStore
 * (enqueue idempotency, TTL lease claim, ack/fail retry, enqueue wakeup),
 * reworked to carry `OutboundOperation` directly so the queue and the
 * provider port share one shape.
 */
import type { OutgoingAttachment } from '@qm/types'
import type { OutboundOperation } from './outbound.ts'
import type { Destination } from '@qm/types'

/**
 * Where a queued delivery came from — audit and dedup context. Trigger
 * deliveries carry the full provenance block (qm `DeliveryProvenance`):
 * the waking surface, the fire key, the scope/thread the fire ran in, and
 * the source turn's session for drill-down.
 */
export interface DeliveryOrigin {
  /** Terminated run whose reply this delivery carries. */
  runId?: string
  /** Automation trigger key (cron id, webhook delivery id, …). */
  trigger?: string
  /** Wake surface ("cron", "trigger", …). */
  surface?: string
  /** Fire idempotency key (`cron:{id}:{slot}`, `ask:{id}:{status}`, …). */
  fireKey?: string
  /** Scope the trigger fired in. */
  sourceScopeId?: string
  /** Thread the trigger turn ran in. */
  sourceThreadRef?: string
  /** Human title of the trigger ("weekly standup notes"). */
  sourceTitle?: string
  /** Session the trigger turn ran in. */
  sourceSessionId?: string
}

export interface ImDelivery {
  id: string
  idempotencyKey: string
  provider: string
  op: OutboundOperation
  origin?: DeliveryOrigin
  createdAt: number
  /** Lease expiry; a claimed delivery whose lease lapses is claimable again. */
  leaseExpiresAt?: number
  attempts: number
  deliveredAt: number | null
  /** Terminal-failure timestamp; parked deliveries are never claimed again. */
  parkedAt?: number
  lastError?: string
}

export interface ImDeliveryEnqueueInput {
  provider: string
  op: OutboundOperation
  idempotencyKey: string
  origin?: DeliveryOrigin
}

export interface ImDeliveryClaimOptions {
  /** Lease duration in ms; the claim expires (and retries) if not acked. */
  ttlMs: number
  /** Maximum deliveries per claim. */
  max?: number
}

export interface ImDeliveryFailOptions {
  /** Delay before the delivery is claimable again; defaults to immediate. */
  retryInMs?: number
  /** Terminal failure: the delivery is parked and never claimed again. */
  park?: boolean
}

/**
 * Durable outbound queue. Implementations: memory (tests/dev) now,
 * Postgres (`FOR UPDATE SKIP LOCKED`, mirroring the M1 run store) as needed.
 */
export interface ImDeliveryQueue {
  /** Enqueue one operation; idempotent on `idempotencyKey`. */
  enqueue(input: ImDeliveryEnqueueInput): Promise<ImDelivery>
  /** Claim up to `max` pending deliveries for one provider under a lease. */
  claim(provider: string, options: ImDeliveryClaimOptions): Promise<ImDelivery[]>
  /** Mark a delivery delivered. */
  ack(id: string, at?: number): Promise<void>
  /** Mark a delivery failed; it becomes claimable again after the retry delay. */
  fail(id: string, error: string, options?: ImDeliveryFailOptions): Promise<void>
  get(id: string): Promise<ImDelivery | null>
  /**
   * Most recent deliveries, newest first (admin observability). Optional:
   * the memory queue implements it; durable backends may defer until the
   * admin surface needs them.
   */
  list?(options?: { limit?: number }): Promise<ImDelivery[]>
  /** Wakeup signal fired on every non-idempotent-duplicate enqueue. */
  onEnqueued(listener: () => void): () => void
}

/** Loop handle returned by the delivery-loop factory (implemented core-side). */
export interface ImDeliveryLoop {
  start(): Promise<void>
  /** Stop claiming; wait for in-flight operations to settle. */
  stop(): Promise<void>
}

export interface ImDeliveryLoopOptions {
  queue: ImDeliveryQueue
  /** Providers are resolved from the registry at claim time. */
  registry: ImRegistryLike
  /** Poll cadence in ms (wakeup events skip the wait). */
  tickMs?: number
  claimTtlMs?: number
  maxPerClaim?: number
  /** Give up after this many attempts; lastError records the surrender. */
  maxAttempts?: number
  /** Base delay for exponential backoff on fail-without-retryInMs. */
  backoffMs?: number
}

/** Structural slice of the registry the loop needs (avoids an import cycle). */
export interface ImRegistryLike {
  get(provider: string): ImProviderLike | undefined
  listProviderIds(): string[]
}

/** Structural slice of a provider the loop needs. */
export interface ImProviderLike {
  provider: string
  outbound(ops: readonly OutboundOperation[]): Promise<import('./types.ts').OutboundReceipt[]>
  /** Optional provider-native approval card renderer (bridge consults it). */
  approvalCardRenderer?: import('./provider.ts').ImApprovalCardRenderer
  /** Optional capability probe (bridge gates ack reactions on `react`). */
  capabilities?(): import('./types.ts').ImCapabilities
}

export type { OutgoingAttachment, Destination }
