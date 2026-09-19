# Phase 4 Test Impact Assessment

**Phase:** 4 — Trigger Runtime decoupling
**Branch:** `refactor/trigger-runtime`
**Linked ADRs:** 0003 (Runtime contracts decouple Trigger and API)
**Linked plan:** `docs/implementation-plan.md` §Phase 4
**Authored in commit:** first Phase 4 slice (slice 4.1)

This document captures the test impact before the first Phase 4 PR. It follows the same template as `docs/test-impact/phase-{0,1,2,3}.md`. Linked ADR: 0003 (Runtime contracts decouple Trigger and API).

## 1. Summary

Phase 4 removes the `packages/triggers` ↔ `packages/api` cycle and eliminates the `api.cronsRuntime` late-write seam. Triggers depend only on a minimal `TriggerRuntime` contract (`submit`, `health`, `identity`) defined in `@qm/types`; API supplies the implementation at composition time. Cron schedule storage and the tick-lease scheduler stay behind the Trigger boundary. Cron fire idempotency per scheduled slot is preserved via the existing `CronStore.claimSlot` gate (parity tests stay green).

The Phase 4 branch is based on `chore/architecture-gates` and fast-forwards `feat/run-lifecycle` (Phase 1). Phase 4 does NOT depend on Phase 2 (Command Gate) or Phase 3 (Turn Admission) — those are orthogonal. The `TriggerRuntime.submit` is a thin wrapper around the existing API turn runner, so existing trigger behavior is preserved.

**Scope of this PR:** slices 4.1, 4.2, 4.3, 4.4. Four new packages / files: `packages/types/src/trigger-runtime.ts` (Phase 0 freeze, extended), `@qm/api` runtime impl factory, refactored `TriggersService`, new `@qm/triggers/tests/architecture.test.ts` boundary test, observability + runbook §12.

## 2. Regression basket

Tests that must stay green. These are the contracts Phase 0 + Phase 1 establish; Phase 4 may refactor trigger dispatch but must not regress cron behavior.

| Suite | File | Why it must stay green | Phase 4 risk |
|-------|------|------------------------|--------------|
| Phase 0 contract parity | `packages/types/tests/contract-parity.test.ts` | Compile-time invariants on `@qm/types` | Phase 4 extends `trigger-runtime.ts` with composition types; existing contracts untouched. |
| Concurrency parity | `packages/concurrency/tests/parity-bit-identical.test.ts` | Parity assertions on shared primitives | Phase 4 does not change concurrency contracts. |
| Store suites | `packages/store/tests/stores.test.ts`, `run-event-log.test.ts` | Memory + Postgres twins for Run/Attempt | Phase 4 does not change Run stores. |
| Runs suites | `packages/runs/tests/{runs,observability,run-event-integration,reaper-newer-session}.test.ts` | Phase 1 metrics and reaper behavior | Phase 4 does not change Runs. |
| Cron store parity | `packages/triggers/tests/{memory-cron-store,postgres-cron-store}.test.ts` | Memory + Postgres cron store parity | Phase 4 does not change CronStore. |
| Scheduler | `packages/triggers/tests/scheduler.test.ts` | Tick-lease scheduler behavior | Phase 4 does not change scheduler internals; only how it's exposed. |
| Trigger sink | `packages/triggers/tests/trigger-sink.test.ts` | Event-driven fire semantics | Phase 4 keeps `TriggerSink.fire`; signature unchanged. |
| API routes | `packages/api/tests/routes.test.ts`, `tranche14-consent.test.ts` | HTTP surface for crons | Phase 4 changes how cron routes get their data; behavior preserved. |
| Web-UI cron relay | `packages/web-ui/tests/web-ui-relay.test.ts` | Web-UI cron route reflection | Phase 4 may add composition-time injection; web-UI test must continue to work. |
| Orchestrator | `packages/orchestrator/tests/{orchestrator,admission-integration}.test.ts` | Turn orchestration shape | Phase 4 calls `TriggerRuntime.submit` which internally dispatches via the orchestrator; existing tests stay green. |

## 3. Expected-to-break tests

Phase 4 refactors `TriggersService` to consume `TriggerRuntime` instead of `ApiService`. Tests that asserted "Triggers service depends on api service" must be rewritten.

| Test | Reason | Action |
|------|--------|--------|
| `packages/triggers/tests/triggers-service.test.ts` | Test imports `ApiService` to construct a stub api. | Rewrite — construct a stub `TriggerRuntime` impl instead. |
| `packages/web-ui/tests/web-ui.test.ts` | Test wires `crons: () => this.cronsRuntime?.crons` via API service. | Rewrite — wire cron store from a separate composition seam (or via Cordis injection). |
| `packages/portal/tests/portal-web-path.test.ts` | Test wires API + cron store directly. | Keep — composition root in tests injects cron store at API construction. |
| `packages/api/tests/routes.test.ts` | Tests construct API server without cron store; routes 404. | Add composition seam so test can inject cron store. |
| `packages/api/tests/tranche14-consent.test.ts` | Test uses consent modules from `@qm/triggers`. | Keep — consent is a Trigger-owned module; API still consumes consent types and helpers. |
| `packages/api/src/routes/cron-routes.ts` | Reads `this.cronsRuntime?.crons` lazily. | Refactor — receive `CronStore` + scheduler + deliveries at construction. |

## 4. New test inventory

| File | Cases | Coverage |
|------|-------|----------|
| `packages/triggers/tests/architecture.test.ts` (slice 4.2) | 6 | Boundary: `packages/triggers/package.json` does not depend on `@qm/api`; no source file imports `@qm/api`; TriggersService injects `trigger-runtime` not `api`; architecture gate rejects the former cycle |
| `packages/triggers/tests/trigger-runtime.test.ts` (slice 4.1) | 8 | Submit returns `{runId, sessionId, acceptedAt}`; health returns `{ok}`; identity returns `{instanceId, version, supportedTriggers}`; failure surfaces structured error |
| `packages/triggers/tests/cron-routes-injection.test.ts` (slice 4.3) | 5 | Cron routes can be constructed at composition time with explicit deps; lazy `cronsRuntime` accessor is gone |
| `packages/triggers/tests/cron-fire-idempotency.test.ts` (slice 4.4) | 6 | Lease recovery does not duplicate completed work; `claimSlot` returns false on already-claimed slot; `unclaimSlot` restores a slot that was claimed but did not enqueue |
| `packages/api/tests/trigger-runtime-impl.test.ts` (slice 4.1) | 5 | API runtime impl dispatches via existing turn runner; idempotency by `fireKey`; structured error on runtime failure |
| `packages/runs/tests/observability-phase-4.test.ts` (slice 4.4) | 4 | `trigger_submit_total{outcome=accepted|rejected|unavailable}` ticks; identity returns pinned fields |
| `packages/orchestrator/tests/trigger-runtime-bridge.test.ts` (slice 4.1) | 3 | `TriggerRuntime.submit` resolves a Session and creates a Run; identity stays opaque to Triggers |

Total new cases: **37**.

## 5. Coverage deltas

Phase 0 floors (per `docs/gate-enforcement.md` §3): 90% lines / 85% branches for `packages/triggers`. Phase 4 is mostly a refactor with boundary tests. The refactor itself does not change coverage requirements.

| Package | Lines floor | Branches floor | Reporting slice |
|---------|-------------|----------------|-----------------|
| `packages/triggers` | 90% (no change) | 85% (no change) | slice 4.2 PR (verify refactor preserves coverage) |
| `packages/api` | 90% (no change) | 85% (no change) | slice 4.3 PR (cron route wiring change) |
| `packages/runs` (observability extension only) | 90% (no change) | 85% (no change) | slice 4.4 PR |

## 6. Memory/PG parity strategy

Phase 4 does not add new persistence contracts. The existing `CronStore` (memory + Postgres) is unchanged. The new `TriggerRuntime` is in-process only — no persistence. The `createMemoryLeaderLease` factory that API imports from `@qm/triggers` is moved out of `@qm/triggers` to `@qm/concurrency` (a neutral package) as part of slice 4.3, removing the API-side implementation import.

## 7. Performance budgets

Per the Phase 4 plan and ADR-0003:

| Operation | Budget | Mechanism |
|-----------|--------|-----------|
| `TriggerRuntime.submit` | <30 ms p95 (orchestrator dispatch dominates) | direct call to existing turn runner; no extra layers |
| `TriggerRuntime.health` | <5 ms p95 | in-memory flag; no I/O |
| `TriggerRuntime.identity` | <1 ms | constant-time return |
| Cron fire (claim + submit + recordFire) | <50 ms p95 | unchanged from Phase 0 |

## 8. Open questions

1. **Should `createMemoryLeaderLease` move to `@qm/concurrency` or stay in `@qm/triggers` and only be imported by Trigger-internal code?** Phase 4 moves it to `@qm/concurrency` so API no longer imports Trigger impl. This is a small refactor that breaks the cycle.
2. **Does Triggers need direct access to API's sessions/runs/resolution for cron fire?** No — `TriggerRuntime.submit` is the only contract. Cron fire calls `runtime.submit({triggerKind: 'cron', ...})` and the runtime resolves Session/run.
3. **Should `cronsRuntime` be removed entirely, or kept as an internal API handle?** Removed entirely; composition-time injection replaces it.
4. **How does web-ui get cron store if not via API service?** Composition root (boot/profile) wires `web-ui.server` with explicit cron store dep, mirroring API cron routes.

## 9. Gate self-check

| Question | Answer |
|----------|--------|
| Does Phase 4 add new top-level types? | Yes — `TriggerSubmitInput`, `TriggerSubmitResult`, `TriggerIdentity`, `TriggerHealth` already in `@qm/types/trigger-runtime.ts` (Phase 0 freeze). |
| Does Phase 4 change existing top-level types? | No. `Run` / `Attempt` / `ApprovalStore` / `AdmissionRecord` are untouched. |
| Does Phase 4 introduce a new package? | No. Reuses `@qm/types` + `@qm/api` + `@qm/triggers` + `@qm/concurrency`. |
| Does Phase 4 introduce a new persistence contract? | No. |
| Does Phase 4 introduce a new observability metric? | Yes — 1 constant: `TRIGGER_SUBMIT_TOTAL` (slice 4.4). |
| Does Phase 4 cross any architecture boundary? | Yes — TriggersService depends on TriggerRuntime (Cordis DI), not on ApiService. |
| Does Phase 4 create a circular dependency? | No — one-way dep: `@qm/triggers` → `@qm/types` (trigger-runtime); `@qm/api` → `@qm/types` (trigger-runtime impl). |
| Does Phase 4 require the architecture gate (`pnpm test:architecture`)? | Yes — verifies `packages/triggers` no longer depends on `@qm/api`. |
| Does Phase 4 require `pnpm test:pg`? | No — Postgres legs unaffected. |
| Does Phase 4 require any new deploy artifact? | No — composition-time injection replaces runtime late-write. |

## 10. Summary scorecard

- Regression basket: 10 entries.
- Expected-to-break: 6 tests (Phase 4 explicitly rewrites them).
- New tests: 37 cases across 7 files.
- New metric constants: 1.
- New packages: 0.
- Linked ADRs: 1 (0003).
- Linked prior phases: Phase 1 (Run truth). Phase 4 does NOT depend on Phase 2 (Command Gate) or Phase 3 (Turn Admission) — `TriggerRuntime.submit` is a thin wrapper around the existing turn runner.