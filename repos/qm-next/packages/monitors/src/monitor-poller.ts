/**
 * Monitor poller (qm `src/monitors/monitor-poller.ts`): the runtime side
 * of monitors — polls watched background processes, classifies events
 * (new output / exit / expiry / loss / quiet heartbeat), fires the
 * owner's turn through the injected fire engine, and advances the store
 * cursor so the next tick resumes without double-firing.
 *
 * Every cross-package surface enters as a structural interface satisfied
 * at the composition root (api `service.ts` binds the local sandbox's
 * process session and the shared fire engine). This package imports only
 * `@qm/types` types and its own store/broker.
 */
import type { Destination, ProcessState, ScopeId } from '@qm/types'
import { compileMonitorPattern } from './monitor-broker.ts'
import type { Monitor, MonitorStore } from './monitor-store.ts'

export const MAX_EVENT_CHARS = 16_000
export const MAX_TAIL_CHARS = 4_096
export const MAX_READ_BYTES = 64 * 1024
export const DEFAULT_HEARTBEAT_MS = 180_000
export const DEFAULT_MIN_FIRE_INTERVAL_MS = 60_000
export const DEFAULT_TICK_INTERVAL_MS = 10_000
const TICK_LEASE_KEY = 'monitor:poller:tick'

/** The slice of the shared fire engine (`@qm/triggers` FireEngine) the poller needs. */
export interface MonitorFireEngine {
  submit(spec: {
    surface: 'monitor'
    fireKey: string
    text: string
    ownerId: string
    scopeId?: ScopeId
    destination?: Destination
    firedAt: number
  }): Promise<unknown>
}

/** Process records lookup — structurally `@qm/processes` ProcessRegistry. */
export interface MonitorProcessLookup {
  get(processId: string): Promise<{ scopeId: string } | null>
  markStatus?(processId: string, status: 'exited'): Promise<unknown>
}

/** Per-scope process reading — the composition binds the local sandbox. */
export interface MonitorProcessGate {
  provision(scopeId: string): Promise<unknown>
  release(handle: unknown): Promise<void>
  read(
    handle: unknown,
    processId: string,
    opts: { sinceCursor?: number; maxBytes?: number; waitMs?: number },
  ): Promise<{ chunks: string; cursor: number; status: ProcessState }>
}

export interface MonitorPollerDeps {
  monitors: MonitorStore
  processes: MonitorProcessLookup
  gate: MonitorProcessGate
  fire: MonitorFireEngine
  /** Detects "the sandbox (not the job) lost the process" read failures. */
  isProcessGone?: (error: unknown) => boolean
  leaderLease?: { hold(key: string, fn: () => Promise<void>): Promise<void> }
  now?: () => number
  maxFiresPerTick?: number
  heartbeatMs?: number
  minFireIntervalMs?: number
}

export interface MonitorPoller {
  tick(now?: number): Promise<void>
  start(intervalMs?: number): void
  stop(): void
}

type MonitorEvent =
  | { kind: 'output' }
  | { kind: 'exited'; code: number }
  | { kind: 'expired' }
  | { kind: 'lost' }
  | { kind: 'quiet'; quietMins: number }

function filterLines(chunk: string, pattern: string): string {
  let matches: (line: string) => boolean
  try {
    matches = compileMonitorPattern(pattern)
  } catch {
    return chunk
  }
  return chunk
    .split('\n')
    .filter((l) => l !== '' && matches(l))
    .join('\n')
}

function describeEvent(ev: MonitorEvent): string {
  if (ev.kind === 'exited') return `It just exited with code ${ev.code}.`
  if (ev.kind === 'expired') {
    return 'Your watch on it expired (the job may still be running — `background poll` it, or arm a new watch if you still need one).'
  }
  if (ev.kind === 'lost') return 'It is no longer on your computer (likely lost to a restart) — treat it as gone.'
  if (ev.kind === 'quiet') {
    return `It's still running — just nothing wake-worthy in the last ~${ev.quietMins} min. Its most recent raw output (if any) is below so you can read where it's up to.`
  }
  return 'It produced new output.'
}

function replyGuidance(ev: MonitorEvent): string {
  if (ev.kind === 'quiet') {
    return 'This heartbeat exists so they can tell a quiet job from a stalled one: a one-line still-running note is the point, unless they asked you to stay quiet. '
  }
  if (ev.kind === 'output') return 'If the new output is just noise they wouldn\'t care about, finish silently. '
  return 'This is the last update this watch will send, so stay quiet only if they explicitly asked for silence on this outcome. '
}

function renderEvent(m: Monitor, output: string, ev: MonitorEvent): string {
  const what = describeEvent(ev)
  const capped = output.length > MAX_EVENT_CHARS ? `…[truncated]\n${output.slice(-MAX_EVENT_CHARS)}` : output
  return [
    `[background job update — automated, not a user message] You are watching background job ${m.processId} (\`${m.command}\`) in this conversation. ${what}`,
    ...(capped.trim() ? ['', '<output>', capped, '</output>'] : []),
    ...(m.instructions ? ['', `When you armed this watch you said: ${m.instructions}`] : []),
    '',
    'Act on this. The user can\'t see the job, so when something changed that\'s worth telling them, reply with a brief update — it posts to this conversation — saying where things stand and what to expect next. ' +
      replyGuidance(ev) +
      'Use the `background` tool (poll/stop/watch) if you need more than what\'s shown.',
  ].join('\n')
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createMonitorPoller(deps: MonitorPollerDeps): MonitorPoller {
  const now = deps.now ?? (() => Date.now())
  const maxFiresPerTick = deps.maxFiresPerTick ?? 20
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const minFireIntervalMs = deps.minFireIntervalMs ?? DEFAULT_MIN_FIRE_INTERVAL_MS
  const leaderLease = deps.leaderLease ?? { hold: (_key: string, fn: () => Promise<void>) => fn() }
  const isProcessGone = deps.isProcessGone ?? (() => false)

  async function fire(m: Monitor, fireKey: string, text: string, t: number): Promise<void> {
    await deps.fire.submit({
      surface: 'monitor',
      fireKey,
      text,
      ownerId: m.owner,
      scopeId: m.ownerScopeId,
      ...(m.destination ? { destination: m.destination } : {}),
      firedAt: t,
    })
  }

  async function reportLost(m: Monitor, t: number): Promise<void> {
    await fire(m, `monitor:${m.id}:lost`, renderEvent(m, m.tail ?? '', { kind: 'lost' }), t)
    await deps.monitors.setEnabled(m.id, false)
  }

  async function stillLive(m: Monitor): Promise<boolean> {
    const fresh = await deps.monitors.get(m.id)
    return fresh !== null && fresh.enabled
  }

  async function poll(handle: unknown, m: Monitor, t: number): Promise<boolean> {
    if (!(await stillLive(m))) return false
    let read
    try {
      read = await deps.gate.read(handle, m.processId, {
        sinceCursor: m.cursor,
        maxBytes: MAX_READ_BYTES,
        waitMs: 0,
      })
    } catch (e) {
      if (isProcessGone(e)) {
        await reportLost(m, t)
        return true
      }
      await deps.monitors.recordError(m.id, errMessage(e))
      return false
    }

    const exited = read.status.state === 'exited'
    const expired = !exited && t >= m.expiresAt
    const raw = (m.tail ?? '') + read.chunks
    let events = raw
    let tail: string | undefined
    if (m.pattern) {
      if (exited || expired) {
        events = filterLines(raw, m.pattern)
      } else {
        const lastNl = raw.lastIndexOf('\n')
        tail = (lastNl === -1 ? raw : raw.slice(lastNl + 1)).slice(-MAX_TAIL_CHARS) || undefined
        events = lastNl === -1 ? '' : filterLines(raw.slice(0, lastNl + 1), m.pattern)
      }
    }

    if (!events.trim() && !exited && !expired) {
      const quietSince = m.lastFiredAt ?? m.createdAt
      if (heartbeatMs > 0 && t - quietSince >= heartbeatMs) {
        const quietMins = Math.max(1, Math.round((t - quietSince) / 60_000))
        await fire(
          m,
          `monitor:${m.id}:quiet:${quietSince}`,
          renderEvent(m, raw.slice(-MAX_TAIL_CHARS), { kind: 'quiet', quietMins }),
          t,
        )
        await deps.monitors.advance(m.id, { cursor: read.cursor, ...(tail !== undefined ? { tail } : {}), firedAt: t })
        return true
      }
      if (read.cursor !== m.cursor || tail !== m.tail) {
        await deps.monitors.advance(m.id, { cursor: read.cursor, ...(tail !== undefined ? { tail } : {}) })
      }
      return false
    }

    if (!exited && !expired && minFireIntervalMs > 0) {
      const sinceFire = t - (m.lastFiredAt ?? 0)
      if (m.lastFiredAt !== undefined && sinceFire < minFireIntervalMs) return false
    }

    let ev: MonitorEvent = { kind: 'output' }
    let fireKey = `monitor:${m.id}:${m.cursor}`
    if (exited) {
      ev = { kind: 'exited', code: read.status.state === 'exited' ? read.status.code : 0 }
      fireKey = `monitor:${m.id}:exit`
    } else if (expired) {
      ev = { kind: 'expired' }
      fireKey = `monitor:${m.id}:expired`
    }
    try {
      await fire(m, fireKey, renderEvent(m, events, ev), t)
    } catch (e) {
      await deps.monitors.recordError(m.id, errMessage(e))
      return true
    }
    if (await deps.monitors.get(m.id)) {
      await deps.monitors.advance(m.id, { cursor: read.cursor, ...(tail !== undefined ? { tail } : {}), firedAt: t })
      if (exited || expired) await deps.monitors.setEnabled(m.id, false)
    }
    if (exited) await deps.processes.markStatus?.(m.processId, 'exited')
    return true
  }

  async function pollAll(t: number): Promise<void> {
    const enabled = (await deps.monitors.enabled()).sort((a, b) => a.createdAt - b.createdAt)
    if (enabled.length === 0) return

    const handles = new Map<string, unknown>()
    let fires = 0
    try {
      for (const m of enabled) {
        if (fires >= maxFiresPerTick) {
          console.warn(`[monitor] fan-out capped: fired ${fires}/${enabled.length} watched jobs this tick`)
          break
        }
        const rec = await deps.processes.get(m.processId)
        if (!rec) {
          await reportLost(m, t)
          fires++
          continue
        }
        let handle = handles.get(rec.scopeId)
        if (!handle) {
          try {
            handle = await deps.gate.provision(rec.scopeId)
          } catch (e) {
            await deps.monitors.recordError(m.id, errMessage(e))
            continue
          }
          handles.set(rec.scopeId, handle)
        }
        try {
          if (await poll(handle, m, t)) fires++
        } catch (e) {
          await deps.monitors.recordError(m.id, errMessage(e))
          console.error(`[monitor] poll failed for ${m.id}:`, errMessage(e))
        }
      }
    } finally {
      for (const handle of handles.values()) {
        await deps.gate.release(handle).catch((e: unknown) => {
          console.error('[monitor] teardown failed:', errMessage(e))
        })
      }
    }
  }

  const tick = async (nowArg?: number): Promise<void> => {
    const t = nowArg ?? now()
    await leaderLease.hold(TICK_LEASE_KEY, () => pollAll(t))
  }

  let timer: ReturnType<typeof setInterval> | undefined
  return {
    tick,
    start(intervalMs: number = DEFAULT_TICK_INTERVAL_MS): void {
      if (timer) return
      timer = setInterval(() => {
        tick().catch((e: unknown) => console.error('[monitor] tick failed:', errMessage(e)))
      }, intervalMs)
    },
    stop(): void {
      if (!timer) return
      clearInterval(timer)
      timer = undefined
    },
  }
}
