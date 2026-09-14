/**
 * In-memory surface event cache (11.0 tranche 5, lane A) — the ingest half of
 * qm's `surface-cache`: the connector upserts surface events keyed by
 * (surface, container, ts) and the route answers qm's `{ ok, upserted }`.
 * Query surfaces over the cache land with the search backend (13.0).
 */

export interface IngestEvent {
  container: string
  ts: string
  sub?: string
  authorId?: string
  authorName?: string
  text?: string
  mentions?: Record<string, string>
  self?: boolean
  bot?: boolean
  mentionsSelf?: boolean
  editedAt?: number
  deleted?: boolean
  handled?: boolean
  createdAt?: number
  files?: Array<{ fileId: string; name?: string; mimetype?: string }>
  members?: string[]
  containerName?: string
  kind?: 'channel' | 'dm' | 'group'
}

export interface SurfaceCacheStore {
  ingest(events: IngestEvent[], surface: string, self?: { name?: string; mentionId?: string }): { upserted: number }
  size(): number
}

export function createMemorySurfaceCacheStore(): SurfaceCacheStore {
  const events = new Map<string, IngestEvent>()
  return {
    ingest(eventsBatch, surface, self) {
      let upserted = 0
      for (const raw of eventsBatch) {
        const event: IngestEvent = {
          ...raw,
          ...(self?.name && !raw.authorName ? { authorName: self.name } : {}),
        }
        events.set(`${surface}:${raw.container}:${raw.ts}`, event)
        upserted += 1
      }
      return { upserted }
    },
    size() {
      return events.size
    },
  }
}
