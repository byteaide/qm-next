/**
 * Parity Run Observation route (Phase 1 — slice 1.4).
 *
 * The HTTP surface over `TargetRunObservation` from
 * `@qm/types/run-observation.ts`:
 *   - `GET /v1/runs/:id/observation/snapshot` — durable snapshot
 *     projected from the event log.
 *   - `GET /v1/runs/:id/observation/replay?after=N` — replay every
 *     event strictly after the cursor (exclusive).
 *   - `GET /v1/runs/:id/observation/subscribe?after=N` — SSE stream of
 *     events strictly after the cursor (post-commit notifications;
 *     pre-commit publishing is a boundary violation — ADR-0013).
 *
 * Authorization (ADR-0014 §3): possession of a `runId` is never
 * authorization. The handler resolves the Run → `sessionId`, builds a
 * `RunVisibilityToken` from `ctx.actor`, and passes it to the
 * observation port. The visibility resolution itself is Phase 2
 * (ADR-0014 §3.2); for slice 1.4 the route admits principals that
 * present a valid bearer token whose actor id is the same id the
 * Session treats as its principal (or any internal principal with
 * reach). The check is intentionally conservative — Phase 2 will
 * widen visibility once the Session principal lookup ships.
 *
 * Redaction (ADR-0014 §2): every byte that crosses the boundary is
 * scanned via `redactSecrets`; hits tick `REDACTION_HIT_TOTAL` so the
 * runbook entry (§1.6) can correlate redaction spikes with producer
 * changes.
 *
 * Linked ADRs: 0001, 0013, 0014.
 */
import type { RunStore } from '@qm/types'
import type { EventCursor, RunVisibilityToken, TargetRunEvent, TargetRunObservation, RunSnapshot } from '@qm/types'
import type { ApiRouteContext, Route } from './framework.ts'
import { badRequest, notFound } from './framework.ts'
import { RUN_METRICS, redactSecrets, type RunMetricsRegistry } from '@qm/runs'

export interface RunsObservationRoutesDeps {
  runs: RunStore
  observation: TargetRunObservation
  /** Optional metrics registry; defaults to the in-memory registry from
   *  `@qm/runs` if omitted (production injects a backend-backed one). */
  metrics?: RunMetricsRegistry
}

/**
 * Resolve a `RunVisibilityToken` from the authenticated actor. The
 * visibility resolution lives outside this module — slice 1.4 ships
 * the principal-id-only heuristic and the structure for Phase 2 to
 * widen the visibility surface.
 */
function buildVisibilityToken(
  ctx: ApiRouteContext,
  sessionId: string,
): RunVisibilityToken | { status: number; body: unknown } {
  const actor = ctx.actor
  if (!actor) {
    return { status: 401, body: { error: 'unauthorized', message: 'caller has no principal id' } }
  }
  // `internal` callers ride the control-plane `reach` scope; other
  // callers ride the `principal` scope. Phase 2 will add a Session →
  // visible-principals lookup that filters principal scope callers down
  // to the Session audience.
  const scope: RunVisibilityToken['scope'] = actor.type === 'internal' ? 'internal' : 'principal'
  return { sessionId, callerPrincipalId: actor.id, scope }
}

function parseCursor(query: Record<string, string>): { ok: true; cursor: EventCursor } | { ok: false; message: string } {
  const afterStr = query.after
  if (afterStr === undefined) {
    return { ok: true, cursor: { runId: '', seq: -1 } }
  }
  const after = Number.parseInt(afterStr, 10)
  if (!Number.isFinite(after) || after < -1 || !Number.isInteger(after)) {
    return { ok: false, message: '`after` must be an integer >= -1' }
  }
  return { ok: true, cursor: { runId: '', seq: after } }
}

function redactAndCount<T>(value: T, metrics?: RunMetricsRegistry, sink: 'observation' | 'log' = 'observation'): T {
  const text = JSON.stringify(value)
  const redacted = redactSecrets(text, sink)
  if (text === redacted) return value
  // Only tick the counter when the scanner actually changed something.
  metrics?.inc(RUN_METRICS.REDACTION_HIT_TOTAL, { sink })
  return JSON.parse(redacted) as T
}

async function resolveRunOrNotFound(deps: RunsObservationRoutesDeps, runId: string): Promise<
  { ok: true; run: NonNullable<Awaited<ReturnType<RunStore['get']>>> } | { ok: false }
> {
  const run = await deps.runs.get(runId)
  if (!run) return { ok: false }
  return { ok: true, run }
}

export function runsObservationRoutes(deps: RunsObservationRoutesDeps): ReadonlyArray<Route> {
  return [
    {
      method: 'GET',
      path: '/v1/runs/:id/observation/snapshot',
      auth: 'source',
      handle: async (ctx) => {
        const runId = ctx.params.id
        if (runId === undefined) return badRequest(ctx, 'missing run id')
        const runResult = await resolveRunOrNotFound(deps, runId)
        if (!runResult.ok) return notFound(ctx)
        const token = buildVisibilityToken(ctx, runResult.run.sessionId)
        if ('status' in token) return token
        const snap = (await deps.observation.snapshot(runId, token)) as RunSnapshot | null
        if (!snap) return notFound(ctx)
        return redactAndCount(snap, deps.metrics)
      },
    },

    {
      method: 'GET',
      path: '/v1/runs/:id/observation/replay',
      auth: 'source',
      handle: async (ctx) => {
        const runId = ctx.params.id
        if (runId === undefined) return badRequest(ctx, 'missing run id')
        const cursorResult = parseCursor(ctx.query)
        if (!cursorResult.ok) return badRequest(ctx, cursorResult.message)
        const runResult = await resolveRunOrNotFound(deps, runId)
        if (!runResult.ok) return notFound(ctx)
        const token = buildVisibilityToken(ctx, runResult.run.sessionId)
        if ('status' in token) return token
        const events = (await deps.observation.replay(
          { runId, seq: cursorResult.cursor.seq < 0 ? -1 : cursorResult.cursor.seq },
          token,
        )) as readonly TargetRunEvent[]
        return redactAndCount(events, deps.metrics)
      },
    },

    {
      method: 'GET',
      path: '/v1/runs/:id/observation/subscribe',
      auth: 'source',
      handle: async (ctx) => {
        const runId = ctx.params.id
        if (runId === undefined) return badRequest(ctx, 'missing run id')
        const cursorResult = parseCursor(ctx.query)
        if (!cursorResult.ok) return badRequest(ctx, cursorResult.message)
        const runResult = await resolveRunOrNotFound(deps, runId)
        if (!runResult.ok) return notFound(ctx)
        const token = buildVisibilityToken(ctx, runResult.run.sessionId)
        if ('status' in token) return token

        const res = ctx.reply.raw
        ctx.reply.hijack()
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write(': open\n\n')
        const beat = setInterval(() => res.write(': ping\n\n'), 25_000)
        beat.unref?.()
        const unsubscribe = deps.observation.subscribe(
          { runId, seq: cursorResult.cursor.seq < 0 ? -1 : cursorResult.cursor.seq },
          token,
          (event: TargetRunEvent) => {
            const redacted = redactAndCount(event, deps.metrics)
            res.write(`event: run_observation\ndata: ${JSON.stringify(redacted)}\n\n`)
          },
        )
        ctx.req.raw.on('close', () => {
          clearInterval(beat)
          unsubscribe()
          // End the hijacked response so inject-based clients (and
          // proxies) observe the stream closing.
          res.end()
        })
        return undefined
      },
    },
  ]
}