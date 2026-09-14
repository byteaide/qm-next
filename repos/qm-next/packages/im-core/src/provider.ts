/**
 * Provider port: what an IM adapter (the `im-*` packages) implements.
 * Inbound flows provider → core via the start context's `emit`; outbound
 * flows core → provider via `outbound` and `format`.
 */
import type { Destination, PendingApproval } from '@qm/types'
import type { InboundEvent } from './inbound.ts'
import type { DirectorySyncPush } from './directory.ts'
import type { OutboundOperation } from './outbound.ts'
import type { ImBlobs, ImCapabilities, OutboundBody, OutboundReceipt } from './types.ts'

/** Semantic input for provider-native approval card rendering. */
export interface ImApprovalCardSpec {
  runId: string
  sessionId: string
  approvals: readonly PendingApproval[]
}

/**
 * Provider-side approval card renderer. Payloads stay opaque
 * (`OutboundBody.card`); button values must embed the approval action
 * value so decisions round-trip back through `parseApprovalValue`
 * (`@qm/approvals` codec — objects for platforms that carry structured
 * values, JSON strings for platforms that stringify). `renderAgentRequest`
 * is the optional agent-request DM card (values embed
 * `AgentRequestActionValue`).
 */
export interface ImApprovalCardRenderer {
  render(spec: ImApprovalCardSpec): Record<string, unknown>
  renderAgentRequest?(spec: {
    requestId: string
    originLabel: string
    targetLabel: string
    task: string
  }): Record<string, unknown>
}

/** Minimal logger port; satisfied by any cordis logger. */
export interface ImLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}

/** Handed to `ImProvider.start()`; valid until the abort signal fires. */
export interface ImProviderStartContext {
  /** Diagnostic name: `<provider>:<instanceId>`. */
  readonly name: string
  readonly logger: ImLogger
  /** Aborted when this registration or the registry unloads: stop intake, drain. */
  readonly signal: AbortSignal
  /** Push inbound events into the core; core dedups on `eventId`. */
  emit(events: InboundEvent | readonly InboundEvent[]): Promise<void>
  /** Blob port for inbound staging / outbound reads; absent when core runs without a blob store. */
  readonly blobs?: ImBlobs
}

/**
 * One provider adapter. `start` connects (open the socket, subscribe) and
 * resolves only after intake is live; `stop` disconnects and drains in-flight
 * work. `outbound` applies already-claimed operations and reports per-op
 * receipts; throw for provider-wide failures (loop retries), report per-op
 * through `OutboundReceipt` when only some operations apply.
 */
export interface ImProvider {
  /** Provider key; equals `Destination.type` for everything it emits. */
  readonly provider: string
  /** Instance id within the provider (config-selected, e.g. "prod"). */
  readonly instanceId: string
  capabilities(): ImCapabilities
  start(ctx: ImProviderStartContext): Promise<void>
  stop(): Promise<void>
  outbound(ops: readonly OutboundOperation[]): Promise<OutboundReceipt[]>
  /** Canonical markdown → provider body. Pure; no network. */
  format(markdown: string): OutboundBody
  /** Pull a directory snapshot from the platform (capabilities.directorySync). */
  collectDirectory?(): Promise<DirectorySyncPush>
  /**
   * Provider-native approval card renderer. The bridge consults it for
   * this provider's pending-approval deliveries before any injected
   * override and before the neutral-text fallback.
   */
  approvalCardRenderer?: ImApprovalCardRenderer
  /** Provider-native destination for a chat id (mainly tests and tooling). */
  destination(chatId: string, threadId?: string): Destination
}

/** Resolve an adapter's config: `(Schema) => ImProviderConfig` per package. */
export type ImProviderConfig = Record<string, unknown>
