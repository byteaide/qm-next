# Phase 5 Test Impact Assessment

**Phase:** 5 — Durable IM intake and fan-out
**Branch:** `feat/im-intake`
**Linked ADRs:** 0008 (IM intake is durable fan-out), 0015 (IM subscribers have independent cursors)
**Linked plan:** `docs/implementation-plan.md` §Phase 5
**Authored in commit:** first Phase 5 slice (slices 5.1–5.3)
**Started:** 2026-09-20

This document captures the test impact before the first Phase 5 PR. It follows the same template as `docs/test-impact/phase-{0,1,2,3,4}.md`.

## 1. Summary

Phase 5 replaces the registry's process-local `seenEvents` Map as the dedup authority with a durable Intake Inbox in `@qm/im-core`, keyed by provider plus provider delivery identity (`provider`, `eventId` — the Intake Key). Accepted intake fans out to explicit Intake Subscribers — `bridge`, `mirror`, `audit` — each holding an independent durable Subscriber Cursor. A failed subscriber retries with exponential backoff and dead-letters after exhaustion without losing the failed record; dead-letter records carry an admin-only `redelivery_url` and a secret-free `last_error`, and replay is an admin-only, audited, never-automatic operation.

The bridge subscriber wraps the existing `ImTurnBridge.sink`, so Turn creation behavior is unchanged; the subscriber records the created Turn (Run) id on the Intake Record (`markTurn`, first-writer-wins) so a redelivery after a crash between Turn creation and cursor advance maps to the same Turn identity instead of enqueueing a second Run. The `im-bridge` service switches to the intake path behind the `target.im-intake` RolloutFlag (port per Phase 0 ground rule 4); flag off keeps the legacy direct-sink path. The process-local registry dedup Map stays as a non-authoritative first-level guard until the Phase 7 cleanup item ("Remove process-local IM dedup as the authoritative mechanism") removes it.

**Scope of this PR:** slices 5.1–5.7 plus §5.5 observability. New files: `packages/im-core/src/intake.ts` (contracts), `packages/im-core/src/runtime/{memory-intake-store,postgres-intake-store,intake-fanout,target-im-intake-flag}` — the flag helper lives in `@qm/concurrency` next to the Phase 1 flag, `packages/im-bridge/src/intake-subscriber.ts`; new tests listed in §5; `packages/runs/src/observability.ts` extended with the `set` gauge operation and the four `im_*` metric families (plan §5.5); `docs/operations.md` gains the Phase 5 runbook entries; `docs/known-violations.md` gains KV-007 (process-local dedup demoted to non-authoritative, removed in Phase 7).

## 2. Regression basket

| Test path | Purpose | Why critical |
|---|---|---|
| `packages/im-core/tests/registry.test.ts` | Provider registration, dispatch, dispose semantics | The registry remains the provider→core transport; its dispatch contract must not change |
| `packages/im-core/tests/delivery-loop.test.ts` | Outbound claim loop, backoff, park | Phase 5 must not touch the outbound path |
| `packages/im-core/tests/delivery-queue.test.ts` | Memory outbound queue idempotency/leases | Outbound idempotency is independent of intake |
| `packages/im-core/tests/delivery-queue-pg.test.ts` | Postgres outbound queue twin | Memory/PG parity on the outbound side stays green |
| `packages/im-bridge/tests/im-bridge.test.ts` | Inbound message → Turn → terminal → delivery reply | The bridge subscriber wraps `sink`; end-to-end behavior preserved |
| `packages/concurrency/tests/contract-parity.test.ts` | Phase 0 port contract suite | Phase 5 adds a flag but changes no port semantics |
| `packages/concurrency/tests/target-run-observation-flag.test.ts` | Phase 1 flag registration pattern | The Phase 5 flag follows the same port; Phase 1 behavior untouched |
| `packages/runs/tests/observability.test.ts` (and phase-4 variant) | Metric registry inc/add/snapshot | `set()` must be additive; existing counters unchanged |
| `scripts/check-im-isolation.sh` (`pnpm check:im`) | No IM platform symbols in core packages | New intake code lives in im-core — must stay platform-agnostic |
| `packages/im-feishu/tests/*` | Provider adapter behavior through the registry | Adapters are untouched; intake sits behind the registry sink |

## 3. Tests expected to break

| Test path | Why it breaks | Resolution | Replacement test |
|---|---|---|---|
| (none expected) | The registry's `onEvent` contract and dedup Map are unchanged; the intake path is composed in the service layer behind the rollout flag | Keep | — |

## 4. Deletion justifications

| Original test | Justification | Alternative coverage |
|---|---|---|
| (none) | No tests are deleted in Phase 5. The process-local dedup Map remains in place (non-authoritative) until Phase 7 removes it; when that cleanup lands, any dedup-specific registry assertions move to the inbox contract suite | `packages/im-core/tests/intake-inbox.test.ts` |

## 5. New test inventory

| Test path | Layer | Targets ADR | Memory mode | PG mode | Architecture gate |
|---|---|---|---|---|---|
| `packages/im-core/tests/intake-inbox.test.ts` | contract | 0008 | yes | yes (PG twin file) | no |
| `packages/im-core/tests/intake-store-pg.test.ts` | contract | 0008, 0015 | n/a | yes | no |
| `packages/im-core/tests/intake-fanout.test.ts` | contract | 0008, 0015 | yes | yes | no |
| `packages/im-core/tests/intake-restart.test.ts` | integration | 0008 | yes | yes | no |
| `packages/im-core/tests/target-im-intake-flag.test.ts` | unit (flag port) | 0008 | yes | n/a | yes (flag port discipline) |
| `packages/im-bridge/tests/im-intake-wiring.test.ts` | integration | 0008 | yes | n/a | no |
| `packages/runs/tests/observability-phase-5.test.ts` | unit | 0008 | yes | n/a | no |

Coverage notes:

- `intake-inbox.test.ts` (memory) and `intake-store-pg.test.ts` (Postgres) run the same logical assertions against both twins: accept/dedup on `(provider, eventId)`, distinct providers not conflated, `markTurn` first-writer-wins, `advance` monotonicity, `listAfterSeq` ordering, dead-letter record idempotency, `markRedelivered`.
- `intake-fanout.test.ts` drives the loop with a fake clock and asserts: fan-out to all subscribers, independent cursors, one failing subscriber does not block others, retry with backoff redelivers, exhaustion dead-letters without losing the record, `redelivery_url` present, `last_error` secret-free, replay audited + never auto-replayed, and all four §5.5 metric families tick.
- `intake-restart.test.ts` constructs a new fanout over the same stores (simulated restart) and asserts: cursors resume, no duplicate Turns are created on redelivery (same Turn identity via `markTurn`), and duplicate live delivery creates one Turn.

## 6. Coverage deltas

| Layer | Before phase | Target after phase | Floor | Actual at PR time |
|---|---|---|---|---|
| `packages/im-core` lines | 100%* | ≥ 95% | 90% (gate-enforcement §3) | measured at PR |
| `packages/im-core` branches | n/a | ≥ 90% | 85% | measured at PR |
| `packages/im-bridge` lines | ≥ 90% | ≥ 90% (intake-subscriber added) | 90% | measured at PR |

*im-core currently reports at or near the floors; the new intake modules land fully covered by the new suites.

## 7. Memory/Postgres contract parity strategy

- **Shared contract suite**: `packages/im-core/tests/intake-inbox.test.ts` (memory) mirrors `packages/im-core/tests/intake-store-pg.test.ts` (Postgres) case-for-case; the same logical operation sequence is asserted against both implementations.
- **Random-seed replay**: not introduced in Phase 5; the dedup/cursor operations are deterministic on their inputs. The Phase 0 fake-clock fixture drives the fanout loop instead of wall-clock sleeps.
- **Deterministic-clock strategy**: `IntakeFanoutOptions.now` injects the clock (defaults to `Date.now`); tests from `@qm/concurrency`'s fake clock pattern inject a stepped clock so backoff windows are asserted exactly.
- **Cross-implementation runner**: both suites run under `pnpm test`; the PG twin activates under `pnpm test:pg` (env-gated on `QM_NEXT_PG_URL`, same pattern as `delivery-queue-pg.test.ts`).
- **PG-mode parity failure handling**: a memory-green/PG-red run blocks the phase gate (plan: a phase is complete only when its gate passes in both modes).

## 8. Test data lifecycle

- **New fixtures introduced**: `packages/im-core/tests/intake-fixture.ts`-style helpers live inline in the test files (message events with synthetic `provider`/`eventId`); no external data.
- **Existing fixtures modified**: none.
- **Test data reset strategy**: per-test — each test constructs fresh stores; PG tests use provider-scoped keys prefixed `p5-` and close pools in `t.after`.
- **Cross-test isolation**: memory stores are per-instance; PG tables persist across files but every assertion keys on unique per-test identifiers (`provider` prefixed by test name), matching the existing delivery-queue PG test conventions.

## 9. Performance budget

| Operation | Memory mode SLO | PG mode SLO | Measurement |
|---|---|---|---|
| Intake dedup lookup + accept | < 1 ms p95 | < 5 ms p95 | fanout ingest path, asserted indirectly by loop tick budgets in tests; formal measurement via existing benchmark scripts if added |
| Subscriber cursor advance | < 1 ms p95 | < 5 ms p95 | same |
| Fanout tick (N subscribers, 0 records) | < 1 ms | < 1 ms | loop overhead; no I/O when idle |
| Dead-letter record | < 1 ms p95 | < 5 ms p95 | exhaustion path |

A regression beyond the SLO blocks the PR; the phase gate ratifies these numbers.

## 10. Open questions

| Question | Owner | Due |
|---|---|---|
| Where does the admin HTTP surface for dead-letter list/inspect/replay live? The plan's slices scope the mechanism to im-core; the admin route adapter (admin-only, audited) lands with the api/admin wiring — tracked as a follow-up slice on this branch, not a gate blocker | phase owner | before phase gate sign-off |
| Should `im_subscriber_lag` be exported as a real gauge type once the metrics backend wiring (OTel/Sentry) lands? Phase 5 adds `set()` to the in-process registry with counter-snapshot compatibility | phase owner | before phase gate sign-off |

## 11. Changelog

| Date | Change | Author |
|---|---|---|
| 2026-09-20 | Initial submission | phase-5 branch session |

## 12. Gate self-check

Before the Phase Gate is signed off, confirm:

- [ ] Regression basket is green in memory and PG modes
- [ ] All "expected to break" tests are resolved (none expected)
- [ ] No deletions in §4 (none)
- [ ] Coverage on changed code is at or above the floor
- [ ] Memory/PG contract parity strategy is verified by automated tests (`intake-store-pg.test.ts` mirrors `intake-inbox.test.ts`)
- [ ] Performance budgets are met or have an open waiver
- [ ] All open questions in §10 are resolved
- [ ] Architecture gate has run on the phase branch
- [ ] Linked ADRs are referenced in test names or descriptions where applicable (ADR-0008, ADR-0015)
