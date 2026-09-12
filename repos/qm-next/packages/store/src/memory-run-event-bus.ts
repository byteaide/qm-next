/**
 * In-memory RunEventBus: per-run replay buffer (bounded) plus live
 * subscribers. Dropped when the process ends — M3's web surface tolerates
 * this (reconnect falls back to `GET /v1/runs/:id` polling, the same
 * fallback qm's web-ui keeps).
 */
import type { RunEvent, RunEventBus } from '@qm/types'

const DEFAULT_MAX_EVENTS_PER_RUN = 1000
const DEFAULT_MAX_RUNS = 500

export function createMemoryRunEventBus(
  opts: { maxEventsPerRun?: number; maxRuns?: number } = {},
): RunEventBus {
  const maxEventsPerRun = opts.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_RUN
  const maxRuns = opts.maxRuns ?? DEFAULT_MAX_RUNS
  const buffers = new Map<string, RunEvent[]>()
  const closed = new Set<string>()
  const listeners = new Map<string, Set<(event: RunEvent) => void>>()

  function touch(runId: string): void {
    if (buffers.has(runId)) return
    buffers.set(runId, [])
    if (buffers.size <= maxRuns) return
    for (const key of buffers.keys()) {
      if (key === runId) continue
      buffers.delete(key)
      closed.delete(key)
      listeners.delete(key)
      break
    }
  }

  return {
    publish(event) {
      if (closed.has(event.runId)) return
      touch(event.runId)
      const buffer = buffers.get(event.runId)!
      buffer.push(event)
      if (buffer.length > maxEventsPerRun) buffer.splice(0, buffer.length - maxEventsPerRun)
      for (const listener of listeners.get(event.runId) ?? []) {
        try {
          listener(event)
        } catch {
          // A slow/broken subscriber never breaks the turn pipeline.
        }
      }
    },
    subscribe(runId, listener) {
      touch(runId)
      let set = listeners.get(runId)
      if (!set) {
        set = new Set()
        listeners.set(runId, set)
      }
      set.add(listener)
      return () => {
        set!.delete(listener)
      }
    },
    replay(runId) {
      return [...(buffers.get(runId) ?? [])]
    },
    close(runId) {
      closed.add(runId)
    },
  }
}
