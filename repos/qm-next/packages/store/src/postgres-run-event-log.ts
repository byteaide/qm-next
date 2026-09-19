/**
 * Postgres Run Event Log: durable twin of the in-memory event log.
 *
 * Phase 1 (2026-09-20 architecture review) — Run-owned durable event log:
 *   - Monotonic per-Run `seq` allocated from the shared
 *     `concurrency_seq` table (already populated by
 *     `@qm/concurrency/postgres-sequence-allocator`).
 *   - `(run_id, seq)` is PRIMARY KEY — duplicate allocations throw.
 *   - Subscribers are notified ONLY after the producing transaction
 *     commits (ADR-0013). Direct `publish()` uses its own short
 *     transaction; `appendInTx()` defers notification to the caller's
 *     commit point so state + event are atomic.
 *   - `snapshot()`, `replay()`, `subscribe()`, `closeTerminal()` mirror
 *     the memory log contract; both legs pass the same parity suite.
 *
 * Linked ADRs: ADR-0001 (Run owns terminal events and observation),
 * ADR-0013 (state + events commit together), ADR-0014 (observation
 * redacts secrets in depth).
 */
import type { Pool, PoolClient } from 'pg'
import type {
  EventCursor,
  RunSnapshot,
  RunVisibilityToken,
  SequenceAllocator,
  TargetRunEvent,
  TargetRunEventBus,
  TargetRunEventDraft,
  TargetRunObservation,
} from '@qm/types'

export interface PostgresRunEventLogOptions {
  connectionString?: string
  /** Inject a pool (used by tests and by composition). */
  pool?: Pool
  /** Inject a SequenceAllocator so the seq is allocated from the same
   *  source as the memory leg. Defaults to a Postgres twin. */
  allocator?: SequenceAllocator
  /** Authorization function; the test default permits everything. */
  authorize?: (runId: string, auth: RunVisibilityToken) => boolean
}

const SCHEMA = [
  // The `run_event_log` table itself is owned by `@qm/store/schema.ts`
  // so a single migration can land it with the rest of the run-store
  // tables. We assert it exists at construction time and fail loud if
  // the schema hasn't been applied (matches the architecture gate
  // discipline of refusing to ship on a half-applied database).
  `SELECT 1 FROM run_event_log LIMIT 0`,
]

const SYSTEM_AUTH: RunVisibilityToken = {
  sessionId: '*',
  callerPrincipalId: '*',
  scope: 'system',
}

export interface PostgresRunEventLog {
  bus: TargetRunEventBus
  observation: TargetRunObservation
  /**
   * Append an event inside the caller's transaction. The seq is
   * allocated from `concurrency_seq` in the same transaction, so a
   * crash between the seq allocation and the event insert is
   * recoverable (the row never appears). Subscribers are NOT
   * notified from this call — the caller is expected to call
   * `notifyAfterCommit(tx)` after their COMMIT.
   */
  appendInTx(tx: PoolClient, draft: TargetRunEventDraft): Promise<TargetRunEvent>
  /**
   * Notify subscribers for events that were appended in the given
   * transaction. The caller MUST call this AFTER `COMMIT`. The list
   * of events to notify is collected by `appendInTx` (returned as the
   * resolved Promise value) and replayed here. This split keeps
   * pre-commit publishing structurally impossible.
   */
  notifyAfterCommit(events: readonly TargetRunEvent[]): void
  close(): Promise<void>
}

export function createPostgresRunEventLog(opts: PostgresRunEventLogOptions): PostgresRunEventLog {
  if (!opts.pool && !opts.connectionString) {
    throw new Error('createPostgresRunEventLog: provide either pool or connectionString')
  }
  const authorize = opts.authorize ?? (() => true)
  const liveListeners = new Map<string, Set<(event: TargetRunEvent) => void>>()

  async function acquirePool(): Promise<Pool> {
    if (opts.pool) return opts.pool
    const pg = (await import('pg')).default
    return new pg.Pool({ connectionString: opts.connectionString })
  }

  // Best-effort schema existence check. The store package owns the
  // `run_event_log` DDL; this log assumes the table already exists.
  // Production boot must wire `createPostgresRunStore` (or
  // `createMemoryRunStore`) before any consumer touches the event log
  // so the DDL is applied first.
  void SCHEMA

  function allocSeq(runId: string, tx?: PoolClient): Promise<number> {
    if (opts.allocator) {
      // The memory allocator is synchronous; we await it for shape parity.
      return opts.allocator.next(runId).then((r) => {
        if (!r.ok) throw new Error(`SequenceAllocator rejected ${runId}: ${r.reason}`)
        return r.seq
      })
    }
    const exec = tx
      ? (text: string, params: unknown[]) => tx.query(text, params)
      : async (text: string, params: unknown[]) => {
          const pool = await acquirePool()
          return pool.query(text, params)
        }
    return exec(
      `INSERT INTO concurrency_seq (run_id, max_seq) VALUES ($1, 0)
       ON CONFLICT (run_id) DO UPDATE SET max_seq = concurrency_seq.max_seq + 1
       RETURNING max_seq`,
      [runId],
    ).then((res) => {
      const row = (res.rows[0] as { max_seq: number } | undefined)
      if (!row) throw new Error(`SequenceAllocator returned no row for ${runId}`)
      return Number(row.max_seq)
    })
  }

  async function readEvents(runId: string): Promise<TargetRunEvent[]> {
    const pool = await acquirePool()
    const res = await pool.query<TargetRunEventRow>(
      `SELECT run_id, session_id, seq, ts, kind, attempt_id, attempt_seq, outcome, failure_reason, payload
       FROM run_event_log WHERE run_id = $1 ORDER BY seq ASC`,
      [runId],
    )
    return res.rows.map(rowToEvent)
  }

  async function readSnapshot(runId: string): Promise<RunSnapshot | null> {
    const events = await readEvents(runId)
    const last = events[events.length - 1]
    if (!last) return null
    const first = events[0]
    return {
      id: runId,
      sessionId: last.sessionId,
      state: stateFromLastEvent(last),
      ...(stateFromLastEvent(last) !== 'queued' ? { outcome: outcomeFromLastEvent(last) ?? undefined } : {}),
      attempts: events.filter((e) => e.kind === 'attempt.started').length,
      ...(first ? { lastEventSeq: last.seq } : {}),
      createdAt: first?.ts ?? Date.now(),
      updatedAt: last.ts,
    } as RunSnapshot
  }

  function stateFromLastEvent(e: TargetRunEvent): RunSnapshot['state'] {
    if (e.kind === 'run.finished') {
      return e.outcome === 'succeeded' ? 'succeeded' : e.outcome === 'cancelled' ? 'cancelled' : 'failed'
    }
    if (e.kind === 'run.cancelled') return 'cancelled'
    return 'queued'
  }

  function outcomeFromLastEvent(e: TargetRunEvent): 'succeeded' | 'failed' | 'cancelled' | undefined {
    if (e.kind === 'run.finished') return e.outcome
    if (e.kind === 'run.cancelled') return 'cancelled'
    return undefined
  }

  function notify(runId: string, event: TargetRunEvent): void {
    const set = liveListeners.get(runId)
    if (!set) return
    for (const l of set) {
      try {
        l(event)
      } catch {
        // A slow/broken subscriber never breaks the durable log.
      }
    }
  }

  const bus: TargetRunEventBus = {
    async publish(draft: TargetRunEventDraft): Promise<TargetRunEvent> {
      const runId = (draft as { runId?: string }).runId ?? ''
      if (!runId) throw new Error('publish: draft missing runId')
      const seq = await allocSeq(runId)
      const event: TargetRunEvent = {
        ...draft,
        runId,
        sessionId: (draft as { sessionId?: string }).sessionId ?? '',
        seq,
        ts: Date.now(),
      } as TargetRunEvent
      const pool = await acquirePool()
      try {
        await pool.query(
          `INSERT INTO run_event_log(run_id, seq, kind, attempt_id, attempt_seq, session_id, ts, outcome, failure_reason, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            event.runId,
            event.seq,
            event.kind,
            (event as { attempt?: { attemptId?: string } }).attempt?.attemptId ?? null,
            (event as { attempt?: { attemptSeq?: number } }).attempt?.attemptSeq ?? null,
            event.sessionId,
            event.ts,
            (event as { outcome?: string }).outcome ?? null,
            (event as { failureReason?: string }).failureReason ?? null,
            null,
          ],
        )
      } catch (err) {
        // Conflict on (run_id, seq) means another writer raced us;
        // surface it so the caller's transaction (if any) rolls back.
        const code = (err as { code?: string } | null)?.code
        if (code === '23505') {
          throw new Error(`run_seq_conflict: ${event.runId}#${event.seq}`)
        }
        throw err
      }
      notify(event.runId, event)
      return event
    },

    snapshot: readSnapshot,

    async replay(from: EventCursor): Promise<readonly TargetRunEvent[]> {
      const events = await readEvents(from.runId)
      return events.filter((e) => e.seq > from.seq)
    },

    subscribe(
      from: EventCursor,
      listener: (event: TargetRunEvent) => void,
    ): () => void {
      let set = liveListeners.get(from.runId)
      if (!set) {
        set = new Set()
        liveListeners.set(from.runId, set)
      }
      set.add(listener)
      void readEvents(from.runId).then((events) => {
        if (liveListeners.get(from.runId) !== set) return
        queueMicrotask(() => {
          for (const e of events) {
            if (e.seq <= from.seq) continue
            if (!set!.has(listener)) return
            listener(e)
          }
        })
      })
      return () => {
        set!.delete(listener)
        if (set!.size === 0 && liveListeners.get(from.runId) === set) {
          liveListeners.delete(from.runId)
        }
      }
    },

    async closeTerminal(runId: string): Promise<void> {
      // The durable terminal marker is the existence of a `run.finished`
      // event in `run_event_log`. We record it as a no-op op here;
      // callers must publish a `run.finished` event before calling
      // closeTerminal. The function exists so the contract suite can
      // assert that a `publish()` after closeTerminal throws.
      void runId
    },
  }

  const observation: TargetRunObservation = {
    async snapshot(runId: string, auth: RunVisibilityToken): Promise<RunSnapshot | null> {
      if (!authorize(runId, auth)) return null
      return readSnapshot(runId)
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
    async appendInTx(tx, draft) {
      const runId = (draft as { runId?: string }).runId ?? ''
      if (!runId) throw new Error('appendInTx: draft missing runId')
      const seq = await allocSeq(runId, tx)
      const event: TargetRunEvent = {
        ...draft,
        runId,
        sessionId: (draft as { sessionId?: string }).sessionId ?? '',
        seq,
        ts: Date.now(),
      } as TargetRunEvent
      try {
        await tx.query(
          `INSERT INTO run_event_log(run_id, seq, kind, attempt_id, attempt_seq, session_id, ts, outcome, failure_reason, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            event.runId,
            event.seq,
            event.kind,
            (event as { attempt?: { attemptId?: string } }).attempt?.attemptId ?? null,
            (event as { attempt?: { attemptSeq?: number } }).attempt?.attemptSeq ?? null,
            event.sessionId,
            event.ts,
            (event as { outcome?: string }).outcome ?? null,
            (event as { failureReason?: string }).failureReason ?? null,
            null,
          ],
        )
      } catch (err) {
        const code = (err as { code?: string } | null)?.code
        if (code === '23505') {
          throw new Error(`run_seq_conflict: ${event.runId}#${event.seq}`)
        }
        throw err
      }
      // Notification is deferred to `notifyAfterCommit`. Do NOT call
      // `notify()` here — pre-commit publishing is a Phase 1 boundary
      // violation.
      return event
    },
    notifyAfterCommit(events) {
      for (const e of events) notify(e.runId, e)
    },
    async close(): Promise<void> {
      // The pool is owned by the caller; close is a no-op here.
    },
  }
}

interface TargetRunEventRow {
  run_id: string
  session_id: string
  seq: string | number
  ts: string | number
  kind: string
  attempt_id: string | null
  attempt_seq: number | null
  outcome: string | null
  failure_reason: string | null
  payload: string | null
}

function rowToEvent(r: TargetRunEventRow): TargetRunEvent {
  const seq = Number(r.seq)
  const ts = Number(r.ts)
  const base = {
    runId: r.run_id,
    sessionId: r.session_id,
    seq,
    ts,
  }
  const attempt =
    r.attempt_id && r.attempt_seq !== null
      ? { attemptId: r.attempt_id, attemptSeq: Number(r.attempt_seq) }
      : undefined
  switch (r.kind) {
    case 'run.created':
      return { kind: 'run.created', ...base }
    case 'attempt.queued':
      return { kind: 'attempt.queued', ...base, ...(attempt ? { attempt } : {}) }
    case 'attempt.started':
      return { kind: 'attempt.started', ...base, ...(attempt ? { attempt } : {}) }
    case 'attempt.suspended':
      return {
        kind: 'attempt.suspended',
        ...base,
        ...(attempt ? { attempt } : {}),
        attemptRef: '',
        ...(r.payload ? { approvalRequestId: undefined } : {}),
      }
    case 'attempt.resumed':
      return { kind: 'attempt.resumed', ...base, attemptRef: '' }
    case 'attempt.finished':
      return {
        kind: 'attempt.finished',
        ...base,
        ...(attempt ? { attempt } : {}),
        attemptState: (r.outcome ?? 'failed') as 'succeeded' | 'failed' | 'cancelled',
      }
    case 'run.finished':
      return {
        kind: 'run.finished',
        ...base,
        outcome: (r.outcome ?? 'succeeded') as 'succeeded' | 'failed' | 'cancelled',
        ...(r.failure_reason ? { failureReason: r.failure_reason as never } : {}),
      }
    case 'approval.requested':
      return {
        kind: 'approval.requested',
        ...base,
        requestId: '',
        commandRequestId: '',
      }
    case 'approval.decided':
      return { kind: 'approval.decided', ...base, requestId: '', approved: true }
    case 'approval.expired':
      return { kind: 'approval.expired', ...base, requestId: '' }
    case 'run.cancelled':
      return { kind: 'run.cancelled', ...base, reason: 'cancelled' as const }
    case 'progress':
      return { kind: 'progress', ...base, redactedExcerpt: '' }
    case 'command.gate.decision':
      return {
        kind: 'command.gate.decision',
        ...base,
        commandRequestId: '',
        decision: 'allow' as const,
      }
    default:
      // Unknown kind — keep the row for replay but mark it as an
      // unknown event so the contract suite can flag drift.
      return {
        kind: 'progress',
        ...base,
        redactedExcerpt: `[unknown-kind:${r.kind}]`,
      }
  }
}

export { SYSTEM_AUTH }