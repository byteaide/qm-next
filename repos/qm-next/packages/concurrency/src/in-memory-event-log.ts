/**
 * In-memory durable event log: a phase-0 reference implementation of the
 * target Run Observation contract. Phase 1 swaps the Postgres twin in.
 *
 * The memory log is "durable" in the test sense — it lives for the life
 * of the process and is what the contract suite uses to compare memory
 * vs Postgres implementations. Producers call `publish` with a draft and
 * the log assigns the next monotonic `seq` from `SequenceAllocator`.
 *
 * Linked ADRs: ADR-0001 (Run owns terminal events and observation),
 * ADR-0013 (Run state and events commit together).
 */
import type {
  EventCursor,
  RunVisibilityToken,
  SequenceAllocator,
  TargetRunEvent,
  TargetRunEventBus,
  TargetRunEventDraft,
  TargetRunObservation,
  RunSnapshot,
} from '@qm/types'

export interface InMemoryEventLogOptions {
  /** Inject the allocator for shared-instance parity with Postgres tests. */
  allocator: SequenceAllocator
  /** Authorization function; the test default permits everything. */
  authorize?: (runId: string, auth: RunVisibilityToken) => boolean
}

export interface InMemoryEventLog {
  /** Internal event-bus surface used by producers. */
  bus: TargetRunEventBus
  /** Read-only Run Observation surface exposed to API and Web. */
  observation: TargetRunObservation
  /** Read all stored events for a Run, oldest first (test-only inspection). */
  readAll(runId: string): readonly TargetRunEvent[]
  /** Reset all state. Test-only — production code MUST NOT call this. */
  reset(): void
}

const SYSTEM_AUTH: RunVisibilityToken = {
  sessionId: '*',
  callerPrincipalId: '*',
  scope: 'system',
}

export function createInMemoryEventLog(opts: InMemoryEventLogOptions): InMemoryEventLog {
  const events = new Map<string, TargetRunEvent[]>()
  const terminal = new Set<string>()
  const liveListeners = new Map<string, Set<(event: TargetRunEvent) => void>>()
  const authorize = opts.authorize ?? (() => true)

  const bus: TargetRunEventBus = {
    async publish(draft: TargetRunEventDraft): Promise<TargetRunEvent> {
      // The draft carries no envelope fields; the SequenceAllocator
      // decides the seq (Phase 0 boundary check: producers never assign).
      const tentativeRunId = (draft as { runId?: string }).runId ?? ''
      const alloc = await opts.allocator.next(tentativeRunId)
      if (!alloc.ok) {
        throw new Error(`SequenceAllocator rejected publish: ${alloc.reason}`)
      }
      const event = {
        ...draft,
        runId: tentativeRunId,
        sessionId: (draft as { sessionId?: string }).sessionId ?? '',
        seq: alloc.seq,
        ts: Date.now(),
      } as TargetRunEvent
      const list = events.get(event.runId) ?? []
      if (terminal.has(event.runId)) {
        throw new Error(`cannot publish on closed Run ${event.runId}`)
      }
      list.push(event)
      events.set(event.runId, list)
      if (event.kind === 'run.finished') terminal.add(event.runId)
      for (const l of liveListeners.get(event.runId) ?? []) {
        try {
          l(event)
        } catch {
          // A slow/broken subscriber never breaks the durable log.
        }
      }
      return event
    },

    async snapshot(runId: string): Promise<RunSnapshot | null> {
      const list = events.get(runId) ?? []
      const last = list[list.length - 1]
      if (!last) return null
      const snap: RunSnapshot = {
        id: runId,
        sessionId: last.sessionId,
        state: last.kind === 'run.finished'
          ? (last.outcome === 'succeeded' ? 'succeeded' : last.outcome === 'cancelled' ? 'cancelled' : 'failed')
          : 'queued',
        ...(last.kind === 'run.finished' ? { outcome: last.outcome } : {}),
        attempts: list.filter((e) => e.kind === 'attempt.started').length,
        lastEventSeq: last.seq,
        createdAt: list[0]?.ts ?? Date.now(),
        updatedAt: last.ts,
      }
      return snap
    },

    async replay(from: EventCursor): Promise<readonly TargetRunEvent[]> {
      const list = events.get(from.runId) ?? []
      return list.filter((e) => e.seq > from.seq)
    },

    subscribe(
      from: EventCursor,
      listener: (event: TargetRunEvent) => void,
    ): () => void {
      // Replay first, then live.
      const replayed = (events.get(from.runId) ?? []).filter((e) => e.seq > from.seq)
      queueMicrotask(() => {
        for (const e of replayed) listener(e)
      })
      let set = liveListeners.get(from.runId)
      if (!set) {
        set = new Set()
        liveListeners.set(from.runId, set)
      }
      set.add(listener)
      return () => {
        set!.delete(listener)
        if (set!.size === 0 && liveListeners.get(from.runId) === set) {
          liveListeners.delete(from.runId)
        }
      }
    },

    async closeTerminal(runId: string): Promise<void> {
      terminal.add(runId)
    },
  }

  const observation: TargetRunObservation = {
    async snapshot(runId: string, auth: RunVisibilityToken): Promise<RunSnapshot | null> {
      if (!authorize(runId, auth)) return null
      return bus.snapshot(runId)
    },
    async replay(from: EventCursor, auth: RunVisibilityToken): Promise<readonly TargetRunEvent[]> {
      if (!authorize(from.runId, auth)) return []
      return bus.replay(from)
    },
    subscribe(
      from: EventCursor,
      auth: RunVisibilityToken,
      listener: (event: TargetRunEvent) => void,
    ): () => void {
      if (!authorize(from.runId, auth)) return () => {}
      return bus.subscribe(from, listener)
    },
  }

  return {
    bus,
    observation,
    readAll(runId: string): readonly TargetRunEvent[] {
      return [...(events.get(runId) ?? [])]
    },
    reset(): void {
      events.clear()
      terminal.clear()
      liveListeners.clear()
    },
  }
}

export { SYSTEM_AUTH }
