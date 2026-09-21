# qm-next Observability & Replay — Design PRD (cluster 3 unblock)

**Date**: 2026-09-21
**Supersedes blocker notes in**: `briefs/qm-next-c3-runs-aggregate.md`, `briefs/qm-next-c3-tool-ledger.md`
**Tier**: both flip `thinking` → `standard` (decisions resolved below)
**Target**: 2 slices, 1 engineer, ~2.5-3 days total

## Context

Two cluster-3 briefs are blocked on an "observability convergence / runs-replay
lane" architectural round. Investigation against qm (reference) and qm-next
main (`9df3898`) shows the architectural decisions were already made de facto
by earlier ports — both blockers dissolve into ordinary porting slices.

## The decisions, resolved

### Decision 1 — where session↔run links live (`#47e`, runs-aggregate)

**In the SessionStore, keyed by `threadRef`.** qm's `sessionsByThreadRefs` is
a plain SessionStore method — no edge table, no observability package:

| qm evidence | What it shows |
|---|---|
| `src/sessions/session-store.ts:490` | `sessionsByThreadRefs(threadRefs): Promise<SessionRef[]>` on the store interface |
| `src/sessions/memory-session-store.ts:435-440` | Set-filter over sessions; returns `{id, threadRef, scopeId, type, title}` |
| `src/sessions/postgres-session-store.ts:821-826` | `SELECT id, thread_ref, scope_id, type, title FROM sessions WHERE thread_ref = ANY($1)` |
| `src/api/routes/admin/observability.ts:65-82` | metrics(): runs scoped via `sessionsByThreadRefs(runs.map(r => r.sessionId))` → threadRef→scopeId map; `queueWait`/`runLatency` computed from scoped runs |
| `src/api/routes/admin/observability.ts:279` | listAdminRuns(): same lookup fills per-run session scope/type |

Runs already carry `sessionId` (= the session's threadRef), so the link needs
no new storage. qm-next's `sessions` table already has `thread_ref`
(`postgres-session-store.ts:140-156`) and `AdminDeps` already carries
`sessions` (`admin-routes.ts:43`). The qm-next gaps are exactly:

- `SessionStore` lacks the method (`types/src/session-store.ts:168`)
- `metrics()` returns literal empty summaries and org-wide-throughput-to-everyone
  (`admin-routes.ts:333,343-345`)
- `listAdminRuns()` returns `sessionScope: null, sessionType: null`
  placeholders (`admin-routes.ts:392-393`)

### Decision 2 — where the tool ledger lives (`#28`)

**On the run stores.** qm exposes `ledger` beside `runs`:

| qm evidence | What it shows |
|---|---|
| `src/runs/tool-ledger.ts:1-18` | `ToolLedger { begin, record }` + `createNullLedger` — **already ported** to qm-next `packages/runs/src/tool-ledger.ts` (exported `index.ts:16`) |
| `src/runs/memory-run-store.ts:16,257-265` | memory ledger: `Map` keyed `` `${runId}:${attempt}:${callIndex}` `` |
| `src/runs/postgres-run-store.ts:14,370-387` | PG ledger rows in the runs DB; bundle return `{runs, ledger, close}` |

qm-next's run stores literally say "translated from qm minus the tool ledger"
(`store/src/memory-run-store.ts:4`, `store/src/postgres-run-store.ts:5`).
**Deviation from qm's shape**: qm's factories return a `{runs, ledger, close}`
bundle; qm-next factories return `RunStore` directly (`service.ts:682`) and
every call site would churn under a bundle change. Decision: add a
`ledger: ToolLedger` **member on `RunStore`** (`types/src/run.ts`) — memory
and PG stores populate it; the null ledger remains the fallback for stores
that don't.

### Decision 3 — where `once()` lives (`#28`)

**In the tool-context factory, with run context threaded in.** qm:
`primitives.ts:441-468` — deps `ledger`/`runId`/`attempt` (default 1), a
closure `callIndex` counter, `runId === undefined → produce()` directly;
`begin` → cached? JSON.parse : produce → `record` gated by `shouldCache`.
Applied per tool family (`:605` exec, `:476` controlOp, `:483+` surfaceOp,
`:683,703,826,896,906,943`).

qm-next equivalent: `createSandboxToolContext` (`orchestrator/src/tool-context.ts`).
The orchestrator already holds `input.runId` at the tools call site
(`orchestrator.ts:131,134`). Changes:

- tools factory args gain `runId?`/`attempt?` (`OrchestratorDeps['tools']`)
- tool-context gains the `once()` port (verbatim semantics) and applies it to
  `execute` (cache on `code === 0`) and `read` (cache on hit); the
  graceful-unavailable surfaces need no caching
- `ToolLedger` type import is type-only from `@qm/runs` — already a declared
  orchestrator dependency (`orchestrator/package.json`), zero new edges

## Slices

### Slice A — sessionsByThreadRefs + admin runs aggregates (`#47e`, ~1 day)

1. `types/src/session-store.ts` — `SessionRef` + `sessionsByThreadRefs` member
2. `store/src/memory-session-store.ts` — Set-filter port (qm:435)
3. `store/src/postgres-session-store.ts` — `ANY($1)` port (qm:821)
4. `api/src/routes/admin-routes.ts` — metrics(): scope filter + real
   `queueWait`/`runLatency` + scoped throughput; listAdminRuns(): fill
   `sessionScope`/`sessionType` via the same lookup
5. Contract tests (scope filtering for non-org admins; empty-ref short-circuit)
6. Flip `parity-deviations.md` `#47e` ✅

### Slice B — tool ledger + once() (`#28`, ~1.5-2 days)

1. `types/src/run.ts` — `RunStore.ledger: ToolLedger`
2. `store/src/memory-run-store.ts` + `postgres-run-store.ts` — ledger impls
   (qm:257 / qm:370); remove the "minus the tool ledger" notes
3. `orchestrator/src/orchestrator.ts:131` — pass `runId`/`attempt` into tools
4. `orchestrator/src/tool-context.ts` — `once()` port; wire `execute`/`read`
5. Replay tests: same `(runId, attempt, callIndex)` twice → identical cached
   output; no-`runId` context → live execution every time
6. Flip `parity-deviations.md` `#28` ✅

## Hazards (from the briefs, addressed)

- **Cardinality**: metrics keeps the bounded `runs.list({limit})` scan
  (qm: `METRICS_RUNS_SCAN_LIMIT`); aggregates summarize, never paginate raw
  runs
- **Privacy**: the scope filter *is* the fix — non-org admins get
  thread-scoped aggregates only; `sessionsByThreadRefs` returns metadata, not
  tape content
- **Side effects**: `once()` caches only via `shouldCache` gates (exec: exit
  0; read: hit) — failed calls always re-execute
- **Retention**: ledger rows live and die with their run (qm has no separate
  TTL; run retention governs)

## Non-goals

- LLM-turn replay (tape/LLM records already landed, status #9)
- A new `packages/observability` package (metrics sinks exist; the briefs'
  `NEW: packages/observability/...` paths are superseded by the store-level
  homes qm actually uses)
- Backfilling links for historical runs (runs already carry `sessionId`)

## Resume-condition flips

- `briefs/qm-next-c3-runs-aggregate.md`: resume when this PRD merges + the
  `sessionsByThreadRefs` method exists → dispatch Slice A
- `briefs/qm-next-c3-tool-ledger.md`: resume when this PRD merges + run-store
  ledgers land → dispatch Slice B (or one engineer does A→B in order)
