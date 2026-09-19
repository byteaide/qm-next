# Gate Enforcement Policy

Status: **Draft — 2026-09-19**
Owner: Architecture
Applies to: every PR that touches `packages/*` or `apps/*` covered by `docs/implementation-plan.md`.

This document is authoritative for CI and merging. `docs/implementation-plan.md` enumerates **what** must pass; this document specifies **how** it must pass, **how exceptions are granted**, and **what blocks a release** even when every per-PR gate is green.

## 1. Authority and source of truth

- **Source of truth**: CI on the merge commit. Local results are advisory only.
- **Required status checks** in branch protection must include every strict gate listed in §2. Admins cannot dismiss a required check except through the waiver process (§5).
- **Documentation of a gate** (`package.json` script, `pnpm-workspace.yaml` task, `tools/ci/*.yml`) is itself source-controlled. Adding, renaming, weakening, or removing a gate requires an ADR and an updated entry in this file.

## 2. Gate taxonomy

| Class | Examples | Enforcement | Waiver |
|---|---|---|---|
| **Strict (CI-blocking, per PR)** | `pnpm typecheck`, `pnpm test`, `pnpm test:architecture`, `pnpm test:pg`, `pnpm test:all`, `pnpm check:im`, `pnpm rescope-check` | Always on, always blocking | Only via §5 |
| **Phase-conditional** | `pnpm test:cli`, `pnpm test:user-stories`, `pnpm test:smoke-wave2`, `pnpm test:sandbox-policy` | Required when the touched area or active phase triggers them, per `implementation-plan.md` "Additional gates by touched area" | Same as strict |
| **Release blocker** | Real-sandbox cutover rehearsal, OAuth token redaction scan, migration projection parity, on-call alert wiring | Block release to production; do not block individual PRs | Tracked as separate release issues; surfaced on the release checklist |
| **Informational** | Coverage delta, performance benchmark, mutation score | Reported on PR; does not block merge | n/a |

The implementation plan must not contain conditional language like "if infrastructure is available" for strict or phase-conditional gates. Anything safety-critical that is sometimes unavailable becomes a release blocker instead.

## 3. Coverage thresholds

Coverage is measured by `pnpm test:coverage` and recorded in `docs/testing/coverage-matrix.md`.

| Layer | Line floor | Branch floor |
|---|---|---|
| `packages/types` | n/a (type-only) | n/a |
| `packages/orchestrator` | 90% | 85% |
| `packages/runs` | 90% | 85% |
| `packages/approvals` | 90% | 85% |
| `packages/admission` | 90% | 85% |
| `packages/command-policy` | 90% | 85% |
| `packages/observation` | 90% | 85% |
| `packages/api` | 80% | 75% |
| `packages/triggers` | 80% | 75% |
| `packages/im-*` | 80% | 75% |
| `packages/connectors/*` | 80% | 75% |
| Other packages | 70% | 65% |

- Coverage is checked per PR on **changed code**. A drop on the overall floor blocks merge.
- Raising a floor is an ADR; lowering one is a strict waiver (§5) capped at 30 days.
- Test files themselves are excluded from the denominator.

## 4. Flaky test policy

- A test that fails twice in a row on the same commit without a code change is **flaky**.
- Within 24 hours of the second failure, the test must be either fixed or moved to `test:flaky` (excluded from the merge gate).
- The fix for the underlying flake must merge within 7 days of quarantine. After 7 days the gate is restored and the build is red until the flake is fixed.
- A test quarantined more than 30 days without a fix must be either fixed or removed; removal requires §5 and a replacement test or a TODO with an issue link.
- A flaky-test incident is recorded in `docs/testing/flaky-log.md`.

## 5. Waiver process

A waiver is a documented, time-bound exception to a strict gate.

**Location**: `.github/waivers/<gate-name>-<ticket>.md`

**Required fields**:

```yaml
gate: pnpm test:pg
command: pnpm test:pg
affected_paths: [packages/runs/**, packages/admission/**]
owner: <github-handle>
expiry: YYYY-MM-DD          # max 90 days from creation
rollback: <how the gate is restored>
tracking: <issue-or-pr-url>
reason: <one-paragraph justification>
```

**Review**: waivers are reviewed in the next architecture sync after submission. Architecture owners may reject, tighten, shorten, or revoke any waiver.

**Auto-expiry**: a waiver past its expiry is ignored; CI blocks the merge as if the gate were required.

**Limits**: at most 5 active waivers per gate. Exceeding the cap blocks new waivers until existing ones are closed.

## 6. Safety-critical, non-waivable gates

The following gates are **never** waivable. They may only be removed by deleting the test entirely, which itself requires an ADR and a documented replacement invariant.

- `pnpm test:architecture` (once implemented in Phase 0)
- Production-mode startup policy tests (Phase 2 — missing production policy fails startup)
- Enforce Mode security screen failure tests (Phase 3 — screen failure rejects Turn)
- OAuth token redaction tests (Phase 6 — token plaintext absent from logs/events/observation)
- Approval requester-only authorization tests (Phase 2 — non-requester decision is forbidden)
- Approval TTL sweep exactly-once tests (Phase 2)
- Run state + event transaction tests (Phase 1 — terminal event not observable before commit)

## 7. Release blockers (separate from per-PR gates)

A release blocker is a check that must pass before **promotion to production**, not before a PR merges. It is tracked in the release checklist and surfaced on the release PR.

| Release blocker | Phase that introduces it |
|---|---|
| Memory/Postgres contract parity suite green on the release commit | Phase 1 |
| Real-sandbox cutover rehearsal evidence attached to the release PR | Phase 7 |
| OAuth token redaction scan report attached | Phase 6 |
| Migration projections pass on a production-size data sample | Phase 1 |
| On-call alert wiring verified for: event transaction failures, duplicate seq, expired lease conflicts, approval continuation failures, dead-lettered IM subscribers, redaction hits | Phase 7 (and added incrementally per phase) |

A release blocker is **never** optional or "if available". If the underlying infrastructure is unavailable, the release is paused; it does not ship.

## 8. CI ownership and execution

- All strict and phase-conditional gates run on every PR and on the merge commit.
- `pnpm test:all` is the umbrella that aggregates the per-area suites (`test:cli`, `test:user-stories`, `test:smoke-wave2`, `test:sandbox-policy`, `test:architecture`, etc.). Per-area suites remain runnable individually.
- Local reruns are advisory. A green local run does not waive a CI failure on the merge commit.
- Pre-commit hooks may run a **subset** of fast gates for early feedback. The full suite still runs in CI.
- CI must report pass/fail within the documented budget (default 15 minutes for fast gates, 45 minutes for the full suite). Exceeding the budget is itself a defect to file.

## 9. Reporting

Each PR must include:

- Coverage delta on changed code (auto-posted by CI).
- Phase gate checklist status when the PR closes a phase.
- Reference to the test impact assessment (`docs/test-impact/<phase>.md`) when the phase introduces or removes tests.

A PR that closes a phase without the matching test impact assessment is rejected by review, not by CI.

## 10. Amendment procedure

Amending this document (changing taxonomy, raising coverage floors, redefining the waiver process) requires:

- An ADR that records the motivation and trade-offs.
- A PR that updates this file and `docs/implementation-plan.md` together.
- Architecture sync sign-off.
