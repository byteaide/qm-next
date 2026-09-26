/**
 * Tape contract additions — qm-verbatim port of qm
 * `src/sessions/session-store.ts` + `entry-search.ts` + `core/attachments.ts`
 * helpers used by `packages/store/src/tape-projection.ts` (M-Tape-1).
 *
 * Source-of-truth (qm, 2026-09-26):
 * - `repos/qm/src/sessions/session-store.ts:38-40` `createContextSummaryPayload`
 * - `repos/qm/src/sessions/session-store.ts:147` `TAPE_RENDER_VERSION = 1`
 * - `repos/qm/src/sessions/session-store.ts:450-469` `ParticipantWindow` +
 *   `entryWithinTenure`
 * - `repos/qm/src/sessions/entry-search.ts:1-48` `SEARCHABLE_ENTRY_TYPES` +
 *   `entrySearchText` + `entrySearchAuthor`
 * - `repos/qm/src/core/attachments.ts:389-397` `deliveryNoteManifest` +
 *   `legacyDeliveryNoteManifest`
 *
 * qm-next discipline:
 * - pure functions/constants only (no I/O, no store-side state)
 * - platform-neutral (zero IM platform symbols; `check:im` covers this file)
 * - strict typecheck (no `as any`; minimal `unknown` casts for shape probing)
 *
 * Section §"Resolved questions" of `docs/session-tape-spec.md` explains
 * why audience filtering (`entryWithinTenure`) stays distinct from
 * model-context semantics (`fold(tape, audience)`).
 */
import type { EntryType, SessionEntry } from './session.ts'

// ---------------------------------------------------------------------------
// Tape render version
// ---------------------------------------------------------------------------

/**
 * The schema version an `annotation` row must stamp in its `payload.render`
 * field for the projection to consider it as a turn boundary. Bumped when
 * the `boundAnnotation` shape or the projection's interpretation of
 * `payload.turnEnd` / `payload.subturnEnd` changes; rows stamped with a
 * different version are treated as unstamped (return `"unstamped"` from
 * `boundAnnotation`) and force the projection to refuse to serve (return
 * `null`). See qm `src/harness/tape-projection.ts:64` `RENDER_IMPORT_EVENT`
 * and `:110` `payload.render !== TAPE_RENDER_VERSION`.
 */
export const TAPE_RENDER_VERSION = 1

/**
 * Sentinel event name a `context_event` row carries to mark a tape slice
 * boundary — renderers project from this row's `firstTapeSeq` onward.
 * Matches qm `src/harness/tape-projection.ts:64`.
 */
export const RENDER_IMPORT_EVENT = 'render_import'

// ---------------------------------------------------------------------------
// Context summary payload (compaction projection target)
// ---------------------------------------------------------------------------

const CONTEXT_SUMMARY_KIND = 'context_summary'

/**
 * The `system` entry payload a `compaction` tape row projects into.
 * qm `src/sessions/session-store.ts:19-23`.
 */
export interface ContextSummaryPayload {
  kind: typeof CONTEXT_SUMMARY_KIND
  throughSeq: number
  text: string
}

/**
 * Build a compaction summary payload — qm `createContextSummaryPayload`.
 * Used by the projection when settling a `context_event: 'compaction'`
 * tape row (qm `tape-projection.ts:250-264`).
 */
export function createContextSummaryPayload(throughSeq: number, text: string): ContextSummaryPayload {
  return { kind: CONTEXT_SUMMARY_KIND, throughSeq, text }
}

/**
 * Reader — extract a compaction summary payload from a `system` entry
 * if present. The fold path also calls this when rehydrating summaries;
 * the projection path only emits summaries, it does not read them.
 */
export function contextSummaryPayload(entry: SessionEntry): ContextSummaryPayload | null {
  const payload = entry.payload as Partial<ContextSummaryPayload> | null
  if (
    entry.type === 'system' &&
    payload?.kind === CONTEXT_SUMMARY_KIND &&
    typeof payload.throughSeq === 'number' &&
    typeof payload.text === 'string'
  ) {
    return { kind: CONTEXT_SUMMARY_KIND, throughSeq: payload.throughSeq, text: payload.text }
  }
  return null
}

// ---------------------------------------------------------------------------
// Participant window + tenure filter (audience filtering for renderer view)
// ---------------------------------------------------------------------------

/**
 * One principal's continuous participation interval in a session — by
 * wall-clock (`validFrom`/`validTo`) when seq is unknown, by entry-seq
 * (`validFromSeq`/`validToSeq`) when the tape has coverage. Used by
 * `entryWithinTenure` to filter the projection output for `forViewer`.
 * qm `src/sessions/session-store.ts:450-457`.
 */
export interface ParticipantWindow {
  sessionId: string
  principalId: string
  validFrom: number
  validTo: number | null
  validFromSeq: number | null
  validToSeq: number | null
}

/**
 * Whether a session entry falls inside a principal's participant window.
 * Prefers seq bounds when both are present (seq is the tape's source of
 * truth once coverage is established; wall-clock is the fallback for
 * pre-coverage windows). qm `src/sessions/session-store.ts:459-469`.
 */
export function entryWithinTenure(
  entry: Pick<SessionEntry, 'seq' | 'createdAt'>,
  window: Pick<ParticipantWindow, 'validFrom' | 'validTo' | 'validFromSeq' | 'validToSeq'>,
): boolean {
  const fromOk = window.validFromSeq !== null ? entry.seq >= window.validFromSeq : entry.createdAt >= window.validFrom
  const toOk =
    window.validToSeq !== null
      ? entry.seq < window.validToSeq
      : window.validTo === null || entry.createdAt < window.validTo
  return fromOk && toOk
}

// ---------------------------------------------------------------------------
// Entry search helpers (used by `searchRowsFromEntries`)
// ---------------------------------------------------------------------------

/** Entry types whose payloads carry searchable user-visible text.
 *  qm `src/sessions/entry-search.ts:4`. */
export const SEARCHABLE_ENTRY_TYPES: ReadonlySet<EntryType> = new Set<EntryType>(['user', 'assistant', 'text'])

/** Project the searchable text of an entry payload. Mirrors qm
 *  `entry_search_text` SQL function (used by PG GIN index) so memory and
 *  PG stores yield the same hit text. qm `src/sessions/entry-search.ts:30-34`. */
export function entrySearchText(payload: unknown): string | null {
  if (typeof payload === 'string') return payload
  const text = (payload as { text?: unknown } | null)?.text
  return typeof text === 'string' ? text : null
}

/** Resolve the author of a searchable entry. Only `user` entries carry
 *  a `name`; everything else returns undefined (no system/tool attribution).
 *  qm `src/sessions/entry-search.ts:36-40`. */
export function entrySearchAuthor(entry: Pick<SessionEntry, 'type' | 'payload'>): string | undefined {
  if (entry.type !== 'user') return undefined
  const name = (entry.payload as { name?: unknown } | null)?.name
  return typeof name === 'string' && name.trim() ? name.trim() : undefined
}

/** One search-row projection for admin/search/inbox index surfaces.
 *  qm `src/sessions/session-store.ts` `NewSearchEntry` (and qm
 *  `tape-projection.ts:523-538` `searchRowsFromEntries`). */
export interface NewSearchEntry {
  seq: number
  type: EntryType
  author?: string
  text: string
  createdAt: number
}

// ---------------------------------------------------------------------------
// Delivery-note manifest parsing (renderer-visible delivery entries)
// ---------------------------------------------------------------------------

/** Current-shape delivery note prefix. Matches qm `deliveryNote` builder.
 *  qm `src/core/attachments.ts` `DELIVERY_NOTE_PREFIX`. */
const DELIVERY_NOTE_PREFIX = '[delivered: '

/** Read the manifest payload from a delivery-note-shaped text. Returns
 *  null when the text is not a delivery note. qm `src/core/attachments.ts:389-392`. */
export function deliveryNoteManifest(text: string): string | null {
  const t = text.trim()
  if (!t.startsWith(DELIVERY_NOTE_PREFIX) || !t.endsWith(']') || t.includes('\n')) return null
  return t.slice(DELIVERY_NOTE_PREFIX.length, -1)
}

/** Read the manifest payload from a legacy-shape delivery note.
 *  Legacy lines look like `(delivered file(s) to the conversation: ...)`.
 *  qm `src/core/attachments.ts:394-397`. */
export function legacyDeliveryNoteManifest(text: string): string | null {
  const m = /^\(delivered file\(s\) to the conversation: ([^\n]*)\)$/.exec(text.trim())
  return m ? (m[1] ?? null) : null
}

// ---------------------------------------------------------------------------
// (ScopeId stays in `./identity.ts` — no re-export from this module to
//  avoid duplicate-export collisions with `index.ts` re-exports.)
// ---------------------------------------------------------------------------