# Test Impact Assessment Template

Status: **Draft — 2026-09-19**

This template must be completed and merged as part of a phase's first PR. The completed file lives at `docs/test-impact/<phase>.md` and links back to `docs/implementation-plan.md` Phase N and the linked ADRs.

A test impact assessment is **not** a test plan. It enumerates existing tests that must keep passing, identifies tests that will break and how they are rewritten, locks in the contract between legacy and target implementations during the migration window, and captures the coverage, parity, and performance budgets the phase commits to.

The template is filled out once per phase. Section updates after the initial submission are recorded in §11 (changelog) and require review.

## 1. Phase metadata

```yaml
phase: N
branch: <branch-name>
plan_section: docs/implementation-plan.md Phase N
linked_adrs: [ADR-XXXX, ADR-YYYY]
owner: <github-handle>
started: YYYY-MM-DD
target_phase_gate: YYYY-MM-DD
gate_enforcement: docs/gate-enforcement.md
```

## 2. Regression basket

The regression basket is the set of existing tests that **must continue to pass** through the entire phase, including after cutover. These tests are the safety net for the legacy → target migration.

| Test path | Purpose | Why critical |
|---|---|---|
| `path/to/test.ts:test_name` | What it verifies | What production invariant breaks if this fails |

Tests in this basket may not be deleted, skipped, `.only`'d, or weakened during the phase. Changing assertion strings requires an issue and an entry in §11.

## 3. Tests expected to break

| Test path | Why it breaks | Resolution | Replacement test |
|---|---|---|---|
| `path/to/test.ts:test_name` | Reason | Rewrite / Delete / Supersede | `path/to/new_test.ts:test_name` |

A "Delete" resolution requires a §4 entry.

## 4. Deletion justifications

Each test marked Delete in §3 needs its own row.

| Original test | Justification | Alternative coverage |
|---|---|---|
| `path/to/test.ts:test_name` | Why the test is obsolete (e.g. legacy path is removed; the invariant now lives elsewhere) | Which new test or which gate covers the same invariant |

A deletion without an alternative coverage row is rejected at review.

## 5. New test inventory

Tests added by this phase. Each row declares layer and contract-test status.

| Test path | Layer | Targets ADR | Memory mode | PG mode | Architecture gate |
|---|---|---|---|---|---|
| | unit / contract / integration / e2e | | yes/no | yes/no | yes/no |

A row is required for every new test file in the phase. Tests must pass in both memory and PG modes unless an architecture decision waives PG for that test (recorded in §10).

## 6. Coverage deltas

| Layer | Before phase | Target after phase | Floor | Actual at PR time |
|---|---|---|---|---|
| | | | (per `gate-enforcement.md` §3) | |

If actual drops below the floor on changed code, the PR is blocked until coverage is restored or a waiver (§5 of `gate-enforcement.md`) is filed.

## 7. Memory/Postgres contract parity strategy

How the phase proves that the memory and PG implementations behave identically.

- **Shared contract suite**: <paths and names>
- **Random-seed replay**: <whether/how; seed location>
- **Deterministic-clock strategy**: <fake clock fixture, location>
- **Cross-implementation runner**: <e.g. `pnpm test:contract-parity`>
- **PG-mode parity failure handling**: <what happens if memory passes and PG fails>

## 8. Test data lifecycle

- **New fixtures introduced**: <list with TTL and ownership>
- **Existing fixtures modified**: <list>
- **Test data reset strategy**: per-test / per-suite / per-phase
- **Cross-test isolation**: <how state is reset between tests>

## 9. Performance budget

| Operation | Memory mode SLO | PG mode SLO | Measurement |
|---|---|---|---|
| State transition with event commit | <N> ms | <N> ms | how measured |
| Observation snapshot | <N> ms | <N> ms | |
| Replay from cursor (k events) | <N> ms | <N> ms | |
| Approval decision end-to-end | <N> ms | <N> ms | |
| Admission waterfall | <N> ms | <N> ms | |
| OAuth callback to durable exchange | <N> ms | <N> ms | |
| IM intake dedup lookup | <N> ms | <N> ms | |

A regression beyond the SLO blocks the PR. The SLO is set in this section and ratified by the phase gate.

## 10. Open questions

Each open question must be resolved before the phase's Phase Gate is signed off.

| Question | Owner | Due |
|---|---|---|
| | | |

Resolved questions move to §11 with the resolution date.

## 11. Changelog

| Date | Change | Author |
|---|---|---|
| YYYY-MM-DD | Initial submission | |

## 12. Gate self-check

Before the Phase Gate is signed off, confirm:

- [ ] Regression basket is green in memory and PG modes
- [ ] All "expected to break" tests are resolved (rewritten, deleted-with-justification, or superseded)
- [ ] No deletions in §4 are missing an alternative coverage row
- [ ] Coverage on changed code is at or above the floor
- [ ] Memory/PG contract parity strategy is verified by automated tests
- [ ] Performance budgets are met or have an open waiver
- [ ] All open questions in §10 are resolved
- [ ] Architecture gate has run on the phase branch
- [ ] Linked ADRs are referenced in test names or descriptions where applicable
