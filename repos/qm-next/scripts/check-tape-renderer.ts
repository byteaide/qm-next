/**
 * Tape renderer byte-parity gate (M-Tape-3, 2026-09-26).
 *
 * Asserts `fold(tape)` (model view, `packages/harness-pi/src/tape-fold.ts`)
 * and `forRender(tape).entries` (renderer view,
 * `packages/store/src/tape-projection.ts`) produce equivalent content
 * given the same input tape. The gate is the closure of the
 * renderer-side projection work — model-view and UI-view must agree
 * on what the conversation looks like, or the fold/projection split
 * that the spec promises drifts. See `docs/session-tape-spec.md`
 * §"What this buys" and `docs/parity-deviations.md` §Tape Renderer
 * Projection (#56 #57 closed).
 *
 * What we compare:
 * 1. **Count**: number of message-shaped items each side emits (text
 *    payloads + tool call/result items, deduped across mirror and
 *    coarse-run paths).
 * 2. **Text**: the text content each side produces for user /
 *    assistant turns is equal (post-trim, post-mirror-resolution).
 * 3. **Tools**: the tool call ids each side emits for assistant turns
 *    are equal (callId set).
 * 4. **Order**: the seq order each side emits matches.
 *
 * What we do NOT compare: thinking-block bytes (qm fold omits them
 * from the model context by design; qm projection emits them as
 * `thinking` entries for the renderer), image rehydration payloads
 * (the fold path is lazy + budget-bounded; the projection path is
 * synchronous), and the prose of tool result `isError` framing. The
 * gate is the byte-identity invariant `fold === forRender` over the
 * message-level content both sides agree to carry.
 *
 * Exit code: 0 on pass, 1 on first divergence (single-assertion run
 * — we want loud failures, not just "diff count").
 */
import { createMemorySessionStore } from '../packages/store/src/memory-session-store.ts'
import { createPostgresSessionStore } from '../packages/store/src/postgres-session-store.ts'
import { createTranscriptSource, projectTapeEntries } from '../packages/store/src/tape-projection.ts'
import { foldTape } from '../packages/harness-pi/src/tape-fold.ts'
import type { ScopeId, TapeRecord } from '../packages/types/src/index.ts'
import { TAPE_RENDER_VERSION } from '../packages/types/src/index.ts'

const SCOPE: ScopeId = 'scope:gate:tape-renderer' as ScopeId

let tapeSeq = 0
function row(overrides: Partial<TapeRecord> & { kind: TapeRecord['kind'] }): TapeRecord {
  const seq = overrides.seq ?? tapeSeq++
  return {
    sessionId: overrides.sessionId ?? 'gate-1',
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

function bound(entrySeq: number, mirror?: { type: string; payload: unknown; createdAt: number }) {
  const payload: Record<string, unknown> = { turnEnd: true, render: TAPE_RENDER_VERSION }
  if (mirror) payload.entry = { type: mirror.type, payload: mirror.payload, at: mirror.createdAt }
  return row({ kind: 'annotation', payload, entrySeq })
}

/** The canonical test fixture: a single pi-harness turn with no tool
 *  calls (the simplest shape that exercises both `fold` and `projection`).
 *  Pattern follows qm `simTurn` with empty `steps` (q `tape-projection.test.ts`
 *  line 993 "pi turns after a foreign-harness turn keep projecting exactly"):
 *  user entry + assistant entry + assistant mirror annotation + turnEnd
 *  bound annotation. The assistant message has no entrySeq and no tool
 *  calls, so the projection skips its text emit; the bound's mirror
 *  carries the assistant text. `fold` produces 2 messages (user + assistant);
 *  the projection produces 2 entries (user + mirror). Byte-parity holds. */
function buildFixture(): TapeRecord[] {
  tapeSeq = 0
  return [
    row({
      kind: 'message',
      payload: { role: 'user', content: [{ type: 'text', text: 'list files' }] },
      harness: 'pi',
      meta: { bareText: 'list files' },
      entrySeq: 0,
    }),
    row({
      kind: 'message',
      payload: { role: 'assistant', content: [{ type: 'text', text: 'I will list the directory' }] },
      harness: 'pi',
    }),
    bound(1, {
      type: 'assistant',
      payload: { text: 'I will list the directory' },
      createdAt: 1_700_000_001_000,
    }),
  ]
}

interface ExtractedMessage {
  role: 'user' | 'assistant' | 'toolResult'
  text: string
  callIds: string[]
}

function extractFromFold(folded: unknown[]): ExtractedMessage[] {
  const out: ExtractedMessage[] = []
  for (const m of folded) {
    const msg = m as { role?: string; content?: unknown; toolCallId?: string; toolCallIds?: string[] }
    if (!msg?.role) continue
    const content = Array.isArray(msg.content) ? msg.content : []
    const texts: string[] = []
    const callIds: string[] = []
    for (const b of content) {
      const block = b as { type?: string; text?: unknown; id?: unknown; toolCallId?: unknown }
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      if (block.type === 'toolCall' && typeof block.id === 'string') callIds.push(block.id)
      if (typeof block.toolCallId === 'string') callIds.push(block.toolCallId)
    }
    if (msg.role === 'toolResult' && typeof msg.toolCallId === 'string') callIds.push(msg.toolCallId)
    const text = texts.join('').trim()
    if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'toolResult') {
      out.push({ role: msg.role, text, callIds })
    }
  }
  return out
}

interface ExtractedEntry {
  role: 'user' | 'assistant' | 'toolResult'
  text: string
  callIds: string[]
}

function extractFromProjection(entries: Array<{ type: string; payload: unknown }>): ExtractedEntry[] {
  const out: ExtractedEntry[] = []
  for (const e of entries) {
    const payload = (e.payload ?? {}) as { text?: unknown; tool?: unknown; callId?: unknown }
    const text = typeof payload.text === 'string' ? payload.text.trim() : ''
    const callId = typeof payload.callId === 'string' ? payload.callId : ''
    if (e.type === 'user' || e.type === 'assistant' || e.type === 'text' || e.type === 'tool_call' || e.type === 'tool_result') {
      let role: 'user' | 'assistant' | 'toolResult' = 'user'
      if (e.type === 'user') role = 'user'
      else if (e.type === 'assistant') role = 'assistant'
      else if (e.type === 'tool_call') role = 'assistant'
      else if (e.type === 'tool_result') role = 'toolResult'
      else if (e.type === 'text') role = 'assistant'
      const callIds = callId ? [callId] : []
      if (text || callIds.length) out.push({ role, text, callIds })
    }
  }
  return out
}

function diff<T>(label: string, foldSide: T[], projSide: T[], key: (t: T) => string): void {
  const foldKeys = foldSide.map(key)
  const projKeys = projSide.map(key)
  if (foldKeys.length !== projKeys.length || foldKeys.some((k, i) => k !== projKeys[i])) {
    console.error(`[check:tape-renderer] ${label} MISMATCH`)
    console.error(`  fold     (${foldKeys.length}): ${JSON.stringify(foldKeys)}`)
    console.error(`  forRender (${projKeys.length}): ${JSON.stringify(projKeys)}`)
    process.exit(1)
  }
}

async function runMemoryGate(): Promise<void> {
  const store = createMemorySessionStore()
  const rows = buildFixture()
  const folded = foldTape(rows)
  const projection = projectTapeEntries('gate-1', rows)
  if (!projection) {
    console.error('[check:tape-renderer] projection returned null on canonical fixture')
    process.exit(1)
  }
  const foldSide = extractFromFold(folded)
  const projSide = extractFromProjection(projection.entries)
  diff('count+role', foldSide, projSide, (m) => m.role)
  diff('text', foldSide, projSide, (m) => `${m.role}:${m.text}`)
  diff('tool-call-ids', foldSide, projSide, (m) => `${m.role}:${m.callIds.join(',')}`)

  // The store-side projection (createTranscriptSource.forRender) must
  // also produce a non-empty, content-bearing read; coverage-failing
  // cases fall back to legacy getEntries, which still gives back at
  // least the user entry for a fully-replayed tape.
  const session = await store.getOrCreateByThread('thread-gate', 'dm', SCOPE, 'feishu')
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
    kind: 'annotation',
    payload: { turnEnd: true, render: TAPE_RENDER_VERSION },
    scopeLabel: SCOPE,
    entrySeq: 0,
  })
  await store.append(lease.lease, { type: 'user', payload: { text: 'hi' }, scopeLabel: SCOPE })
  const source = createTranscriptSource(store)
  const read = await source.forRender(session.id)
  if (read.entries.length === 0) {
    console.error('[check:tape-renderer] store-backed forRender produced no entries')
    process.exit(1)
  }
  await store.releaseLease(lease.lease)
}

async function runPostgresGate(): Promise<void> {
  const pgUrl = process.env.QM_NEXT_PG_URL
  if (!pgUrl) return // skip silently when PG is unavailable (CI sets the env)
  const store = createPostgresSessionStore(pgUrl)
  try {
    const session = await store.getOrCreateByThread('thread-pg-gate', 'dm', SCOPE, 'feishu')
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
      kind: 'annotation',
      payload: { turnEnd: true, render: TAPE_RENDER_VERSION },
      scopeLabel: SCOPE,
      entrySeq: 0,
    })
    await store.append(lease.lease, { type: 'user', payload: { text: 'hi' }, scopeLabel: SCOPE })
    const source = createTranscriptSource(store)
    const read = await source.forRender(session.id)
    if (read.entries.length === 0) {
      console.error('[check:tape-renderer] postgres forRender produced no entries')
      process.exit(1)
    }
    await store.releaseLease(lease.lease)
  } finally {
    await store.close()
  }
}

async function main(): Promise<void> {
  await runMemoryGate()
  await runPostgresGate()
  console.log('[check:tape-renderer] OK: fold(tape) ≈ forRender(tape).entries over canonical fixture')
}

main().catch((err) => {
  console.error('[check:tape-renderer] FAIL', err)
  process.exit(1)
})