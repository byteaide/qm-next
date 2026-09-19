/**
 * Legacy in-memory Run event stream: the delta/progress/status channel a
 * surface (SSE) or any in-process consumer subscribes to for a run in
 * flight. Frozen at the M3 serial gate (11.0) — the web-ui lane programs
 * against this port during migration.
 *
 * Phase 0 (2026-09-19 architecture review): the canonical target contract
 * lives in `./run-observation.ts`. New code MUST use the typed envelope
 * (`RunEvent`/`RunEventBus`/`RunEventDraft` re-exported from index); this
 * file keeps the legacy names exported as `LegacyRunEvent*` for code that
 * has not yet migrated. The two shapes are deliberately different (the
 * target envelope adds `ts`, `attempt` identity, and redaction markers).
 *
 * M3 ships the in-memory bus; the target Run Observation in
 * `./run-observation.ts` replaces it in Phase 1 without contract change
 * for migration-aware callers.
 */
import type { TurnStatus } from './turn.ts'

/** Fields the publisher fills; `seq` is per-run monotonic from 0. */
interface LegacyRunEventEnvelope {
  runId: string
  sessionId: string
  seq: number
}

export interface LegacyRunDeltaEvent extends LegacyRunEventEnvelope {
  kind: 'delta'
  /** Incremental assistant text. */
  text: string
}

export interface LegacyRunProgressEvent extends LegacyRunEventEnvelope {
  kind: 'progress'
  toolCalls: number
}

export interface LegacyRunStatusEvent extends LegacyRunEventEnvelope {
  kind: 'status'
  /** `running` on start; otherwise the terminal TurnStatus. */
  status: TurnStatus | 'running'
}

export type LegacyRunEvent = LegacyRunDeltaEvent | LegacyRunProgressEvent | LegacyRunStatusEvent

/** A publisher-side event: envelope fields (runId/sessionId/seq) still missing. */
type LegacyDistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type LegacyRunEventDraft = LegacyDistributiveOmit<LegacyRunEvent, 'runId' | 'sessionId' | 'seq'>

export interface LegacyRunEventBus {
  /** Publish one event; events for a closed run are dropped. */
  publish(event: LegacyRunEvent): void
  /** Live subscription for one run; returns the unsubscriber. */
  subscribe(runId: string, listener: (event: LegacyRunEvent) => void): () => void
  /** Buffered events for one run, oldest first (SSE reconnect catch-up). */
  replay(runId: string): LegacyRunEvent[]
  /** Mark the run stream terminal: buffered events stay readable, publishing stops. */
  close(runId: string): void
}

/**
 * @deprecated Use `RunEventBus` from `@qm/types` (the target Run
 * Observation contract in `./run-observation.ts`). These aliases keep
 * existing M3 imports compiling during the migration window; remove
 * once web-ui has switched to the target contract.
 */
export type RunEvent = LegacyRunEvent
export type RunEventDraft = LegacyRunEventDraft
export type RunEventBus = LegacyRunEventBus

