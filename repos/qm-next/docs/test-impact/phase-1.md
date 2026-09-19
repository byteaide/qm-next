# Test Impact Assessment — Phase 1

Status: **Initial submission — 2026-09-20**

## 1. Phase metadata

```yaml
phase: 1
branch: feat/run-lifecycle
plan_section: docs/implementation-plan.md Phase 1
linked_adrs:
  - ADR-0001   # Run owns terminal events and observation
  - ADR-0005   # Project legacy Runs with new semantics
  - ADR-0011   # Run and Attempt states are separate
  - ADR-0013   # Run state and events commit together
  - ADR-0014   # Observation redacts secrets in depth
owner: platform
started: 2026-09-20
target_phase_gate: 2026-09-20
gate_enforcement: docs/gate-enforcement.md
```

## 2. Regression basket

The regression basket is the set of existing tests that **must continue to
pass** through Phase 1. The migration is dual-write: the target contracts
land alongside the legacy `done`/`pending`/`running` paths and the
architecture gate forbids new occurrences of the legacy literal in target
write paths. Tests that exercise the legacy shapes remain valid until
Phase 7 cleanup removes them.

| Test path | Purpose | Why critical |
|---|---|---|
| `packages/store/tests/stores.test.ts` | Memory + Postgres run/session store contracts | Phase 1 rewrites Run/Attempt state transitions inside `RunStore`; the existing round-trip / dedup / lease tests are the safety net for the legacy contract during the migration window. |
| `packages/runs/tests/runs.test.ts` | Signal / activity / state bus, worker, reaper, drain | Phase 1's execution ownership and reaper work extends the existing reaper and worker; the existing tests pin the legacy drain semantics that production depends on until the target contracts take over. |
| `packages/orchestrator/tests/*.test.ts` | Turn orchestration shape | Phase 1 routes events through `TargetRunEventBus` and turns state transitions inside the same transaction; orchestrator tests verify the harness call still completes. |
| `packages/concurrency/tests/contract-parity.test.ts` | Phase 0 concurrency primitives contract suite | Phase 1 builds on top of `LeaseStore` / `SequenceAllocator` / `SessionReservationStore`; both memory and PG legs must remain green bit-identically. |
| `packages/concurrency/tests/parity-bit-identical.test.ts` | Bit-identical memory/PG parity assertion | Phase 1's Run Event log commits inside the same transaction as state — the parity test must remain green when the new event-log Postgres twin lands. |
| `packages/types/src/*` (compile-only) | Target contracts compile | The new target Run/Attempt/Event types are added in Phase 1; `pnpm typecheck` must pass with no runtime call site change. |
| `packages/web-ui/tests/web-ui.test.ts`, `packages/web-ui/tests/web-ui-relay.test.ts` | Web surface HTTP routes | Phase 1 keeps the SSE route working against the legacy `RunEventBus` until the rollout flag flips; these tests pin the legacy behavior. |
| `packages/api/tests/api.test.ts` | API HTTP routes | Same as web-ui: the legacy response shape stays valid until the rollout flag in §1.5 flips. |

Tests in this basket may not be deleted, skipped, `.only`'d, or weakened
during Phase 1. Changing assertion strings requires an issue and an entry
in §11.

## 3. Tests expected to break

Phase 1 introduces a target state machine and event log but the runtime
remains on the legacy write path until §1.5. The following tests are
expected to break and are rewritten/superseded within Phase 1:

| Test path | Why it breaks | Resolution | Replacement test |
|---|---|---|---|
| `packages/store/tests/stores.test.ts:enqueue + claim + complete roundtrip` | The `complete` write sets `status='done'`; Phase 1 adds a guard that rejects `'done'` on target write paths once the rollout flag is on. The legacy path is kept behind the flag. | Supersede — when flag on, write `status='succeeded'`; legacy assertion retained under a flag-off run. | `packages/store/tests/run-store-target.test.ts:complete → succeeded` |
| `packages/store/tests/stores.test.ts:fail path parks with status='failed'` | `status='failed'` remains valid but now requires a non-empty `FailureReason` (`run.failureReason`). | Rewrite — pass a `FailureReason` and assert the new field is persisted. | `packages/store/tests/run-store-target.test.ts:fail carries FailureReason` |
| `packages/runs/tests/runs.test.ts:reaper retires expired lease` | Phase 1's reaper must distinguish `released` / `newer_session` (from `LeaseStore.reapExpired`). The legacy reaper is retained; the new path runs alongside when the rollout flag is on. | Supersede — keep legacy reaper tests; add new lease-driven reaper tests under the flag-on path. | `packages/runs/tests/run-lifecycle.test.ts:reaper respects newer-session lease` |
| `packages/runs/tests/runs.test.ts:worker drains queue` | The legacy worker writes `done` on completion. With the flag on, completion writes `succeeded`. | Supersede — keep legacy assertion under flag-off; add target assertion under flag-on. | `packages/runs/tests/run-lifecycle.test.ts:worker drains with target state` |
| `packages/orchestrator/tests/orchestrator.test.ts:handleTurn publishes RunEvent` | Phase 1 publishes through `TargetRunEventBus.publish()` which mutates the draft into an addressed event. The legacy bus still works for legacy callers. | Rewrite — assert the new envelope fields (`seq`, `ts`, `attempt`) appear in the published event. | `packages/orchestrator/tests/orchestrator.test.ts:handleTurn publishes typed envelope` |
| `packages/web-ui/tests/web-ui.test.ts:SSE delivers final RunEvent` | The SSE adapter must remain unchanged in Phase 1; the wire shape stays `status: 'running'` / terminal `TurnStatus`. | Keep — no break; the SSE adapter still consumes legacy events. | n/a |
| `packages/api/tests/api.test.ts:GET /v1/runs/:id` | The response shape stays `status: 'done'` for legacy rows; Phase 1 adds a `failureReason` field on `failed`. | Keep — extend response only when the rollout flag is on. | `packages/api/tests/api.test.ts:GET /v1/runs/:id exposes failureReason` |

A "Delete" resolution requires a §4 entry. None of the above are deletes
during Phase 1.

## 4. Deletion justifications

No deletions in Phase 1. Legacy paths remain behind the rollout flag and
are removed in Phase 7.

## 5. New test inventory

| Test path | Layer | Targets ADR | Memory mode | PG mode | Architecture gate |
|---|---|---|---|---|---|
| `packages/store/tests/run-store-target.test.ts:complete → succeeded` | unit | ADR-0001, ADR-0011 | yes | yes | yes |
| `packages/store/tests/run-store-target.test.ts:failed Run carries FailureReason` | unit | ADR-0001 | yes | yes | yes |
| `packages/store/tests/run-store-target.test.ts:terminal event not observable before commit` | contract | ADR-0013 | yes | yes | yes |
| `packages/store/tests/run-store-target.test.ts:duplicate (run_id, seq) rejected` | contract | ADR-0013 | yes | yes | yes |
| `packages/store/tests/run-store-target.test.ts:legacy `done` writes rejected on target path` | unit | ADR-0001, ADR-0005 | yes | yes | yes |
| `packages/store/tests/run-store-target.test.ts:legacy projection success/silent/refused/failed/pending → target semantics` | contract | ADR-0005 | yes | yes | yes |
| `packages/runs/tests/run-lifecycle.test.ts:state transition tests (invalid rejected)` | unit | ADR-0011 | yes | n/a | yes |
| `packages/runs/tests/run-lifecycle.test.ts:every terminal Run has exactly one Run Outcome` | unit | ADR-0001 | yes | n/a | yes |
| `packages/runs/tests/run-lifecycle.test.ts:every failed Run has a Failure Reason` | unit | ADR-0001 | yes | n/a | yes |
| `packages/runs/tests/run-lifecycle.test.ts:retry preserves Run; event log continues` | contract | ADR-0001 | yes | n/a | yes |
| `packages/runs/tests/run-lifecycle.test.ts:heartbeat extends lease before expiry` | unit | ADR-0001 | yes | n/a | yes |
| `packages/runs/tests/run-lifecycle.test.ts:expired lease loses ownership using token comparison` | unit | ADR-0001 | yes | n/a | yes |
| `packages/runs/tests/run-lifecycle.test.ts:reaper cannot release a newer Session lease` | contract | ADR-0001 | yes | n/a | yes |
| `packages/runs/tests/run-lifecycle.test.ts:shutdown releases only executor-owned lease` | unit | ADR-0001 | yes | n/a | yes |
| `packages/runs/tests/run-observation.test.ts:snapshot/replay agree` | contract | ADR-0014 | yes | yes | yes |
| `packages/runs/tests/run-observation.test.ts:reconnect from cursor yields no duplicate terminal event` | contract | ADR-0014 | yes | yes | yes |
| `packages/runs/tests/run-observation.test.ts:unauthorized callers cannot enumerate by Run ID` | unit | ADR-0014 | yes | yes | yes |
| `packages/runs/tests/run-observation.test.ts:secret-shaped producer input is redacted at the boundary` | unit | ADR-0014 | yes | n/a | yes |
| `packages/runs/tests/run-observation.test.ts:memory + Postgres pass the same contract suite` | contract | ADR-0001 | yes | yes | yes |
| `packages/runs/tests/rollout-flag.test.ts:flag off uses legacy observation; flag on uses target observation` | integration | ADR-0001 | yes | n/a | yes |
| `packages/runs/tests/observability.test.ts:counters increment on commit / conflict / reap` | unit | ADR-0013 | yes | n/a | yes |
| `packages/concurrency/tests/parity-bit-identical.test.ts:extended for run-event-log Postgres twin` | contract | ADR-0013 | yes | yes | yes |

All rows must pass in memory mode; PG-mode rows activate when
`QM_NEXT_PG_URL` is exported (CI sets it via `pnpm test:pg`).

## 6. Coverage deltas

| Layer | Before phase | Target after phase | Floor | Actual at PR time |
|---|---|---|---|---|
| `packages/types` | n/a (type-only) | n/a | n/a | n/a |
| `packages/runs` | n/a | 90% lines / 85% branches | 90% / 85% | reported on the slice-1.4 PR |
| `packages/store` | n/a | 80% lines / 75% branches | 80% / 75% | reported on the slice-1.2 PR |
| `packages/orchestrator` | n/a | 90% lines / 85% branches | 90% / 85% | reported on the slice-1.4 PR |
| `packages/concurrency` | n/a | 90% lines / 85% branches | 90% / 85% | reported on the slice-1.2 PR |

Coverage is measured by the standard CI run on each PR; a drop below the
floor blocks the PR until restored or a waiver (§5 of
`docs/gate-enforcement.md`) is filed.

## 7. Memory/Postgres contract parity strategy

- **Shared contract suite**: `packages/store/tests/run-store-target.test.ts`
  and `packages/concurrency/tests/parity-bit-identical.test.ts` (extended
  in §10's open question to also cover `pg_event_log`).
- **Random-seed replay**: not applicable — the suites are deterministic
  via `createFakeClock` from `@qm/concurrency`.
- **Deterministic-clock strategy**: `createFakeClock(startMs)` from
  `@qm/concurrency`. The Run Event log Postgres twin uses `now()` only
  for `ts`; ordering assertions rely on `seq` not `ts`.
- **Cross-implementation runner**: `node --import tsx/esm --test
  packages/store/tests/run-store-target.test.ts` plus the existing
  `contract-parity.test.ts` and `parity-bit-identical.test.ts`.
- **PG-mode parity failure handling**: when memory passes and PG fails,
  the architecture gate fails with `architecture-gate: contract suite
  failed`. CI's `pnpm test:pg` block in the merge commit is the
  authoritative source — local PG URL must match CI's image to avoid a
  false-fail.

## 8. Test data lifecycle

- **New fixtures introduced**:
  - `createFakeClock(startMs)` — already exists in `@qm/concurrency`,
    reused for the Run Event log suites.
  - `createInMemoryRunEventLog({ allocator, authorize })` — extends the
    existing `createInMemoryEventLog` with a `Run` envelope so callers
    can publish `TargetRunEventDraft` and assert `RunSnapshot` matches
    the durable projection.
  - `createPostgresRunEventLog({ connectionString, allocator })` —
    Postgres twin of the in-memory log; sits in the same package.
- **Existing fixtures modified**: none in Phase 1.
- **Test data reset strategy**: per-test — each test constructs a fresh
  store, fresh allocator, and (when applicable) a fresh fake clock.
- **Cross-test isolation**: the Postgres legs use unique run IDs per
  test (`randomUUID()`) so concurrent runs do not collide on
  `(run_id, seq)`.

## 9. Performance budget

| Operation | Memory mode SLO | PG mode SLO | Measurement |
|---|---|---|---|
| State transition with event commit | ≤ 5 ms p99 | ≤ 30 ms p99 | `packages/store/tests/perf-target.test.ts` (slice-1.2 PR) |
| Observation snapshot (10 events) | ≤ 2 ms p99 | ≤ 20 ms p99 | `packages/store/tests/perf-observation.test.ts` (slice-1.4 PR) |
| Replay from cursor (k=100 events) | ≤ 5 ms p99 | ≤ 50 ms p99 | same suite as above |
| Heartbeat / renew round-trip | ≤ 2 ms p99 | ≤ 15 ms p99 | `packages/concurrency/tests/perf-lease.test.ts` (slice-1.3 PR) |
| Reaper sweep over 1000 expired leases | ≤ 50 ms p99 | ≤ 250 ms p99 | `packages/runs/tests/perf-reaper.test.ts` (slice-1.3 PR) |

A regression beyond the SLO blocks the PR. The SLO is set in this
section and ratified by the phase gate.

## 10. Open questions

| Question | Owner | Due |
|---|---|---|
| When the Phase 1 target contract lands, does the contract suite gain a `pg_event_log` test that runs the Postgres twin of `TargetRunEventBus`? | platform | slice-1.2 PR |
| Should the architecture gate fail closed when `QM_NEXT_PG_URL` is unset and the suite skips PG legs? | platform | Phase 7 (release gates) |
| What is the canonical failure-reason mapping for legacy `pending_approval` without continuation context (KV-001 entry) — `approval_continuation_unavailable` vs a runtime guard that returns `pending_approval` until Phase 2 lands? | platform | slice-1.5 PR |
| Does the legacy `TurnStatus` continue to live alongside `RunOutcome` until Phase 7 cleanup, or do we deprecate it now? | platform | slice-1.4 PR |

Resolved questions move to §11 with the resolution date.

## 11. Changelog

| Date | Change | Author |
|---|---|---|
| 2026-09-20 | Initial submission | platform |

## 12. Gate self-check

- [x] Regression basket is enumerated and tied to invariant responsibility.
- [ ] Regression basket is green in memory and PG modes (verified on the slice-1.2 PR — local PG mode skipped due to `pg` module not installed; CI is authoritative).
- [ ] All "expected to break" tests are resolved (slice-1.2 PR will rewrite the first batch).
- [x] No deletions in §4.
- [ ] Coverage on changed code is at or above the floor (deferred — see §6).
- [x] Memory/PG contract parity strategy is enumerated.
- [ ] Performance budgets are met or have an open waiver (deferred — see §9).
- [x] All open questions in §10 are recorded with owners and dates.
- [ ] Architecture gate has run on the phase branch (runs at slice-1.2 PR).
- [x] Linked ADRs are referenced in test names or descriptions.