# qm-next-c3-runs-aggregate

> ⚠️ **BATCH 2 — BLOCKED.** Do not dispatch until observability convergence is in.

## Origin

- **Created**: 2026-09-21
- **Parent task**: parity clearance (cluster 3, item: runs aggregate `sessionsByThreadRefs`)
- **Blocked by**: observability convergence seam (`/v1/admin/metrics` aggregates)
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

- [ ] `sessionsByThreadRefs` API exists (after observability convergence)

  ```yaml
  verify:
    method: codebase
    pattern: "sessionsByThreadRefs"
    path: packages
  ```

- [ ] `/v1/admin/metrics` returns non-null runs aggregate for valid thread ref

  ```yaml
  verify:
    method: bash
    run: "pnpm --filter @qm/api test admin-metrics"
  ```

- [ ] `parity-deviations.md` #47e marked ✅ with commit link

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