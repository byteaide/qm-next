/**
 * Postgres RunStore: durable translation of the frozen queue contract.
 * Claim atomicity via FOR UPDATE SKIP LOCKED plus a partial unique index
 * enforcing one running run per session; lease-guarded state transitions.
 * Translated from qm's postgres-run-store minus the tool ledger and legacy
 * migrations.
 */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type {
  EnqueueInput,
  EnqueueResult,
  FailureReason,
  ReapEvent,
  Run,
  RunDeliveryState,
  RunSource,
  RunState,
  RunStore,
  TurnInput,
  TurnResult,
} from '@qm/types'
import { assertTargetRunInvariant, isTerminal, isTerminalTargetState, type RolloutFlag } from '@qm/types'
import { createPgPool, errMessage, type PgPool } from './pg-pool.ts'
import { RUN_SCHEMA_STATEMENTS } from './schema.ts'

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505'
}

function rowToRun(r: Record<string, unknown>): Run {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    status: r.status as Run['status'],
    targetState: (r.target_state as RunState | null) ?? 'queued',
    runSource: (r.run_source as RunSource | null) ?? 'legacy',
    failureReason: (r.failure_reason as FailureReason | null) ?? undefined,
    request: JSON.parse(r.request as string) as TurnInput,
    result: r.result != null ? (JSON.parse(r.result as string) as TurnResult) : null,
    deliveryState: r.delivery_state != null ? (JSON.parse(r.delivery_state as string) as RunDeliveryState) : null,
    dedupKey: (r.idempotency_key as string | null) ?? null,
    attempts: Number(r.attempts),
    errorAttempts: Number(r.error_attempts),
    maxAttempts: Number(r.max_attempts),
    leaseToken: (r.lease_token as string | null) ?? null,
    leaseExpiresAt: r.lease_expires_at === null ? null : Number(r.lease_expires_at),
    workerId: (r.worker_id as string | null) ?? null,
    createdAt: Number(r.created_at),
    startedAt: r.started_at === null ? null : Number(r.started_at),
    finishedAt: r.finished_at === null ? null : Number(r.finished_at),
  }
}

export interface PostgresRunStore extends RunStore {
  close(): Promise<void>
}

export function createPostgresRunStore(
  connectionString: string,
  opts?: { maxClaims?: number; runSourceFlag?: RolloutFlag | null },
): PostgresRunStore {
  const maxClaims = opts?.maxClaims ?? Number.POSITIVE_INFINITY
  const runSourceFlag = opts?.runSourceFlag ?? null
  const events = new EventEmitter()
  events.setMaxListeners(0)
  const { query, close: closePool }: PgPool = createPgPool(connectionString, RUN_SCHEMA_STATEMENTS)

  /**
   * Slice 1.5 — read the current `run_source` literal from the
   * registered flag. The flag is read at write time so flipping the
   * env override in production takes effect on the next enqueue;
   * cached reads would defeat the rollout switch.
   */
  function currentRunSource(): RunSource {
    return runSourceFlag && runSourceFlag.read() ? 'target' : 'legacy'
  }

  const terminalListeners: Array<(run: Run) => void> = []
  function settle(run: Run | null): void {
    if (!run) return
    // Slice 1.5 — same dual-terminal check as memory-run-store so
    // target rows fire the terminal event via `targetState` while
    // legacy rows continue to fire via `status`.
    if (!isTerminal(run.status) && !isTerminalTargetState(run.targetState)) return
    events.emit(run.id, run)
    for (const listener of terminalListeners) listener(run)
  }

  async function getRun(id: string): Promise<Run | null> {
    const { rows } = await query('SELECT * FROM runs WHERE id = $1', [id])
    return rows[0] ? rowToRun(rows[0]) : null
  }

  async function retire(
    run: Run,
    error: string,
    retry: boolean,
    opts?: { ifExpiredAt?: number; countsAsError?: boolean; failureReason?: FailureReason },
  ): Promise<{ requeued: boolean; applied: boolean }> {
    const ifExpiredAt = opts?.ifExpiredAt ?? null
    const countsAsError = opts?.countsAsError ?? false
    const errorAttemptsAfter = run.errorAttempts + (countsAsError ? 1 : 0)
    const overClaimed = run.attempts >= maxClaims
if (retry && errorAttemptsAfter < run.maxAttempts && !overClaimed) {
      const { rowCount } = await query(
        `UPDATE runs SET status='pending', target_state='queued', failure_reason=NULL,
           lease_token=NULL, lease_expires_at=NULL, worker_id=NULL,
           error_attempts=error_attempts+$4
         WHERE id=$1 AND lease_token=[redacted-credential] AND status='running' AND ($3::bigint IS NULL OR lease_expires_at <= $3)`,
        [run.id, run.leaseToken, ifExpiredAt, countsAsError ? 1 : 0],
      )
      return { requeued: rowCount > 0, applied: rowCount > 0 }
    }
    const reason =
      !countsAsError && overClaimed && retry && errorAttemptsAfter < run.maxAttempts
        ? `run parked after ${run.attempts} claims without completing (suspected crash loop)`
        : error
const result: TurnResult = { status: 'failed', sessionId: run.sessionId, reason }
    const failureReason = opts?.failureReason ?? 'execution_failed'
    const { rowCount } = await query(
      `UPDATE runs SET status='failed', target_state='failed', failure_reason=$7, result=$4,
         lease_token=NULL, lease_expires_at=NULL, worker_id=NULL, finished_at=$5,
         error_attempts=error_attempts+$6
       WHERE id=$1 AND lease_token=[redacted-credential] AND status='running' AND ($3::bigint IS NULL OR lease_expires_at <= $3)`,
      [run.id, run.leaseToken, ifExpiredAt, JSON.stringify(result), Date.now(), countsAsError ? 1 : 0, failureReason],
    )
    if (rowCount > 0) settle(await getRun(run.id))
    return { requeued: false, applied: rowCount > 0 }
  }

  const store: PostgresRunStore = {
    ...(Number.isFinite(maxClaims) ? { maxClaims } : {}),

    async enqueue({ sessionId, request, dedupKey, maxAttempts = 3 }: EnqueueInput): Promise<EnqueueResult> {
      const id = randomUUID()
      const runSource = currentRunSource()
      const { rows: inserted } = await query(
        `INSERT INTO runs(id, session_id, status, target_state, run_source, request, idempotency_key, attempts, max_attempts, created_at)
         VALUES ($1,$2,'pending','queued',$7,$3,$4,0,$5,$6)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
        [id, sessionId, JSON.stringify(request), dedupKey ?? null, maxAttempts, Date.now(), runSource],
      )
      if (inserted[0]) {
        const run = rowToRun(inserted[0])
        assertTargetRunInvariant(run)
        return { run, deduped: false }
      }
      const { rows } = await query('SELECT * FROM runs WHERE idempotency_key = $1', [dedupKey])
      const run = rowToRun(rows[0]!)
      assertTargetRunInvariant(run)
      return { run, deduped: true }
    },

async claim(workerId, ttlMs): Promise<Run | null> {
      const token = [redacted-credential])
      const now = Date.now()
      try {
        const { rows } = await query(
          `UPDATE runs SET status='running', target_state='running', lease_token=[redacted-credential], lease_expires_at=$2, worker_id=$3,
             attempts=attempts+1, started_at=COALESCE(started_at,$4)
           WHERE id = (
             SELECT id FROM runs WHERE status='pending'
               AND session_id NOT IN (SELECT session_id FROM runs WHERE status='running')
             ORDER BY created_at ASC, seq ASC FOR UPDATE SKIP LOCKED LIMIT 1
           ) RETURNING *`,
          [token, now + ttlMs, workerId, now],
        )
        return rows[0] ? rowToRun(rows[0]) : null
      } catch (err) {
        if (isUniqueViolation(err)) return null
        throw err
      }
    },

async claimById(runId, workerId, ttlMs): Promise<Run | null> {
      const token = [redacted-credential])
      const now = Date.now()
      try {
        const { rows } = await query(
          `UPDATE runs SET status='running', target_state='running', lease_token=[redacted-credential], lease_expires_at=$2, worker_id=$3,
             attempts=attempts+1, started_at=COALESCE(started_at,$4)
           WHERE id = (
             SELECT id FROM runs WHERE id=$5 AND status='pending'
               AND session_id NOT IN (SELECT session_id FROM runs WHERE status='running')
             FOR UPDATE SKIP LOCKED LIMIT 1
           ) RETURNING *`,
          [token, now + ttlMs, workerId, now, runId],
        )
        return rows[0] ? rowToRun(rows[0]) : null
      } catch (err) {
        if (isUniqueViolation(err)) return null
        throw err
      }
    },

    async heartbeat(runId, leaseToken, ttlMs): Promise<boolean> {
      const { rowCount } = await query(
        "UPDATE runs SET lease_expires_at=$1 WHERE id=$2 AND lease_token=$3 AND status='running'",
        [Date.now() + ttlMs, runId, leaseToken],
      )
      return rowCount > 0
    },

    async releaseLease(runId, leaseToken): Promise<boolean> {
      const { rowCount } = await query(
        "UPDATE runs SET status='pending', target_state='queued', failure_reason=NULL, lease_token=NULL, lease_expires_at=NULL, worker_id=NULL WHERE id=$1 AND lease_token=$2 AND status='running'",
        [runId, leaseToken],
      )
      return rowCount > 0
    },

    async complete(runId, leaseToken, result): Promise<boolean> {
      // Slice 1.5 — fetch the row first so we know whether to skip
      // the legacy `status='done'` write (target rows must not carry
      // the literal; see `assertTargetRunInvariant`). The conditional
      // branches keep PG parity with the memory twin.
      const existing = await getRun(runId)
      if (!existing || existing.leaseToken !== leaseToken) return false
      const setStatus = existing.runSource === 'legacy' ? "status='done'," : ''
      const { rowCount } = await query(
        `UPDATE runs SET ${setStatus} target_state='succeeded', failure_reason=NULL, result=$1, lease_token=NULL, lease_expires_at=NULL, finished_at=$2 WHERE id=$3 AND lease_token=$4 AND status='running'`,
        [JSON.stringify(result), Date.now(), runId, leaseToken],
      )
      if (rowCount > 0) {
        settle(await getRun(runId))
        return true
      }
      return false
    },

    async fail(runId, leaseToken, error, opts): Promise<{ requeued: boolean }> {
      const run = await getRun(runId)
      if (!run || run.leaseToken !== leaseToken) return { requeued: false }
      return { requeued: (await retire(run, error, opts?.retry !== false, { countsAsError: true })).requeued }
    },

    async setDeliveryState(runId, leaseToken, state: RunDeliveryState): Promise<boolean> {
      const { rowCount } =
        leaseToken === null
          ? await query('UPDATE runs SET delivery_state=$1 WHERE id=$2', [JSON.stringify(state), runId])
          : await query('UPDATE runs SET delivery_state=$1 WHERE id=$2 AND lease_token=$3', [
              JSON.stringify(state),
              runId,
              leaseToken,
            ])
      return rowCount > 0
    },

    onTerminal(listener): void {
      terminalListeners.push(listener)
    },

    get: getRun,

    async activeForThread(sessionId): Promise<Run | null> {
      const { rows } = await query(
        "SELECT * FROM runs WHERE session_id = $1 AND status IN ('pending','running') ORDER BY created_at DESC LIMIT 1",
        [sessionId],
      )
      return rows[0] ? rowToRun(rows[0]) : null
    },

    async inFlightForThread(sessionId): Promise<Run[]> {
      const { rows } = await query(
        "SELECT * FROM runs WHERE session_id = $1 AND status IN ('pending','running') ORDER BY created_at ASC, seq ASC",
        [sessionId],
      )
      return rows.map(rowToRun)
    },

    async withdraw(runId): Promise<boolean> {
      const { rowCount } = await query("DELETE FROM runs WHERE id = $1 AND status = 'pending'", [runId])
      return rowCount > 0
    },

    async activeSessionIds(): Promise<string[]> {
      const { rows } = await query("SELECT DISTINCT session_id FROM runs WHERE status IN ('pending','running')")
      return rows.map((r) => r.session_id as string)
    },

    async list({ limit = 200 }: { limit?: number } = {}): Promise<Run[]> {
      const { rows } = await query('SELECT * FROM runs ORDER BY created_at DESC LIMIT $1', [limit])
      return rows.map(rowToRun)
    },

    async reapExpired(
      onRetired?: (sessionIds: string[]) => Promise<void>,
      opts?: {
        maxAgeMs?: number
        onReap?: (event: ReapEvent) => void
        isNewerSession?: (run: Run) => Promise<boolean>
      },
    ): Promise<{ requeued: number; parked: number; skippedNewerSession: number }> {
      const now = Date.now()
      const { rows } = await query(
        "SELECT * FROM runs WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1",
        [now],
      )
      const expired = rows.map(rowToRun)
      let requeued = 0
      let parked = 0
      let skippedNewerSession = 0
      const retiredSessionIds: string[] = []
      for (const run of expired) {
        // Slice 1.3 — newer-Session overlap detection. See
        // `memory-run-store.reapExpired` for the rationale; both
        // implementations share the same `isNewerSession` callback
        // contract so a reaper that wires `SessionReservationStore` in
        // one place works against either backend.
        if (opts?.isNewerSession && (await opts.isNewerSession(run))) {
          skippedNewerSession++
          opts.onReap?.({
            runId: run.id,
            sessionId: run.sessionId,
            workerId: run.workerId,
            attempts: run.attempts,
            errorAttempts: run.errorAttempts,
            outcome: 'skipped_newer_session',
          })
          continue
        }
        const tooOld = opts?.maxAgeMs !== undefined && run.startedAt !== null && now - run.startedAt > opts.maxAgeMs
        const reason = tooOld ? 'run exceeded max age (reaped)' : 'lease expired (reaped)'
        const r = await retire(run, reason, !tooOld, { ifExpiredAt: now })
        if (!r.applied) continue
        if (r.requeued) requeued++
        else parked++
        retiredSessionIds.push(run.sessionId)
        opts?.onReap?.({
          runId: run.id,
          sessionId: run.sessionId,
          workerId: run.workerId,
          attempts: run.attempts,
          errorAttempts: run.errorAttempts,
          outcome: r.requeued ? 'requeued' : 'parked',
        })
      }
      if (onRetired && retiredSessionIds.length) await onRetired(retiredSessionIds)
      return { requeued, parked, skippedNewerSession }
    },

    waitFor(runId, timeoutMs = 60_000): Promise<Run> {
      return new Promise<Run>((resolve, reject) => {
        let done = false
        const finish = (r: Run): void => {
          if (done) return
          done = true
          clearInterval(poll)
          clearTimeout(timer)
          events.off(runId, onSettle)
          resolve(r)
        }
        function onSettle(r: Run): void {
          finish(r)
        }
        events.once(runId, onSettle)
        const poll = setInterval(() => {
          void getRun(runId)
            .then((r) => {
              if (r && isTerminal(r.status)) finish(r)
            })
            .catch((err: unknown) => {
              console.error(`[postgres-run-store] waitFor poll for run ${runId} failed transiently:`, errMessage(err))
            })
        }, 250)
        poll.unref?.()
        const timer = setTimeout(() => {
          if (done) return
          done = true
          clearInterval(poll)
          events.off(runId, onSettle)
          reject(new Error(`run ${runId} did not finish within ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
      })
    },

    async close(): Promise<void> {
      await closePool()
    },
  }

  return store
}
