# Test Impact Assessment — Phase 7

Status: **Merged — 2026-09-20** (phase opening, before first cleanup commit)

## 1. Phase metadata

```yaml
phase: 7
branch: chore/architecture-cutover
plan_section: docs/implementation-plan.md Phase 7
linked_adrs: [ADR-0001, ADR-0002, ADR-0003, ADR-0004, ADR-0005, ADR-0006, ADR-0007, ADR-0008, ADR-0009, ADR-0010, ADR-0011, ADR-0012, ADR-0013, ADR-0014, ADR-0015, ADR-0016, ADR-0017]
owner: tiger.w
started: 2026-09-20
target_phase_gate: 2026-09-21
gate_enforcement: docs/gate-enforcement.md
```

Baseline at branch creation (commit `6b70c85`): `pnpm test` 940 pass / 0 fail /
51 skip; `pnpm test:architecture`, `pnpm check:im`, `pnpm rescope-check` OK;
`pnpm typecheck` RED (~90 errors — repo-wide debt recorded at `16c9370` as
"separate repair"); `pnpm test:pg` requires docker (available).

## 2. Regression basket

| Test path | Purpose | Why critical |
|---|---|---|
| `packages/concurrency/tests/contract-parity.test.ts` | LeaseStore / SequenceAllocator / SessionReservation / RolloutFlag memory↔PG bit-identical parity | Concurrency primitives are the cutover's safety floor; parity loss breaks every phase gate below |
| `packages/store/tests/stores.test.ts` | RunStore contract (memory + PG) | Run truth survives the removal of legacy paths |
| `packages/store/tests/run-event-log.test.ts` | Durable Run event log `(run_id, seq)` uniqueness, transactional commit | Terminal-state durability is the invariant the legacy path is being removed in favour of |
| `packages/runs/tests/run-event-integration.test.ts` | Target envelope writes through SequenceAllocator | Proves target write path remains the only writer after legacy removal |
| `packages/api/tests/runs-observation-routes.test.ts` | Observation snapshot/replay/subscribe authorization + redaction | Observation becomes the only Run surface once the legacy stream is deleted |
| `packages/orchestrator/tests/admission-integration.test.ts` | Admission waterfall order + Admission Record | Rejections must never become Runs during cutover |
| `packages/approvals/tests/*.test.ts` | Approval suspend/resume/reject/expiry on the SAME Run | Successor-Run logic removal must not regress same-Run continuation |
| `packages/security/tests/command-gate.test.ts` | Command Gate allow/deny/require_approval distinction | Policy decisions stay structured while the legacy string-union is removed |
| `packages/im-core/tests/intake-*.test.ts` | Durable Intake Inbox dedup + fan-out + cursors | Durable intake becomes the ONLY dedup authority after KV-007 removal |
| `packages/triggers/tests/architecture.test.ts` | Triggers do not depend on `@qm/api` | Boundary holds while `cronsRuntime` compat is deleted |
| `pnpm test:architecture` (suite) | Static boundary + contract gates | The cutover must tighten, never loosen, gate assertions |

Tests in this basket may not be deleted, skipped, `.only`'d, or weakened during
the phase. Assertion-string changes require a §11 entry.

## 3. Tests expected to break

| Test path | Why it breaks | Resolution | Replacement test |
|---|---|---|---|
| `packages/web-ui/tests/web-ui.test.ts` (legacy `/api/runs/:id/events` SSE cases) | Legacy stream (runEvents.replay compensation + `status === 'done'` reads) is removed | Rewrite | `packages/web-ui/tests/web-ui.test.ts` cases against `/api/runs/:id/observation/*` |
| `packages/web-ui/tests/web-ui-relay.test.ts` (legacy relay compensation cases) | Same legacy surface removed | Rewrite | relay cases against observation routes |
| `packages/api/tests/api.test.ts` (`done` status assertions) | Legacy terminal status removed from target surfaces | Rewrite | assert `succeeded`/`failed` target outcomes |
| `packages/api/tests/admin.test.ts` (`done` counting) | Legacy status no longer exists on Run rows | Rewrite | count by target RunState |
| `packages/triggers/tests/architecture.test.ts` (WireCronRuntimeService seam assertion) | `cronsRuntime` compat field deleted (KV-002) | Rewrite | assert the field is absent and Triggers consume `TriggerRuntime` only |
| `packages/im-core/tests/registry.test.ts` (in-process dedup cases) | `seenEvents` Map removed (KV-007) | Rewrite | dedup cases assert durable Intake Inbox is the sole authority |
| `packages/im-bridge/tests/im-intake-wiring.test.ts` (flag-gated branch cases) | `target.im-intake` flag removed; durable path unconditional | Rewrite | wiring asserts no flag consult and durable accept always |
| `packages/concurrency/tests/target-run-observation-flag.test.ts` | Flag deleted | Delete | §4 |
| `packages/concurrency/tests/target-im-intake-flag.test.ts` | Flag deleted | Delete | §4 |
| `packages/sandbox` policy tests asserting `LegacyCommandDecision` | KV-005: legacy string union replaced by typed `CommandDecision` | Rewrite | assert structured decision shape |
| `packages/orchestrator/tests/orchestrator.test.ts` (legacy bus cases, KV-006) | Legacy RunEventBus publish path removed | Rewrite | events assert typed envelope + allocator seq |
| `packages/boot/tests/profile.test.ts`, `packages/im-bridge/tests/im-bridge.test.ts` (`done` assertions) | Legacy status reads removed | Rewrite | target status assertions |
| `packages/store/tests/stores.test.ts` / `packages/runs/tests/runs.test.ts` (`done` write assertions) | `done` rejected/absent on target paths | Rewrite | terminal writes assert `succeeded`/`failed` + FailureReason |

## 4. Deletion justifications

| Original test | Justification | Alternative coverage |
|---|---|---|
| `packages/concurrency/tests/target-run-observation-flag.test.ts` | `target.run-observation` RolloutFlag and its registration are removed at cutover; the dual path no longer exists | `packages/api/tests/runs-observation-routes.test.ts` + `packages/web-ui` observation cases prove the unconditional target observation path |
| `packages/concurrency/tests/target-im-intake-flag.test.ts` | `target.im-intake` RolloutFlag removed at cutover | `packages/im-core/tests/intake-inbox.test.ts` + `im-bridge/tests/im-intake-wiring.test.ts` prove the unconditional durable intake path |
| Legacy `runEvents` replay/`done`-polling SSE cases in `web-ui.test.ts` | The compensated legacy stream is deleted per checklist ("Remove Web polling/replay compensation") | Observation replay/subscribe route cases with cursor continuity |
| Rollout-flag contract cases inside `contract-parity.test.ts` registry subtests | Registry itself stays; only the two phase flags disappear | Registry contract tests keep passing (register/envOverride/duplicate) |

## 5. New test inventory

| Test path | Layer | Targets ADR | Memory mode | PG mode | Architecture gate |
|---|---|---|---|---|---|
| `pnpm test:architecture` extensions: zero `cronsRuntime` symbols; zero `seenEvents` in `im-core/src`; zero `target.*` flag registrations; `term: 'done'` grep stays zero | static | 0001, 0003, 0008 | n/a | n/a | yes |
| `packages/web-ui/tests/web-ui-observation.test.ts` (if extraction needed) | integration | 0014 | yes | yes | no |
| typecheck repair regression: `pnpm typecheck` added to the phase's own pre-commit verification loop | static | all | n/a | n/a | yes |

## 6. Coverage deltas

| Layer | Before phase | Target after phase | Floor | Actual at PR time |
|---|---|---|---|---|
| target runtime packages touched by cleanup | covered by basket above | no net loss (deletions remove code+tests together) | per `gate-enforcement.md` §3 | tracked per slice commit |

Deletions remove legacy code and its tests together; the replacement table in
§3 keeps behavioural coverage. Coverage floors apply to changed code only.

## 7. Memory/Postgres contract parity strategy

- **Shared contract suite**: `packages/concurrency/tests/contract-parity.test.ts`; `packages/store/tests/stores.test.ts` (dual-mode).
- **Random-seed replay**: unchanged from Phase 0 fixtures; seeds in fixture helpers.
- **Deterministic-clock strategy**: fake clock fixture from Phase 0 (`packages/concurrency` test helpers).
- **Cross-implementation runner**: `pnpm test:pg` (ephemeral PG16 container, file concurrency 1).
- **PG-mode parity failure handling**: any memory-green/PG-red divergence blocks the slice commit; no waiver without an ADR-level decision recorded in §11.

## 8. Test data lifecycle

- **New fixtures introduced**: none beyond existing Phase 0–6 fixtures.
- **Existing fixtures modified**: legacy-status fixtures replaced by target-state fixtures where the legacy union is deleted.
- **Test data reset strategy**: per-file (existing convention; PG runner enforces file concurrency 1).
- **Cross-test isolation**: unchanged.

## 9. Performance budget

No new hot paths are introduced by Phase 7 (pure removal + type repair). The
existing SLOs from `docs/test-impact/phase-1.md` §9 remain binding: observation
snapshot/replay and admission waterfall budgets carry over unchanged. The
`pnpm test` wall-clock must not regress beyond +10% versus the `6b70c85`
baseline (11.8 s) as a coarse regression tripwire.

## 10. Open questions

| Question | Owner | Due |
|---|---|---|
| "Remove closing event streams on Attempt failure" — verify whether any attempt-failure stream-close site remains post-Phase-1, or the item is already satisfied | tiger.w | before Phase Gate |
| "Remove orchestrator-owned subscriber truth" — confirm orchestrator has no residual subscriber registry after Phase 1 slice 1.4; if none, record as already-satisfied with evidence | tiger.w | before Phase Gate |
| "Remove Web/IM successor-Run approval logic" — grep-verify no successor-Run creation sites remain post-Phase-2; if none, record as already-satisfied | tiger.w | before Phase Gate |
| Superseded-ADR marking: decide whether ADR-0005 (legacy projection) should be marked superseded once the legacy union is deleted | tiger.w | before Phase Gate |

## 11. Changelog

| Date | Change | Author |
|---|---|---|
| 2026-09-20 | Initial submission | tiger.w |

## 12. Gate self-check

- [ ] Regression basket is green in memory and PG modes
- [ ] All "expected to break" tests are resolved (rewritten, deleted-with-justification, or superseded)
- [ ] No deletions in §4 are missing an alternative coverage row
- [ ] Coverage on changed code is at or above the floor
- [ ] Memory/PG contract parity strategy is verified by automated tests
- [ ] Performance budgets are met or have an open waiver
- [ ] All open questions in §10 are resolved
- [ ] Architecture gate has run on the phase branch
- [ ] Linked ADRs are referenced in test names or descriptions where applicable
