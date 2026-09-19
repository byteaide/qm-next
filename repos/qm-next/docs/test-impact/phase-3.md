# Phase 3 Test Impact Assessment

**Phase:** 3 — Turn Admission and Security Screen
**Branch:** `feat/turn-admission`
**Linked ADRs:** 0004, 0006, 0007
**Linked plan:** `docs/implementation-plan.md` §Phase 3
**Authored in commit:** first Phase 3 slice (slice 3.1)

This document captures the test impact before the first Phase 3 PR. It follows the same template as `docs/test-impact/phase-{0,1,2}.md`. Linked ADRs: 0004 (Security Screen Shadow Mode), 0006 (Admission rejections do not create Runs), 0007 (Turn Admission is an orchestrator seam).

## 1. Summary

Phase 3 makes Turn Admission a named orchestrator seam with a fixed waterfall, a Security Screen stage (off / shadow / enforce modes), and an Admission Record port for every reject. Rejected work never creates a Run. The plan distinguishes this from the Command Gate: Admission decides whether a Turn may enter the runtime, while Command Gate decides whether an individual command may execute (ADR-0002). Phase 3 builds on Phase 1 (Run-owned terminal events) and is logically orthogonal to Phase 2 (Command Gate). The Phase 3 branch is based on `chore/architecture-gates` and fast-forwards `feat/run-lifecycle` (Phase 1).

**Scope of this PR:** slices 3.1, 3.2, 3.3. Three new packages: `packages/admission` (Admission Record port + memory impl). `packages/orchestrator` extends with the waterfall orchestrator and consumes narrow ports from `@qm/admission`, `@qm/security`, `@qm/runs`. `packages/runs` extends observability with four Phase 3 metrics. `docs/operations.md` adds §11 runbook.

## 2. Regression basket

Tests that must stay green. These are the contracts Phase 0 + Phase 1 + Phase 2 establish; Phase 3 may consume but must not regress them.

| Suite | File | Why it must stay green | Phase 3 risk |
|-------|------|------------------------|--------------|
| Phase 0 contract parity | `packages/types/tests/contract-parity.test.ts` | Compile-time invariants on `@qm/types` | Phase 3 adds `AdmissionRecord`/`AdmissionStage`/`AdmissionDecision` types as pure additions. |
| Concurrency parity | `packages/concurrency/tests/parity-bit-identical.test.ts` | Parity assertions on shared primitives | Phase 3 does not change concurrency contracts. |
| Store suites | `packages/store/tests/stores.test.ts`, `run-event-log.test.ts` | Memory + Postgres twins for Run/Attempt | Phase 3 adds `AdmissionRecordStore` (new, not on Run). |
| Runs suites | `packages/runs/tests/{runs,observability,run-event-integration,reaper-newer-session}.test.ts` | Phase 1 metrics and reaper behavior | Phase 3 extends `RUN_METRICS` with 4 new constants; existing tests are insensitive to constants. |
| Phase 2 suites | `packages/security/tests/{command-gate,command-policy-config}.test.ts`, `packages/approvals/tests/{target-memory-approval-store,ttl-sweep}.test.ts`, `packages/runs/tests/{approval-continuation,approval-reservation-release,observability-phase-2}.test.ts` | Command Gate + Approval Continuation contract | Phase 3 does not change Command Gate or Approvals. |
| API/Web-UI Run Observation (Phase 1 slice 1.4) | `packages/api/tests/runs-observation-routes.test.ts` | HTTP surface for Run Observation | Phase 3 may surface Admission Records via the same observation envelope; out of scope for slice 3.1. |
| Orchestrator smoke | `packages/orchestrator/tests/orchestrator.test.ts` | Turn orchestration shape | **Risk: high.** Phase 3 refactors `handleTurn` to call `runAdmissionWaterfall`. Every existing assertion about "identity rejected first", "rate-limit blocks later stages" must hold. |
| Sandbox policy (Phase 2 testing layer 3J, separate concern) | `packages/sandbox/src/{policy,default-policy}.ts` | Engine-level Command Policy guard | Phase 3 orthogonal. |
| Security screener proxy | `packages/security/tests/{security-screener,security-posture}.test.ts` | HTTP screener proxy client | Phase 3 wraps it with `SecurityScreenAdapter`; existing screener tests must stay green. |

## 3. Expected-to-break tests

Phase 3 refactors `OrchestratorService.handleTurn`. Tests that asserted "rate-limit rejection returns `refused` status" still pass because the new waterfall returns the same status, but tests that reached into `handleTurn` internals (private methods, ordering of side effects) need rewrites.

| Test | Reason | Action |
|------|--------|--------|
| `packages/orchestrator/tests/orchestrator.test.ts:handleTurn runs identity check first` | New waterfall lives in `runAdmissionWaterfall`; the orchestrator test now exercises the wrapper, not the waterfall. | Add the same assertion to `packages/admission/tests/waterfall.test.ts` (slice 3.1) and keep the orchestrator test as a wiring test. |
| `packages/orchestrator/tests/orchestrator.test.ts:rejected turns log rate-limit error` | Rate-limit reject now produces an Admission Record, not a synthetic log line. | Rewrite — assert the Admission Record is written, and `runEvents` does not receive a `status=running` for the rejected Turn. |
| `packages/orchestrator/tests/orchestrator.test.ts:non-internal actor short-circuits` | Identity reject becomes an Admission Record with stage=`identity`. | Rewrite — assert `admissionRecordStore.create()` was called with `{stage:'identity', decision:'reject'}`. |
| `packages/orchestrator/tests/orchestrator.test.ts:budget reject wraps reason` | Same pattern — budget reject is now an Admission Record with stage=`budget`. | Rewrite — assert the record payload. |

## 4. New test inventory

| File | Cases | Coverage |
|------|-------|----------|
| `packages/admission/tests/waterfall.test.ts` (slice 3.1) | 14 | 5 waterfall order tests + 4 Admission Record tests + 5 stage-failure tests |
| `packages/admission/tests/admission-record-store.test.ts` (slice 3.1) | 8 | memory impl: create/get/list/range, redaction, identity-preserving fields |
| `packages/admission/tests/admission-redaction.test.ts` (slice 3.1) | 6 | secret-shaped redaction on Admission Records (mirrors `observability.ts` redaction) |
| `packages/security/tests/screen-adapter.test.ts` (slice 3.2) | 12 | off/shadow/enforce modes × {allow,deny,unavailable} |
| `packages/security/tests/screen-shadow.test.ts` (slice 3.2) | 7 | Shadow Record shape, retention window, capacity limits |
| `packages/security/tests/screen-enforce-cutover.test.ts` (slice 3.2) | 5 | missing-mode default, invalid-mode startup failure, no auto-escalation |
| `packages/runs/tests/observability-phase-3.test.ts` (slice 3.3) | 8 | 4 metric names + 4 helpers (ticks on each path) |
| `packages/orchestrator/tests/admission-integration.test.ts` (slice 3.1) | 6 | orchestrator wraps waterfall; rejected work has no Run; accepted work calls dispatch |

Total new cases: **66** (matches the test basket below).

## 5. Coverage deltas

Phase 0 floors (per `docs/gate-enforcement.md` §3): 90% lines / 85% branches for `packages/orchestrator`. Phase 3 introduces `packages/admission` which becomes a new package and inherits the same floor (90% / 85%). The waterfall itself is highly testable: each stage is a pure function that returns a `StageOutcome`, so branch coverage converges to 100% in the happy paths.

| Package | Lines floor | Branches floor | Reporting slice |
|---------|-------------|----------------|-----------------|
| `packages/admission` (new) | 90% | 85% | slice 3.1 PR |
| `packages/orchestrator` | 90% (no change) | 85% (no change) | slice 3.1 PR (verify refactor preserves coverage) |
| `packages/security` | 90% (no change) | 85% (no change) | slice 3.2 PR |
| `packages/runs` (observability extension only) | 90% (no change) | 85% (no change) | slice 3.3 PR |

## 6. Memory/PG parity strategy

Phase 3 adds two ports with parity obligations:

- **`AdmissionRecordStore`** — both memory and Postgres legs. Memory ships in slice 3.1; Postgres twin deferred to slice 3.1's follow-up note (Phase 3 owns a minimal schema in `schema.ts` mirroring the memory shape). PG legs skip without `QM_NEXT_PG_URL`.
- **`ShadowRecordStore`** — memory only for slice 3.2. Shadow Records are operator observability, not user-facing. Deferring PG to Phase 4+ is acceptable because (a) Shadow Records do not gate correctness, (b) retention window is short (e.g. 7 days), (c) PG twin can be added when Phase 5 IM fan-out needs durable Shadow Records.
- **`SecurityScreenAdapter`** — in-process only; no persistence contract.

The existing memory/PG twin pattern (`packages/store/src/{memory-run-store,postgres-run-store}.ts`) carries over: `createMemoryAdmissionRecordStore()` and `createPostgresAdmissionRecordStore()` (PG leg stub for slice 3.1, real implementation deferred). The orchestrator composition picks the implementation from `QM_NEXT_PG_URL`.

## 7. Performance budgets

Per the Phase 3 plan and ADR-0007:

| Operation | Budget | Mechanism |
|-----------|--------|-----------|
| Identity stage | <5 ms | cache principal-scope lookup; in-memory map |
| Rate-limit stage | <5 ms | token-bucket in-memory; Redis twin optional |
| Budget stage | <10 ms | async counter; cache recent read |
| Security Screen (Shadow) | <200 ms p95 | async call to screener; parallel with resolution prewarm |
| Security Screen (Enforce) | <200 ms p95 | same path; fail-closed on timeout |
| Resolution + lease | <30 ms | in-memory map + write-through cache |
| Total Admission | <250 ms p95 (off mode), <500 ms p95 (enforce mode) | waterfall runs sequentially; Security Screen is the only async stage |
| Admission Record write | <20 ms p95 | sync in-memory append; PG twin in same tx |

Slice 3.3 (observability) wires these into the runbook so on-call can detect drift.

## 8. Open questions

1. **Should `runAdmissionWaterfall` be one function or one function per stage?** Phase 3 ships a single function with a fixed waterfall (ADR-0007 forbids reordering). Per-stage functions are exposed for testability but composition is fixed.
2. **Where does `AdmissionRecordStore` live — `@qm/store` or a new `@qm/admission`?** Phase 3 keeps it in `@qm/admission` for ownership clarity (ADR-0007: orchestrator seam, not store-package seam).
3. **Is Shadow Record retention an operator-configurable knob?** Yes — `SHADOW_RECORD_TTL_MS` (default 7 days) with a memory eviction pass. PG twin would have a cron-driven retention sweep.
4. **Does Enforce Mode require a sample-size gate before cutover?** Yes (ADR-0004 §3). Phase 3 ships the gate; the operator process declares `cutoverCriteria` once at config time. Phase 3 does NOT auto-escalate — that is an explicit operator decision.

## 9. Gate self-check

| Question | Answer |
|----------|--------|
| Does Phase 3 add new top-level types? | Yes — `AdmissionRecord`, `AdmissionStage`, `AdmissionDecision`, `ShadowRecord`. |
| Does Phase 3 change existing top-level types? | No. `Run` / `Attempt` / `ApprovalStore` are untouched. |
| Does Phase 3 introduce a new package? | Yes — `packages/admission`. Floor 90%/85% per `docs/gate-enforcement.md` §3. |
| Does Phase 3 introduce a new persistence contract? | Yes — `AdmissionRecordStore` port. PG twin deferred. |
| Does Phase 3 introduce a new observability metric? | Yes — 4 new constants in `RUN_METRICS` (slice 3.3). |
| Does Phase 3 cross any architecture boundary? | Yes — `@qm/orchestrator` → `@qm/admission` (new dep direction). |
| Does Phase 3 create a circular dependency? | No — `@qm/orchestrator` consumes `@qm/admission` (one-way). |
| Does Phase 3 require the architecture gate (`pnpm test:architecture`)? | Yes — same as Phase 1/2. New package must satisfy dependency direction. |
| Does Phase 3 require `pnpm test:pg`? | Partially — slice 3.1 includes PG leg stub; the real PG twin ships in a follow-up slice. |
| Does Phase 3 require any new deploy artifact? | No — adds 1 env knob (`SHADOW_RECORD_TTL_MS`), 1 env knob (`SECURITY_SCREEN_MODE`), 1 config gate (`SECURITY_SCREEN_CUTOVER_DECLARED`). |

## 10. Summary scorecard

- Regression basket: 9 entries.
- Expected-to-break: 4 tests (Phase 3 explicitly rewrites them).
- New tests: 66 cases across 8 files.
- New package: 1 (`packages/admission`).
- New metric constants: 4.
- New ports: 2 (`AdmissionRecordStore`, `ShadowRecordStore`).
- Linked ADRs: 3 (0004, 0006, 0007).
- Linked prior phases: Phase 1 (Run truth). Phase 3 does NOT depend on Phase 2 (Command Gate) — the plan distinguishes them explicitly (ADR-0002).