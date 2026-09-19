# Test Impact Assessment — Phase 0

Status: **Initial submission — 2026-09-19**

## 1. Phase metadata

```yaml
phase: 0
branch: chore/architecture-gates
plan_section: docs/implementation-plan.md Phase 0
linked_adrs:
  - ADR-0001   # Run owns terminal events and observation
  - ADR-0003   # Runtime contracts decouple Trigger and API
  - ADR-0010   # Approval suspends the same Run
  - ADR-0013   # Run state and events commit together
owner: platform
started: 2026-09-19
target_phase_gate: 2026-09-19
gate_enforcement: docs/gate-enforcement.md
```

## 2. Regression basket

The regression basket is the set of existing tests that **must continue
to pass** through Phase 0 and remain green into Phase 1. Phase 0 does
not change runtime behavior, so every existing test stays as-is.

| Test path | Purpose | Why critical |
|---|---|---|
| `packages/store/tests/stores.test.ts` | Memory + Postgres run/session store contracts | Phase 1 builds on the existing run store; existing behavior is the safety net for the target migration. |
| `packages/runs/tests/runs.test.ts` | Signal / activity / state bus, worker, reaper, drain | Run lifecycle primitives exercised here are reused by Phase 1 target contracts. |
| `packages/approvals/tests/approvals.test.ts` | Approval decision state machine | Phase 2 migrates to `ApprovalContinuation`; the existing state machine is the parity baseline. |
| `packages/types/src/*` (compile-only) | Target contracts compile | Type-only package; typecheck is the gate. |
| `packages/orchestrator/tests/*.test.ts` | Turn orchestration shape | Phase 3 admission seam rides on the orchestrator. |
| `packages/im-core/tests/*.test.ts` | IM core isolation | `pnpm check:im` is the strict gate; Phase 5 builds durable intake on top. |

Tests in this basket may not be deleted, skipped, `.only`'d, or weakened
during Phase 0. Changing assertion strings requires an issue and an entry
in §11.

## 3. Tests expected to break

None. Phase 0 does not switch runtime write paths. New types are
**target-only** (`TargetRunEvent*`, `CommandDecision` interface,
`RolloutFlag` port, `LeaseStore` / `SequenceAllocator` /
`SessionReservationStore`) and live alongside the legacy contracts that
the runtime still uses.

The legacy file `packages/types/src/run-events.ts` was renamed
(`LegacyRunEvent*`) with `RunEvent`/`RunEventBus`/`RunEventDraft` kept
as type aliases. The runtime consumers (`store`, `orchestrator`, `web-ui`)
did not need changes because they import the un-renamed names.
`packages/types/src/tools.ts` similarly renamed the legacy
`CommandDecision` literal union to `LegacyCommandDecision` and
`packages/sandbox/src/policy.ts` was updated to use the new name — both
are non-behavior changes. No test broke as a result (verified by `pnpm test`
running green before and after).

## 4. Deletion justifications

No tests deleted in Phase 0.

## 5. New test inventory

| Test path | Layer | Targets ADR | Memory mode | PG mode | Architecture gate |
|---|---|---|---|---|---|
| `packages/concurrency/tests/contract-parity.test.ts:lease-store (memory)` | contract | ADR-0001, ADR-0010 | yes | n/a | yes |
| `packages/concurrency/tests/contract-parity.test.ts:lease-store (postgres)` | contract | ADR-0001, ADR-0010 | n/a | yes | yes |
| `packages/concurrency/tests/contract-parity.test.ts:sequence-allocator (memory)` | contract | ADR-0001 | yes | n/a | yes |
| `packages/concurrency/tests/contract-parity.test.ts:sequence-allocator (postgres)` | contract | ADR-0001 | n/a | yes | yes |
| `packages/concurrency/tests/contract-parity.test.ts:session-reservation (memory)` | contract | ADR-0010 | yes | n/a | yes |
| `packages/concurrency/tests/contract-parity.test.ts:session-reservation (postgres)` | contract | ADR-0010 | n/a | yes | yes |
| `packages/concurrency/tests/contract-parity.test.ts:rollout-flag registry` | unit | ADR-0001, ADR-0003 | yes | n/a | yes |
| `packages/concurrency/tests/contract-parity.test.ts:in-memory event log` | contract | ADR-0001, ADR-0013, ADR-0014 | yes | n/a | yes |
| `scripts/architecture-gate.sh` (static checks) | gate | all | yes | n/a | yes |

All rows pass in memory mode; PG-mode rows activate when
`QM_NEXT_PG_URL` is exported (CI sets it via `pnpm test:pg`).

## 6. Coverage deltas

| Layer | Before phase | Target after phase | Floor | Actual at PR time |
|---|---|---|---|---|
| `packages/types` | n/a (type-only) | n/a | n/a | n/a |
| `packages/concurrency` (new package) | n/a | 90% lines / 85% branches | 90% / 85% | Phase 1 will measure; contract suite is the floor. |

Coverage is not measured for Phase 0 because the runtime does not yet
exercise the new ports. Phase 1 must report coverage on the first PR
that switches a write path onto the target contract.

## 7. Memory/Postgres contract parity strategy

- **Shared contract suite**: `packages/concurrency/tests/contract-parity.test.ts`.
- **Random-seed replay**: not applicable — the suite is deterministic and
  the FakeClock owns time.
- **Deterministic-clock strategy**: `createFakeClock(startMs)` from
  `@qm/concurrency`. Both implementations accept a `clock` option so
  the test injects the same starting instant.
- **Cross-implementation runner**: `node --import tsx/esm --test
  packages/concurrency/tests/contract-parity.test.ts` runs both legs.
- **PG-mode parity failure handling**: when memory passes and PG fails,
  the architecture gate fails with `architecture-gate: contract suite
  failed`. CI's `pnpm test:pg` block in the merge commit is the
  authoritative source — local PG URL must match CI's image to avoid
  a false-fail.

## 8. Test data lifecycle

- **New fixtures introduced**:
  - `createFakeClock(startMs)` — owned by `@qm/concurrency/tests`.
  - `createInMemoryEventLog({ allocator })` — owned by
    `@qm/concurrency/tests`.
  - `createEventSubscriberHarness(bus)` — owned by
    `@qm/concurrency/tests`.
- **Existing fixtures modified**: none.
- **Test data reset strategy**: per-test — each test calls `makeMemoryX`
  to construct fresh stores.
- **Cross-test isolation**: the `markLeaseHeldByNewerSession` helper
  exposes internal state for the `newer_session` path; the Postgres
  leg implements that path via the durable reservation table and does
  not use the helper.

## 9. Performance budget

Performance is not measured for Phase 0 because the new ports are not
yet on any hot path. Phase 1 reports the budgets it commits to:

| Operation | Memory mode SLO | PG mode SLO | Measurement |
|---|---|---|---|
| State transition with event commit | TBD | TBD | Phase 1 PR |
| Observation snapshot | TBD | TBD | Phase 1 PR |
| Replay from cursor (k events) | TBD | TBD | Phase 1 PR |

## 10. Open questions

| Question | Owner | Due |
|---|---|---|
| Should the architecture gate fail closed when `QM_NEXT_PG_URL` is unset and the suite skips PG legs? | platform | Phase 7 (release gates) |
| When Phase 1 cuts Run Observation over, does the contract suite gain a `pg_event_log` test that runs the Postgres twin of `TargetRunEventBus`? | platform | Phase 1 |

## 11. Changelog

| Date | Change | Author |
|---|---|---|
| 2026-09-19 | Initial submission | platform |

## 12. Gate self-check

- [x] Regression basket is green in memory mode (`pnpm test`).
- [ ] Regression basket is green in PG mode (CI only — `pnpm test:pg`).
- [x] All "expected to break" tests are resolved (no expected breaks in Phase 0).
- [x] No deletions in §4.
- [ ] Coverage on changed code is at or above the floor (deferred — see §6).
- [x] Memory/PG contract parity strategy is verified by automated tests
      (`packages/concurrency/tests/contract-parity.test.ts`).
- [ ] Performance budgets are met or have an open waiver (deferred — see §9).
- [x] All open questions in §10 are recorded with owners and dates.
- [x] Architecture gate has run on the phase branch (`pnpm test:architecture`).
- [x] Linked ADRs are referenced in JSDoc on the new contract files.
