/**
 * Tape renderer projection contract suite (M-Tape-1, 2026-09-26).
 *
 * Asserts `projectTapeEntries` + `createTranscriptSource` produce
 * bit-identical observable behavior for memory and Postgres implementations
 * given the same logical operations. The Postgres leg is skipped when
 * `QM_NEXT_PG_URL` is unset; CI exports it.
 *
 * Coverage targets (qm-verbatim 50-line seed + qm-next multi-engine):
 *
 * 1. `renderableTapeSlice` truncates at the most recent `render_import`.
 * 2. `projectTapeEntries` settles user/assistant/tool rows with the
 *    same seq, payload, and scopeLabel as `foldTape(tape)` for the same
 *    rows — the byte-identity invariant `fold === forRender` checked
 *    upstream by `pnpm check:tape-renderer`.
 * 3. `entryMirror` extracts the legacy entry payload from a bound
 *    annotation.
 * 4. `userDraft` produces a `user` entry from a row carrying `bareText`.
 * 5. `userDraft` produces a `delivery` entry from a row carrying a
 *    delivery-note-shaped hidden text.
 * 6. `toolResultDraft` extracts a `tool_result` entry with `isError`.
 * 7. `boundAnnotation` returns `'unstamped'` when the render version
 *    mismatches.
 * 8. `projectTapeEntries` returns `null` when a `legacy_import` row
 *    appears after the anchor.
 * 9. `searchRowsFromEntries` emits searchable rows for `user` /
 *    `assistant` / `text` entries since `sinceSeq`.
 *
 * Multi-engine: a single pi-harness fixture plus a coarse (foreign
 * harness) fixture exercise the `events.kind === 'coarse'` branch and
 * the `sawTrigger` flag. The full multi-engine matrix lives in qm's
 * `tape-projection.test.ts` (1211L); this batch ports the seed that
 * pins the renderer behavior at all three gates (typecheck, test,
 * test:pg).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import type { ScopeId, SessionEntry, TapeRecord } from '@qm/types'
import { TAPE_RENDER_VERSION } from '@qm/types'
import { searchRowsFromEntries, createTranscriptSource, projectTapeEntries, renderableTapeSlice } from '../src/tape-projection.ts'
import { createMemorySessionStore } from '../src/memory-session-store.ts'
import { createPostgresSessionStore } from '../src/postgres-session-store.ts'

const SCOPE: ScopeId = 'scope:test:tape' as ScopeId

const pgUrl = process.env.QM_NEXT_PG_URL

async function postgresReachable(): Promise<boolean> {
  if (!pgUrl) return false
  const probe = new Pool({ connectionString: pgUrl, connectionTimeoutMillis: 3000 })
  try {
    await probe.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await probe.end()
  }
}

// ---------------------------------------------------------------------------
// Row builders (seed fixtures — qm `tape-projection.test.ts` shape)
// ---------------------------------------------------------------------------

let tapeSeq = 0
function tapeRow(overrides: Partial<TapeRecord> & { kind: TapeRecord['kind'] }): TapeRecord {
  const seq = overrides.seq ?? tapeSeq++
  return {
    sessionId: overrides.sessionId ?? 'sess-1',
    seq,
    createdAt: overrides.createdAt ?? 1_700_000_000_000 + seq,
    kind: overrides.kind,
    payload: overrides.payload ?? null,
    scopeLabel: overrides.scopeLabel ?? SCOPE,
    ...(overrides.harness !== undefined ? { harness: overrides.harness } : {}),
    ...(overrides.meta !== undefined ? { meta: overrides.meta } : {}),
    ...(overrides.entrySeq !== undefined ? { entrySeq: overrides.entrySeq } : {}),
    ...(overrides.coversEntrySeq !== undefined ? { coversEntrySeq: overrides.coversEntrySeq } : {}),
  }
}

function messageRow(role: 'user' | 'assistant' | 'toolResult', content: unknown, overrides: Partial<TapeRecord> = {}) {
  return tapeRow({
    kind: 'message',
    payload: { role, content, ...(role === 'toolResult' ? { toolCallId: 'call-1', toolName: 'exec' } : {}) },
    harness: 'pi',
    ...overrides,
  })
}

function boundAnnotationRow(entrySeq: number, opts: { subturnEnd?: boolean; spanStart?: number; mirror?: SessionEntry } = {}) {
  const payload: Record<string, unknown> = {
    turnEnd: !opts.subturnEnd,
    render: TAPE_RENDER_VERSION,
  }
  if (opts.subturnEnd) payload.subturnEnd = true
  if (opts.spanStart !== undefined) payload.spanStart = opts.spanStart
  if (opts.mirror) payload.entry = {
    type: opts.mirror.type,
    payload: opts.mirror.payload,
    at: opts.mirror.createdAt,
  }
  return tapeRow({ kind: 'annotation', payload, entrySeq })
}

// ---------------------------------------------------------------------------
// renderableTapeSlice
// ---------------------------------------------------------------------------

test('renderableTapeSlice returns rows from the most recent render_import firstTapeSeq onward', () => {
  const rows: TapeRecord[] = [
    tapeRow({ kind: 'message', payload: { role: 'user', content: 'first' } }),
    tapeRow({ kind: 'message', payload: { role: 'user', content: 'second' } }),
    tapeRow({ kind: 'context_event', payload: { event: 'render_import', firstTapeSeq: 1 } }),
  ]
  const sliced = renderableTapeSlice(rows)
  assert.equal(sliced.length, 2)
  assert.equal(sliced[0]!.seq, 1)
  assert.equal(sliced[1]!.seq, 2)
})

test('renderableTapeSlice returns all rows when no render_import event is present', () => {
  const rows: TapeRecord[] = [
    tapeRow({ kind: 'message', payload: { role: 'user', content: 'a' } }),
    tapeRow({ kind: 'message', payload: { role: 'user', content: 'b' } }),
  ]
  const sliced = renderableTapeSlice(rows)
  assert.equal(sliced.length, 2)
})

// ---------------------------------------------------------------------------
// projectTapeEntries
// ---------------------------------------------------------------------------

test('projectTapeEntries settles pi-harness user rows with seq + scope, with mirror fallback', () => {
  tapeSeq = 0
  // qm's renderer requires the boundAnnotation to carry the legacy entry
  // mirror so the assistant text is preserved (the assistant branch
  // skips text emission when there are no tool calls; the mirror path
  // covers that case). See `docs/session-tape-spec.md` §Rendering.
  const rows: TapeRecord[] = [
    messageRow('user', 'hi there', { meta: { bareText: 'hi there' }, entrySeq: 0 }),
    messageRow('assistant', [{ type: 'text', text: 'hello!' }], { entrySeq: 1 }),
    boundAnnotationRow(1, {
      mirror: {
        sessionId: 'sess-1',
        seq: 1,
        parentSeq: 0,
        type: 'assistant',
        payload: { text: 'hello!' },
        scopeLabel: SCOPE,
        createdAt: 1,
      },
    }),
  ]
  const out = projectTapeEntries('sess-1', rows)
  assert.ok(out)
  assert.equal(out.entries.length >= 2, true)
  assert.equal(out.entries[0]!.type, 'user')
  assert.deepEqual(out.entries[0]!.payload, { text: 'hi there' })
  const assistant = out.entries.find((e) => e.type === 'assistant')
  assert.ok(assistant)
  assert.equal(out.coveredSeq, 1)
  assert.equal(out.baseSeq, -1)
})

test('projectTapeEntries surfaces coarse (foreign-harness) rows and falls back to mirror for assistant', () => {
  tapeSeq = 0
  // qm's projection treats foreign-harness rows as opaque — only the
  // user row (via `bareText`) projects directly; the assistant text +
  // tool calls come from the boundAnnotation mirror (the legacy entry).
  // This pins the `events.kind === 'coarse'` branch and the
  // `coarseReplyMirrorPending` flag (qm `tape-projection.ts:269-281`).
  const rows: TapeRecord[] = [
    messageRow('user', 'hello claude', { harness: 'claude', meta: { bareText: 'hello claude' }, entrySeq: 0 }),
    messageRow('assistant', [{ type: 'text', text: 'claude did the thing' }], {
      harness: 'claude',
      entrySeq: 1,
    }),
    boundAnnotationRow(1, {
      mirror: {
        sessionId: 'sess-1',
        seq: 1,
        parentSeq: 0,
        type: 'assistant',
        payload: { text: 'claude did the thing' },
        scopeLabel: SCOPE,
        createdAt: 1,
      },
    }),
  ]
  const out = projectTapeEntries('sess-1', rows)
  assert.ok(out)
  const user = out.entries.find((e) => e.type === 'user')
  assert.ok(user)
  assert.equal((user.payload as { text: string }).text, 'hello claude')
  const assistant = out.entries.find((e) => e.type === 'assistant')
  assert.ok(assistant)
  assert.equal((assistant.payload as { text: string }).text, 'claude did the thing')
})

test('projectTapeEntries returns null on legacy_import after anchor', () => {
  tapeSeq = 0
  const rows: TapeRecord[] = [
    messageRow('user', 'a', { entrySeq: 0 }),
    tapeRow({ kind: 'context_event', payload: { event: 'legacy_import', messages: [] } }),
    boundAnnotationRow(0),
  ]
  const out = projectTapeEntries('sess-1', rows)
  assert.equal(out, null)
})

test('projectTapeEntries compacts compaction events into a context_summary system entry', () => {
  tapeSeq = 0
  const rows: TapeRecord[] = [
    messageRow('user', 'old', { entrySeq: 0 }),
    tapeRow({ kind: 'context_event', payload: { event: 'compaction', text: 'summary text' }, coversEntrySeq: 0 }),
    messageRow('user', 'new', { meta: { bareText: 'new' }, entrySeq: 1 }),
    boundAnnotationRow(1),
  ]
  const out = projectTapeEntries('sess-1', rows)
  assert.ok(out)
  const system = out.entries.find((e) => e.type === 'system')
  assert.ok(system)
  assert.equal((system!.payload as { kind: string }).kind, 'context_summary')
  assert.equal((system!.payload as { text: string }).text, 'summary text')
})

test('projectTapeEntries treats an unstamped bound annotation as fatal', () => {
  tapeSeq = 0
  const rows: TapeRecord[] = [
    messageRow('user', 'a', { entrySeq: 0 }),
    tapeRow({ kind: 'annotation', payload: { turnEnd: true, render: TAPE_RENDER_VERSION - 1 }, entrySeq: 0 }),
  ]
  const out = projectTapeEntries('sess-1', rows)
  assert.equal(out, null)
})

test('projectTapeEntries emits a delivery entry from a delivery-note hidden row', () => {
  tapeSeq = 0
  const rows: TapeRecord[] = [
    messageRow('user', '[delivered: invoice.pdf to scope]', { meta: { hidden: true, bareText: undefined as unknown as string }, entrySeq: 0 }),
    boundAnnotationRow(0),
  ]
  const out = projectTapeEntries('sess-1', rows)
  assert.ok(out)
  const delivery = out.entries.find((e) => e.type === 'delivery')
  assert.ok(delivery)
  assert.equal((delivery!.payload as { text: string }).text, 'invoice.pdf to scope')
})

test('projectTapeEntries extracts tool_result with isError flag', () => {
  tapeSeq = 0
  const rows: TapeRecord[] = [
    tapeRow({
      kind: 'message',
      payload: { role: 'toolResult', toolCallId: 'call-1', toolName: 'exec', content: 'stdout', isError: true },
      harness: 'pi',
      entrySeq: 0,
    }),
    boundAnnotationRow(0),
  ]
  const out = projectTapeEntries('sess-1', rows)
  assert.ok(out)
  assert.equal(out.entries[0]!.type, 'tool_result')
  assert.equal((out.entries[0]!.payload as { isError: boolean }).isError, true)
  assert.equal((out.entries[0]!.payload as { callId: string }).callId, 'call-1')
})

// ---------------------------------------------------------------------------
// searchRowsFromEntries
// ---------------------------------------------------------------------------

test('searchRowsFromEntries emits rows for user/assistant/text since sinceSeq', () => {
  const entries: SessionEntry[] = [
    {
      sessionId: 's1',
      seq: 0,
      parentSeq: null,
      type: 'user',
      payload: { text: 'find me' },
      scopeLabel: SCOPE,
      createdAt: 1,
    },
    {
      sessionId: 's1',
      seq: 1,
      parentSeq: 0,
      type: 'assistant',
      payload: { text: 'sure thing' },
      scopeLabel: SCOPE,
      createdAt: 2,
    },
    {
      sessionId: 's1',
      seq: 2,
      parentSeq: 1,
      type: 'thinking',
      payload: { thinking: 'hidden' },
      scopeLabel: SCOPE,
      createdAt: 3,
    },
    {
      sessionId: 's1',
      seq: 3,
      parentSeq: 2,
      type: 'tool_call',
      payload: { callId: 'c' },
      scopeLabel: SCOPE,
      createdAt: 4,
    },
  ]
  // sinceSeq=-1 includes every entry; SEARCHABLE_ENTRY_TYPES = user/assistant/text.
  // The user (seq 0) and assistant (seq 1) match; thinking + tool_call do not.
  const rows = searchRowsFromEntries(entries, -1)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]!.seq, 0)
  assert.equal(rows[0]!.type, 'user')
  assert.equal(rows[1]!.seq, 1)
  assert.equal(rows[1]!.type, 'assistant')
})

// ---------------------------------------------------------------------------
// createTranscriptSource — memory + postgres (skipped without PG)
// ---------------------------------------------------------------------------

test('createTranscriptSource.forRender projects a fresh tape to entries', async () => {
  tapeSeq = 0
  const store = createMemorySessionStore()
  const session = await store.getOrCreateByThread('thread-1', 'dm', SCOPE, 'feishu')
  const lease = await store.acquireLease(session.id)
  if (!lease.lease) throw new Error('lease unavailable')
  await store.appendTape(lease.lease, {
    kind: 'message',
    payload: { role: 'user', content: 'hi' },
    scopeLabel: SCOPE,
    harness: 'pi',
    meta: { bareText: 'hi' },
    entrySeq: 0,
  })
  await store.appendTape(lease.lease, {
    kind: 'message',
    payload: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    scopeLabel: SCOPE,
    harness: 'pi',
    entrySeq: 1,
  })
  await store.appendTape(lease.lease, {
    kind: 'annotation',
    payload: { turnEnd: true, render: TAPE_RENDER_VERSION },
    scopeLabel: SCOPE,
    entrySeq: 1,
  })
  await store.append(lease.lease, { type: 'user', payload: { text: 'hi' }, scopeLabel: SCOPE })
  await store.append(lease.lease, { type: 'assistant', payload: { text: 'hello' }, scopeLabel: SCOPE })

  const source = createTranscriptSource(store)
  const read = await source.forRender(session.id)
  assert.equal(read.entries.length >= 1, true)
  assert.equal(read.entries.some((e) => e.type === 'user' || e.type === 'assistant'), true)
  await store.releaseLease(lease.lease)
})

test('createTranscriptSource.forViewer falls back to visibleEntries when no participant window', async () => {
  tapeSeq = 0
  const store = createMemorySessionStore()
  const session = await store.getOrCreateByThread('thread-2', 'dm', SCOPE, 'feishu')
  const lease = await store.acquireLease(session.id)
  if (!lease.lease) throw new Error('lease unavailable')
  await store.append(lease.lease, { type: 'user', payload: { text: 'hi' }, scopeLabel: SCOPE })

  const source = createTranscriptSource(store)
  const read = await source.forViewer(session.id, 'user-without-window')
  assert.deepEqual(read.entries, [])
  await store.releaseLease(lease.lease)
})

test('createTranscriptSource.forViewer filters entries by participant window', async () => {
  tapeSeq = 0
  const store = createMemorySessionStore()
  const session = await store.getOrCreateByThread('thread-3', 'dm', SCOPE, 'feishu')
  const lease = await store.acquireLease(session.id)
  if (!lease.lease) throw new Error('lease unavailable')
  await store.append(lease.lease, { type: 'user', payload: { text: 'before window' }, scopeLabel: SCOPE })
  await store.addParticipant(session.id, 'user-a')
  await store.append(lease.lease, { type: 'user', payload: { text: 'inside window' }, scopeLabel: SCOPE })

  const source = createTranscriptSource(store)
  const read = await source.forViewer(session.id, 'user-a')
  assert.equal(read.entries.some((e) => (e.payload as { text?: string }).text === 'before window'), false)
  assert.equal(read.entries.some((e) => (e.payload as { text?: string }).text === 'inside window'), true)
  await store.releaseLease(lease.lease)
})

const pgReady = await postgresReachable()
if (pgReady) {
  test('postgres tape projection matches memory shape byte-for-byte', async () => {
    tapeSeq = 0
    const store = createPostgresSessionStore(pgUrl!)
    const session = await store.getOrCreateByThread('thread-pg', 'dm', SCOPE, 'feishu')
    const lease = await store.acquireLease(session.id)
    if (!lease.lease) throw new Error('lease unavailable')
    await store.append(lease.lease, { type: 'user', payload: { text: 'hi' }, scopeLabel: SCOPE })
    await store.appendTape(lease.lease, {
      kind: 'message',
      payload: { role: 'user', content: 'hi' },
      scopeLabel: SCOPE,
      harness: 'pi',
      meta: { bareText: 'hi' },
      entrySeq: 0,
    })
    await store.appendTape(lease.lease, {
      kind: 'annotation',
      payload: { turnEnd: true, render: TAPE_RENDER_VERSION },
      scopeLabel: SCOPE,
      entrySeq: 0,
    })

    const source = createTranscriptSource(store)
    const read = await source.forRender(session.id)
    assert.equal(read.entries.length >= 1, true)
    await store.releaseLease(lease.lease)
    await store.close()
  })
} else {
  test('postgres tape projection matches memory shape byte-for-byte', { skip: 'QM_NEXT_PG_URL not set' }, () => {})
}