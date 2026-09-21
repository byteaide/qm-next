# qm-next-c3-tool-ledger

> ⚠️ **BATCH 2 — BLOCKED.** Do not dispatch until runs/replay lane is in.

## Origin

- **Created**: 2026-09-21
- **Parent task**: parity clearance (cluster 3, item: per-turn tool ledger)
- **Blocked by**: runs/replay lane (parity-deviations.md #28)
- **Conversation context**: parity-deviations.md #28 marks per-turn tool ledger as deferred. qm caches tool results per (run, attempt, call index); qm-next executes every call live. Need replay-dedupe + ledger store to land.

## What

Add a per-turn tool-result cache: keyed by `(runId, attemptSeq, callIndex)`, returns the previous result if available. Uses `DurableMap<T>` shape for the ledger.

## Why

Without ledger, re-running a turn (debug, retry) re-executes every tool call. With ledger, replay is idempotent and fast. qm has this; qm-next doesn't.

## Tier

`tier:thinking` — the `once()` seam in qm's harness flow needs to be designed alongside this. Cannot proceed without runs/replay lane architecture decisions.

## Files to Modify

- `NEW: packages/runs/src/tool-ledger.ts` — ledger store (memory + PG twin)
- `EDIT: packages/orchestrator/src/orchestrator.ts` — check ledger before dispatching
- `EDIT: packages/harness-*/src/*-harness.ts` — pass `once()` seam through

## Implementation Steps

1. **WAIT** for runs/replay lane to land.
3. Read new replay/ledger APIs.
4. Implement `ToolLedger` port (memory + PG twin).
5. Wire into orchestrator: before each tool call, check ledger; if present, return cached result.
6. Contract tests: replay produces same `(result, side-effect)` set.

## Hazards

- **Side effects**: tool calls may have external side effects. Ledger must be paired with replay semantics (qm uses `once()` for exactly-once per logical attempt).
- **Cardinality**: ledger grows per turn; need TTL or retention policy.

## Resume Condition

- Runs/replay lane PR merged (track via `git log -- packages/runs/`)
- `once()` seam API exposed to harnesses
- Resume worker then implements ledger + orchestrator hook

## Acceptance Criteria

- [ ] `ToolLedger` port defined in `@qm/types`

  ```yaml
  verify:
    method: codebase
    pattern: "ToolLedger"
    path: packages/types/src
  ```

- [ ] Memory + PG twins exist

  ```yaml
  verify:
    method: codebase
    pattern: "createPostgresToolLedger|createMemoryToolLedger"
    path: packages/runs/src
  ```

- [ ] Replay test: same tool called twice returns cached result

  ```yaml
  verify:
    method: bash
    run: "pnpm --filter @qm/orchestrator test tool-ledger"
  ```

- [ ] `parity-deviations.md` #28 marked ✅

  ```yaml
  verify:
    method: codebase
    pattern: "#28.*✅"
    path: docs/parity-deviations.md
  ```

## Relevant Files

- `parity-deviations.md:188-190` — #28 deferral
- `packages/runs/src/` — target for ledger store
- `packages/orchestrator/src/orchestrator.ts:58-80` — hook point

## Dependencies

- **Blocked by**: runs/replay lane
- **External**: none

## Estimate

| Phase | Time |
|-------|------|
| Wait for unblock | — |
| Implement + tests | 2-3 days |
| **Total** | **~2-3 days (after unblock)** |