# qm-next-c3-runs-aggregate

> ✅ **DONE — implemented 2026-09-21** (Slice A on `feat/runs-aggregate`). The
> blocked premise dissolved: the design PRD
> `docs/qm-next-parity-clearance/qm-next-observability-replay.md` resolved the
> architecture question — the seam lives on the **SessionStore**
> (`sessionsByThreadRefs`), not a new observability package, matching qm.

## Origin

- **Created**: 2026-09-21
- **Parent task**: parity clearance (cluster 3, item: runs aggregate `sessionsByThreadRefs`)
- **Blocked by**: observability convergence seam (`/v1/admin/metrics` aggregates) — RESOLVED by the design PRD above
- **Conversation context**: parity-deviations.md #47e marks runs-based aggregates as keeping `sessionsByThreadRefs` seam null. Admin metrics endpoint can't compute thread-scoped run counts.

## What

Add the `sessionsByThreadRefs` seam to the observability layer: a function that, given a thread reference (session ID / surface thread ID), returns the set of runs that touched it. Wire into `/v1/admin/metrics` for the runs-based aggregate endpoints.

## Why

Currently admin metrics shows empty latency summaries for runs-based views. The seam doesn't exist; needs the observability convergence infrastructure (out of current scope) to land first.

## Tier

`tier:thinking` — observability convergence is a separate architectural decision (where do session↔run links live? audit log? dedicated edge table?). Brief cannot proceed without that resolved.

## Files to Modify

- `NEW: packages/observability/src/sessions-by-thread-refs.ts` (or extension of existing)
- `EDIT: packages/api/src/routes/admin-routes.ts` — wire seam into metrics endpoint

## Implementation Steps

1. **WAIT** for observability convergence slice to land. Track via this brief's "Resume when" criterion.
2. Once landed, read the new `sessionsByThreadRefs(principal, threadRef)` API.
3. Wire into `/v1/admin/metrics` runs-based aggregate endpoints.
4. Add contract tests.

## Hazards

- **Cardinality**: thread refs are unbounded; aggregate must cap or sample.
- **Privacy**: thread refs may carry PII; aggregate must respect scope boundaries.

## Resume Condition

- Observability convergence PR merged (track via `git log -- packages/observability/`)
- `sessionsByThreadRefs` API exists in `@qm/observability` (or equivalent)
- Resume worker then implements admin-routes wiring

## Acceptance Criteria

- [x] `sessionsByThreadRefs` API exists — landed on the SessionStore contract
      (`packages/types/src/session-store.ts`), memory + PG implementations,
      contract test in `packages/store/tests/stores.test.ts`

  ```yaml
  verify:
    method: codebase
    pattern: "sessionsByThreadRefs"
    path: packages
  ```

- [x] `/v1/admin/metrics` returns non-null runs aggregate for valid thread ref —
      real `queueWait`/`runLatency` + scope-filtered throughput; contract test
      `admin: metrics and runs aggregates scope via session thread refs (#47e)`
      in `packages/api/tests/tranche7-routes.test.ts`

  ```yaml
  verify:
    method: bash
    run: "pnpm --filter @qm/api test admin-metrics"
  ```

- [x] `parity-deviations.md` #47e marked ✅ with commit link — `#47e ✅
      2026-09-21, runs-aggregate seam closed` in the #47 substitutions ledger;
      commit on branch `feat/runs-aggregate`

  ```yaml
  verify:
    method: codebase
    pattern: "sessionsByThreadRefs.*✅|#47e.*✅"
    path: docs/parity-deviations.md
  ```

## Relevant Files

- `parity-deviations.md:439-442` — #47e deferral
- `packages/observability/` — target package (not yet created)
- `packages/api/src/routes/admin-routes.ts` — metrics endpoint

## Dependencies

- **Blocked by**: observability convergence seam
- **External**: none

## Estimate

| Phase | Time |
|-------|------|
| Wait for unblock | — |
| Wire + tests | 1-2 days |
| **Total** | **~1-2 days (after unblock)** |