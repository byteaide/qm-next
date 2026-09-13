/**
 * Run signal contract: out-of-band abort/steer messages addressed to a
 * running turn. In-memory and Postgres-backed stores implement the same
 * port; the poll helper that harnesses consume lives in @qm/runs.
 */
import type { TurnInput } from './turn.ts'

export type RunSignalKind = 'abort' | 'steer'

export interface RunSignal {
  kind: RunSignalKind
  text?: string
  ts?: string
  request?: TurnInput
}

export interface RunSignalStore {
  send(runId: string, signal: RunSignal): Promise<void>
  takePending(runId: string): Promise<RunSignal[]>
  pendingRunIds(): Promise<string[]>
  prune(olderThanMs: number): Promise<void>
  onSignal(runId: string, cb: () => void): () => void
  close?(): Promise<void>
}
