/**
 * Surface-context pull protocol (11.0 tranche 5, lane A): agents create a
 * context/file query, the surface connector long-polls `/pending` and answers
 * `/result`, and the creating request awaits fulfillment with qm's timeout
 * ladder (context 25s, file 120s, poll 100ms; pending cap 20s). Unanswered
 * requests expire so a late fulfill answers 404 like qm.
 */
import { randomUUID } from 'node:crypto'

export interface SurfaceContextQuery {
  channelId?: string
  channelName?: string
  conversationTarget?: string
  viewer: string
  count: number
  before?: string
  match?: string
  file?: { ts: string; threadTs?: string; name?: string }
}

export interface SurfaceFileMeta {
  blobId: string
  name: string
  sizeBytes: number
  mimetype?: string
  author?: string
}

export interface SurfaceContextResult {
  messages?: unknown[]
  hasMore?: boolean
  nextBefore?: string
  note?: string
  file?: SurfaceFileMeta
  group?: { groupId: string }
}

export type ContextOutcome = { error: string } | { result: SurfaceContextResult }

export interface PendingContextRequest {
  id: string
  source: string
  query: SurfaceContextQuery
  createdAt: number
}

interface Entry extends PendingContextRequest {
  outcome?: ContextOutcome
}

export interface SurfaceContextQueue {
  create(source: string, query: SurfaceContextQuery): PendingContextRequest
  pending(source: string): PendingContextRequest[]
  fulfill(id: string, outcome: ContextOutcome): boolean
  await(
    id: string,
    opts: { waitMs: number; pollMs: number },
  ): Promise<{ status: 'done'; outcome: ContextOutcome } | { status: 'timeout' }>
}

export function createSurfaceContextQueue(opts: { now?: () => number; ttlMs?: number } = {}): SurfaceContextQueue {
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? 60_000
  const entries = new Map<string, Entry>()
  const alive = (entry: Entry) => entry.outcome === undefined && now() - entry.createdAt < ttlMs
  return {
    create(source, query) {
      const request: Entry = { id: randomUUID(), source, query, createdAt: now() }
      entries.set(request.id, request)
      return { ...request, query: { ...request.query } }
    },
    pending(source) {
      return [...entries.values()].filter((entry) => alive(entry) && entry.source === source).map((entry) => ({ ...entry, query: { ...entry.query } }))
    },
    fulfill(id, outcome) {
      const entry = entries.get(id)
      if (!entry || !alive(entry)) return false
      entry.outcome = outcome
      return true
    },
    async await(id, { waitMs, pollMs }) {
      const deadline = now() + waitMs
      for (;;) {
        const entry = entries.get(id)
        if (entry?.outcome) return { status: 'done', outcome: entry.outcome }
        if (now() >= deadline) return { status: 'timeout' }
        await new Promise((resolve) => setTimeout(resolve, pollMs))
      }
    },
  }
}
