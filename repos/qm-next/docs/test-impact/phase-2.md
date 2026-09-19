# Test Impact Assessment — Phase 2

Status: **Initial submission — 2026-09-20**

## 1. Phase metadata

```yaml
phase: 2
branch: feat/command-gate
plan_section: docs/implementation-plan.md Phase 2
linked_adrs:
  - ADR-0002   # Command Policy is a production invariant
  - ADR-0010   # Approval suspends the same Run
  - ADR-0012   # Approvals are requester-scoped and expire
owner: platform
started: 2026-09-20
target_phase_gate: 2026-09-20
gate_enforcement: docs/gate-enforcement.md
```

## 2. Regression basket

The regression basket is the set of existing tests that **must continue to pass** through Phase 2. The migration is structural: every Side-Effecting Operation must route through `CommandGate` before execution, and the legacy sandbox policy engine must remain compile-compatible while Phase 2 wraps it under a typed `CommandPolicy` interface.

| Test path | Purpose | Why critical |
|---|---|---|
| `packages/types/src/*` (compile-only) | Target contracts compile | Phase 0 already froze `CommandRequest` / `CommandDecision` / `ApprovalRequest` / `ApprovalContinuation`. `pnpm typecheck` must pass with no runtime call-site change. |
| `packages/concurrency/tests/contract-parity.test.ts` | Phase 0 concurrency primitives contract suite | Phase 2 §2.3 acquires the Session Continuation Reservation alongside the existing Lease; both memory and PG legs must remain green bit-identically. |
| `packages/concurrency/tests/parity-bit-identical.test.ts` | Bit-identical memory/PG parity assertion | Phase 2 extends `SessionReservationStore.release()` with a `terminalStateConfirmed: true` guard; the parity suite must remain green when the new contract lands. |
| `packages/store/tests/stores.test.ts` | Memory + Postgres run/session store contracts | Phase 2 introduces an Awaiting Approval non-terminal Run state; existing run-store round-trip tests are the safety net during the migration window. |
| `packages/runs/tests/runs.test.ts` | Signal / activity / state bus, worker, reaper, drain | Phase 2.6 reservation release order changes how drain interacts with `awaiting_approval` rows; the existing worker / reaper / drain tests pin the legacy drain semantics until the rollout flag flips. |
| `packages/security/tests/*.test.ts` | Sandbox policy engine contract suite | Phase 2 wraps the existing sandbox policy under `CommandPolicy`; the legacy suite must keep passing to preserve the §U26.1 closure. |
| `packages/api/tests/api.test.ts` | API HTTP routes | Phase 2 adds `POST /v1/approvals/:id/{approve,reject}` and `GET /v1/approvals/:id`; the existing `POST /v1/turns` path must keep working unchanged for non-side-effecting calls. |
| `packages/web-ui/tests/web-ui.test.ts`, `packages/web-ui/tests/web-ui-relay.test.ts` | Web surface HTTP routes | Phase 2 surfaces the approval decision UI; the existing turn/runs pages must keep rendering. |
| `packages/orchestrator/tests/orchestrator.test.ts` | Turn orchestration shape | Phase 2 routes turn-handling through the Gate for every side-effecting tool; the existing harness-call assertions remain valid. |
| `docs/gate-enforcement.md` §Phase 0 boundary checks | `assertExitCodeCollapse` / `assertCommandGateConfigured` static checks | Phase 2 adds the runtime guards the static checks enforce; tests that exercise the static gate stay green. |

Tests in this basket may not be deleted, skipped, `.only`'d, or weakened
during Phase 2. Changing assertion strings requires an issue and an entry
in §11.

## 3. Tests expected to break

Phase 2 introduces structural changes that touch legacy code paths. The
following tests are expected to break and are rewritten/superseded
within Phase 2:

| Test path | Why it breaks | Resolution | Replacement test |
|---|---|---|---|
| `packages/security/tests/sandbox-policy.test.ts:deny via exit code 1` | Phase 2 enforces ADR-0002: deny must be a `CommandDecision.decision='deny'`, not an exit code. The legacy sandbox returns exit code 1 on denial; the wrapping Command Gate must translate that into a structured decision. | Rewrite — assert the structured decision and that exit codes never carry safety outcomes on the target path. | `packages/security/tests/command-gate.test.ts:deny surfaces as CommandDecision(decision='deny')` |
| `packages/runs/tests/runs.test.ts:reaper retires run with status='done'` | Phase 2 introduces `awaiting_approval` as a non-terminal Run state. The reaper must NOT retire a Run in `awaiting_approval`; legacy reaper tests that assume immediate terminal behavior must be gated on the rollout flag. | Supersede — keep legacy assertion under flag-off; add new assertion under flag-on that reaper leaves `awaiting_approval` runs alone. | `packages/runs/tests/approval-continuation.test.ts:reaper leaves awaiting_approval alone` |
| `packages/store/tests/stores.test.ts:activeForThread returns the only running Run` | Phase 2 keeps the same Run id alive through the approval continuation; `activeForThread` must not pick the suspended Run while a Continuation Attempt is in flight. | Rewrite — assert `activeForThread` continues to return the same Run id, not a successor. | `packages/store/tests/approval-continuation.test.ts:activeForThread returns the suspended Run` |
| `packages/api/tests/api.test.ts:POST /v1/turns returns 200 with reply` | Phase 2 may suspend the Attempt mid-turn (when a side-effecting tool calls the Gate); the synchronous 200 reply shape stays valid for non-side-effecting calls, but the gate must emit `attempt.suspended` for side-effecting calls. | Keep — extend only when the call required approval; otherwise same shape. | `packages/api/tests/api.test.ts:POST /v1/turns returns 202 + runId when gate suspends` |
| `packages/security/tests/sandbox-policy.test.ts:sensitive read does not require gate` | Phase 2 §2.1 explicitly adds sensitive reads as Gate-required. | Rewrite — assert sensitive reads go through the Gate. | `packages/security/tests/command-gate.test.ts:sensitive read goes through gate with decision='require_approval'` |
| `packages/api/tests/api.test.ts:POST /v1/approvals does not exist` | Phase 2 adds `POST /v1/approvals/:id/{approve,reject}`. The 404 path goes away. | Rewrite — assert the route exists and 404s only on unknown request id. | `packages/api/tests/approval-routes.test.ts:POST /v1/approvals/:id/approve by requester returns 200 + continuation id` |

A "Delete" resolution requires a §4 entry. None of the above are deletes
during Phase 2.

## 4. Deletion justifications

No deletions in Phase 2. The legacy sandbox policy engine remains
compile-compatible behind the `CommandPolicy` interface and is removed
in Phase 7.

## 5. New test inventory

| Test path | Layer | Targets ADR | Memory mode | PG mode | Architecture gate |
|---|---|---|---|---|---|
| `packages/security/tests/command-gate.test.ts:production missing policy fails startup` | integration | ADR-0002 | yes | n/a | yes |
| `packages/security/tests/command-gate.test.ts:explicit baseline policy starts successfully` | integration | ADR-0002 | yes | n/a | yes |
| `packages/security/tests/command-gate.test.ts:deny/allow/require_approval distinguishable` | unit | ADR-0002 | yes | n/a | yes |
| `packages/security/tests/command-gate.test.ts:deny is not represented as exit code` | unit | ADR-0002 | yes | n/a | yes |
| `packages/security/tests/command-gate.test.ts:side-effecting tool cannot bypass gate` | contract | ADR-0002 | yes | n/a | yes |
| `packages/security/tests/command-gate.test.ts:sensitive read can require gate` | unit | ADR-0002 | yes | n/a | yes |
| `packages/security/tests/command-gate.test.ts:pure non-sensitive read does not require gate` | unit | ADR-0002 | yes | n/a | yes |
| `packages/security/tests/command-gate.test.ts:operator policy can tighten baseline (allowlist)` | unit | ADR-0002 | yes | n/a | yes |
| `packages/approvals/tests/approval-store.test.ts:create + get roundtrip` | unit | ADR-0010 | yes | yes | yes |
| `packages/approvals/tests/approval-store.test.ts:requester principal equality enforced` | unit | ADR-0012 | yes | yes | yes |
| `packages/approvals/tests/approval-store.test.ts:duplicate decision returns original outcome` | unit | ADR-0010, ADR-0012 | yes | yes | yes |
| `packages/approvals/tests/approval-store.test.ts:rejection fails Run with approval_denied` | integration | ADR-0010 | yes | yes | yes |
| `packages/approvals/tests/approval-store.test.ts:expiry fails Run with approval_expired` | integration | ADR-0010, ADR-0012 | yes | yes | yes |
| `packages/approvals/tests/approval-store.test.ts:continuation preserves Run + Attempt + CommandRequest identity` | contract | ADR-0010 | yes | yes | yes |
| `packages/approvals/tests/approval-store.test.ts:non-requester decision is forbidden` | unit | ADR-0012 | yes | yes | yes |
| `packages/approvals/tests/approval-store.test.ts:repeated delivery cannot create second continuation attempt` | contract | ADR-0010 | yes | yes | yes |
| `packages/approvals/tests/ttl.test.ts:default TTL is 24h when not specified` | unit | ADR-0010 | yes | n/a | yes |
| `packages/approvals/tests/ttl.test.ts:renewal does not extend past absolute expiry` | unit | ADR-0012 | yes | n/a | yes |
| `packages/approvals/tests/ttl.test.ts:renewal attempt after absolute expiry returns approval_expired` | unit | ADR-0012 | yes | n/a | yes |
| `packages/approvals/tests/sweep.test.ts:durable sweep is the only expiry authority` | contract | ADR-0010 | yes | yes | yes |
| `packages/approvals/tests/sweep.test.ts:sweep runs exactly once per expired request` | contract | ADR-0010 | yes | yes | yes |
| `packages/approvals/tests/reservation-order.test.ts:durable → event → release → new Run leaves queued` | contract | ADR-0010 | yes | yes | yes |
| `packages/approvals/tests/reservation-order.test.ts:reservation release before event persistence is rejected` | unit | ADR-0010 | yes | yes | yes |
| `packages/runs/tests/approval-continuation.test.ts:approval required suspends the Attempt` | integration | ADR-0010 | yes | n/a | yes |
| `packages/runs/tests/approval-continuation.test.ts:Run becomes awaiting_approval, not terminal` | unit | ADR-0010 | yes | n/a | yes |
| `packages/runs/tests/approval-continuation.test.ts:executor lease is released during suspension` | unit | ADR-0010 | yes | n/a | yes |
| `packages/runs/tests/approval-continuation.test.ts:new same-Session Run queues while reservation held` | contract | ADR-0010 | yes | yes | yes |
| `packages/runs/tests/approval-continuation.test.ts:approval resumes the saved command point` | contract | ADR-0010 | yes | n/a | yes |
| `packages/runs/tests/approval-continuation.test.ts:the approved command executes exactly once` | contract | ADR-0010 | yes | n/a | yes |
| `packages/runs/tests/approval-continuation.test.ts:no successor Run is created on resume` | contract | ADR-0010 | yes | n/a | yes |
| `packages/runs/tests/approval-continuation.test.ts:restart between approval and resume still resumes exactly once` | contract | ADR-0010 | yes | yes | yes |
| `packages/runs/tests/approval-continuation.test.ts:rejection fails the same Run, no execution` | contract | ADR-0010 | yes | n/a | yes |
| `packages/runs/tests/approval-continuation.test.ts:expiry fails the same Run, no execution` | contract | ADR-0010 | yes | n/a | yes |
| `packages/runs/tests/approval-observation.test.ts:approval.requested/decided/expired observable` | unit | ADR-0014 | yes | yes | yes |
| `packages/runs/tests/approval-observation.test.ts:no command secret or token enters events` | unit | ADR-0014 | yes | yes | yes |
| `packages/runs/tests/command-gate-observability.test.ts:command_gate_decision_total{decision} counts` | unit | ADR-0002 | yes | n/a | yes |
| `packages/runs/tests/command-gate-observability.test.ts:approval_request_total{outcome} counts` | unit | ADR-0010 | yes | n/a | yes |
| `packages/runs/tests/command-gate-observability.test.ts:approval_renewal_total{outcome} counts` | unit | ADR-0012 | yes | n/a | yes |
| `packages/runs/tests/command-gate-observability.test.ts:approval_ttl_sweep_total{outcome} counts` | unit | ADR-0010 | yes | n/a | yes |
| `packages/runs/tests/command-gate-observability.test.ts:session_reservation_release_order_violation_total = 0` | contract | ADR-0010 | yes | yes | yes |

All rows must pass in memory mode; PG-mode rows activate when
`QM_NEXT_PG_URL` is exported (CI sets it via `pnpm test:pg`).

## 6. Coverage deltas

| Layer | Before phase | Target after phase | Floor | Actual at PR time |
|---|---|---|---|---|
| `packages/types` | n/a (type-only) | n/a | n/a | n/a |
| `packages/security` | n/a | 90% lines / 85% branches | 90% / 85% | reported on the slice-2.1 PR |
| `packages/approvals` | n/a | 90% lines / 85% branches | 90% / 85% | reported on the slice-2.3 PR |
| `packages/runs` | n/a (Phase 1 baseline) | 92% lines / 87% branches | 92% / 87% | reported on the slice-2.7 PR |
| `packages/store` | n/a (Phase 1 baseline) | 82% lines / 77% branches | 82% / 77% | reported on the slice-2.3 PR |
| `packages/api` | n/a (Phase 1 baseline) | 80% lines / 75% branches | 80% / 75% | reported on the slice-2.4 PR |
| `packages/web-ui` | n/a | 70% lines / 65% branches | 70% / 65% | reported on the slice-2.4 PR |

Coverage is measured by the standard CI run on each PR; a drop below the
floor blocks the PR until restored or a waiver (§5 of
`docs/gate-enforcement.md`) is filed.

## 7. Memory/Postgres contract parity strategy

- **Shared contract suite**: `packages/approvals/tests/approval-store.test.ts`,
  `packages/approvals/tests/sweep.test.ts`, and
  `packages/approvals/tests/reservation-order.test.ts`. PG legs activate
  when `QM_NEXT_PG_URL` is exported.
- **Random-seed replay**: not applicable — the suites are deterministic
  via `createFakeClock` from `@qm/concurrency`.
- **Deterministic-clock strategy**: `createFakeClock(startMs)` from
  `@qm/concurrency`. The TTL sweep uses `clock.now()` only for expiry
  comparisons; renewal tests pin the absolute expiry by advancing the
  clock past `createdAt + maxMs`.
- **Cross-implementation runner**: `node --import tsx/esm --test
  packages/approvals/tests/*.test.ts` plus the existing
  `contract-parity.test.ts` and `parity-bit-identical.test.ts`.
- **PG-mode parity failure handling**: when memory passes and PG fails,
  the architecture gate fails with `architecture-gate: contract suite
  failed`. CI's `pnpm test:pg` block in the merge commit is the
  authoritative source — local PG URL must match CI's image to avoid a
  false-fail.

## 8. Test data lifecycle

- **New fixtures introduced**:
  - `createMemoryCommandPolicy(opts)` — new in-memory implementation
    for slice-2.1 unit tests.
  - `createMemoryApprovalStore(opts)` — new in-memory approval store
    for slice-2.3 tests; PG twin in slice-2.6.
  - `createApprovalSweeper(deps)` — sweep harness that uses the
    `Clock` injection for deterministic expiry.
- **Existing fixtures modified**: `createMemorySessionReservationStore`
  gains an additional `terminalStateConfirmed` argument on `release`
  (Phase 0 already had the signature; Phase 2 §2.3 is the first
  consumer that must pass `true` only after step 2 of the release
  order).
- **Test data reset strategy**: per-test — each test constructs a fresh
  store, fresh `Clock`, and (when applicable) a fresh fake
  `SessionReservationStore`.
- **Cross-test isolation**: the Postgres legs use unique run ids per
  test (`randomUUID()`) so concurrent approval requests do not collide.

## 9. Performance budget

| Operation | Memory mode SLO | PG mode SLO | Measurement |
|---|---|---|---|
| Command Gate evaluation (allow/deny) | ≤ 2 ms p99 | ≤ 15 ms p99 | `packages/security/tests/perf-command-gate.test.ts` (slice-2.1 PR) |
| Approval decision round-trip | ≤ 3 ms p99 | ≤ 25 ms p99 | `packages/approvals/tests/perf-decide.test.ts` (slice-2.4 PR) |
| TTL sweep over 1000 expired requests | ≤ 50 ms p99 | ≤ 250 ms p99 | `packages/approvals/tests/perf-sweep.test.ts` (slice-2.5 PR) |
| Reservation release order (durable → event → release) | ≤ 5 ms p99 | ≤ 40 ms p99 | `packages/approvals/tests/perf-reservation.test.ts` (slice-2.6 PR) |
| Approval observation snapshot | ≤ 2 ms p99 | ≤ 20 ms p99 | `packages/runs/tests/perf-approval-observation.test.ts` (slice-2.7 PR) |

A regression beyond the SLO blocks the PR. The SLO is set in this
section and ratified by the phase gate.

## 10. Open questions

| Question | Owner | Due |
|---|---|---|
| Should the production policy selection live in `@qm/security` or in `@qm/types`? Phase 2 §2.2 says "production must explicitly select"; the type-only contract lives in `@qm/types/command-gate.ts`, but the resolver might want its own package. | platform | slice-2.2 PR |
| Does the existing `default-denylist` sandbox policy become the canonical Baseline Policy, or do we ship a fresh `baseline-deny` adapter? | platform | slice-2.2 PR |
| When the TTL sweep is in flight and a decision arrives at the same instant, what is the canonical ordering — sweep-then-decide or decide-then-sweep? ADR-0010 says the sweep is the only authority for expiry; both must observe a coherent terminal state. | platform | slice-2.5 PR |
| Is the `target.run-observation` flag from Phase 1 sufficient as the Phase 2 rollout entry, or does Phase 2 need a separate `target.command-gate` flag? | platform | slice-2.2 PR |
| How do we express `default_ttl_ms` per-deployment when the Approval Request itself records `ttlMs`? Phase 2 §2.5 says `max_ttl` is recorded; should we also record `default_ttl_ms` for replay? | platform | slice-2.5 PR |

Resolved questions move to §11 with the resolution date.

## 11. Changelog

| Date | Change | Author |
|---|---|---|
| 2026-09-20 | Initial submission | platform |

## 12. Gate self-check

- [x] Regression basket is enumerated and tied to invariant responsibility.
- [ ] Regression basket is green in memory and PG modes (verified on the slice-2.6 PR — local PG mode skipped due to `pg` module not installed; CI is authoritative).
- [ ] All "expected to break" tests are resolved (slice-2.1 PR will rewrite the first batch).
- [x] No deletions in §4.
- [ ] Coverage on changed code is at or above the floor (deferred — see §6).
- [x] Memory/PG contract parity strategy is enumerated.
- [ ] Performance budgets are met or have an open waiver (deferred — see §9).