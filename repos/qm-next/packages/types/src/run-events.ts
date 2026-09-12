/**
 * Run event stream: the delta/progress/status channel a surface (SSE) or
 * any in-process consumer subscribes to for a run in flight. Frozen at the
 * M3 serial gate (11.0) — the web-ui lane programs against this port.
 *
 * M3 ships the in-memory bus; a Postgres-backed log can replace it later
 * without contract change.
 */
import type { TurnStatus } from './turn.ts'

/** Fields the publisher fills; `seq` is per-run monotonic from 0. */
interface RunEventEnvelope {
  runId: string
  sessionId: string
  seq: number
}

export interface RunDeltaEvent extends RunEventEnvelope {
  kind: 'delta'
  /** Incremental assistant text. */
  text: string
}

export interface RunProgressEvent extends RunEventEnvelope {
  kind: 'progress'
  toolCalls: number
}

export interface RunStatusEvent extends RunEventEnvelope {
  kind: 'status'
  /** `running` on start; otherwise the terminal TurnStatus. */
  status: TurnStatus | 'running'
}

export type RunEvent = RunDeltaEvent | RunProgressEvent | RunStatusEvent

/** A publisher-side event: envelope fields (runId/sessionId/seq) still missing. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type RunEventDraft = DistributiveOmit<RunEvent, 'runId' | 'sessionId' | 'seq'>

export interface RunEventBus {
  /** Publish one event; events for a closed run are dropped. */
  publish(event: RunEvent): void
  /** Live subscription for one run; returns the unsubscriber. */
  subscribe(runId: string, listener: (event: RunEvent) => void): () => void
  /** Buffered events for one run, oldest first (SSE reconnect catch-up). */
  replay(runId: string): RunEvent[]
  /** Mark the run stream terminal: buffered events stay readable, publishing stops. */
  close(runId: string): void
}
