/**
 * Parity session-state route (11.0 tranche 5, contract "session-state"):
 * the raw SSE stream of session state events — `: open` greeting, 25s
 * `: ping` heartbeats, `event: session_state` + JSON data frames, and
 * unsubscribe on client disconnect — over the `SessionStateBus` from
 * @qm/runs.
 */
import type { ApiRouteContext, Route } from './framework.ts'
import type { SessionStateBus, SessionStateEvent } from '@qm/runs'

const HEARTBEAT_MS = 25_000

export interface SessionStateRoutesDeps {
  bus: SessionStateBus
  heartbeatMs?: number
}

export function streamSessionStates(ctx: ApiRouteContext, deps: SessionStateRoutesDeps): void {
  const res = ctx.reply.raw
  ctx.reply.hijack()
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': open\n\n')
  const unsubscribe = deps.bus.subscribe((event: SessionStateEvent) => {
    res.write(`event: session_state\ndata: ${JSON.stringify(event)}\n\n`)
  })
  const beat = setInterval(() => res.write(': ping\n\n'), deps.heartbeatMs ?? HEARTBEAT_MS)
  beat.unref?.()
  ctx.req.raw.on('close', () => {
    clearInterval(beat)
    unsubscribe()
  })
}

export function sessionStateRoutes(deps: SessionStateRoutesDeps): ReadonlyArray<Route> {
  return [
    {
      method: 'GET',
      path: '/v1/session-state/events',
      auth: 'source',
      handle: async (ctx) => {
        streamSessionStates(ctx, deps)
        return undefined
      },
    },
  ]
}
