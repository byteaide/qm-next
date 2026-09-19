# Architecture Implementation Plan

Status: **Draft — 2026-09-19**  
Scope: implementation of the target model recorded in `docs/adr/0001`–`docs/adr/0016` and summarized by `docs/architecture.md`.

This plan deliberately separates behavior changes into phases. A phase is complete only when its phase gate passes in both memory and Postgres modes. Do not begin the next phase while a required gate is red.

## 0. Ground rules

### Execution rules

1. Each phase uses a conventional-commit branch:
   - `chore/architecture-gates`
   - `feat/run-lifecycle`
   - `feat/command-gate`
   - `feat/turn-admission`
   - `refactor/trigger-runtime`
   - `feat/im-intake`
   - `feat/connector-oauth`
   - `chore/architecture-cutover`
2. Each PR keeps rollback possible. Long-lived dual writes are prohibited; temporary rollout flags are acceptable only when they have an explicit removal task.
3. New behavior must be represented by the target contracts in `@qm/types`. Do not extend the legacy `done` model.
4. A phase may ship behind a flag only if the old and new paths do not become competing sources of truth. Rollout flags must be declared through the `RolloutFlag` port introduced in Phase 0; reading a flag from anywhere else is an architecture violation.

### Gate enforcement and test impact

- Every gate in this plan is enforced as described in `docs/gate-enforcement.md`. That document is the source of truth for gate taxonomy, coverage thresholds, flaky-test handling, waiver process, and release blockers.
- Each phase opens with a Test Impact Assessment at `docs/test-impact/<phase>.md`. The template lives at `docs/test-impact/template.md`. The assessment must be merged before the phase's first PR is opened and is reviewed together with the Phase Gate.
- Closing a phase without a matching test impact assessment is rejected at review.
- Per-phase ADR references (Phase N → ADR-XXXX) are recorded in both the Phase section and in the matching test impact assessment.

### Global gates for every PR

Per `docs/gate-enforcement.md`, the gates below are **strict** (always on, always blocking) and **phase-conditional** (required by area or phase). All are mandatory to merge.

Required on every PR:

```bash
pnpm typecheck
pnpm test
pnpm test:architecture   # introduced in Phase 0; non-waivable per gate-enforcement.md §6
pnpm test:pg
pnpm check:im
pnpm rescope-check
```

Required before merging a phase:

```bash
pnpm test:all
pnpm test:sandbox-policy
```

Additional gates by touched area:

| Area | Additional gate |
|---|---|
| API / CLI | `pnpm test:cli` |
| User stories | `pnpm test:user-stories` |
| Wave 2 smoke | `pnpm test:smoke-wave2` |

The following are **release blockers** (per `docs/gate-enforcement.md` §7), tracked on the release checklist rather than on individual PRs:

- Real-sandbox cutover rehearsal evidence
- OAuth token redaction scan
- Memory/Postgres contract parity on the release commit
- Migration projections on a production-size data sample
- On-call alert wiring for the metric and alert families listed in `docs/gate-enforcement.md` §7

A release blocker is **never** conditional on "if infrastructure is available". If the underlying infrastructure is missing, the release is paused.

---

## Phase 0 — Target contracts and architecture gates

**Branch:** `chore/architecture-gates`

### Scope

1. Add target-only contracts to `packages/types` without switching runtime behavior:
   - `RunOutcome`
   - `FailureReason`
   - `RunState`
   - `AttemptState`
   - `RunSnapshot`
   - `EventCursor`
   - `RunEvent` envelope and typed event set
   - `RunObservation`
   - `CommandRequest`
   - `CommandDecision`
   - `AdmissionRecord`
   - `ApprovalContinuation`
   - minimal `TriggerRuntime`
   - concurrency primitive ports:
     - `LeaseStore` (acquire / renew / release by token)
     - `SequenceAllocator` (monotonic `(run_id, seq)`)
     - `SessionReservationStore` (Session Continuation Reservation)
   - `RolloutFlag` port (single registered location for rollout flags)
2. Add deterministic lifecycle test fixtures:
   - fake clock
   - in-memory durable event log
   - Postgres-compatible store contract suite covering `LeaseStore`, `SequenceAllocator`, `SessionReservationStore`, `RolloutFlag`
   - event subscriber harness
3. Add `pnpm test:architecture` as a static and contract-oriented gate.
4. Record current-versus-target checks without deleting legacy paths.
5. Submit `docs/test-impact/phase-0.md` filled from `docs/test-impact/template.md`.
6. Submit `docs/known-violations.md` seeded with at least: legacy `done` writes, late `api.cronsRuntime` writes, route-local OAuth pending Maps, IM platform symbols in `im-core`, command-policy collapsed into exit codes. Each entry maps to the phase that resolves it.
7. Establish ADR traceability: the contracts in this phase carry JSDoc references to the ADRs they implement (ADR-0001, ADR-0003, ADR-0010, ADR-0013).

### Boundary checks

The architecture gate should fail when:

- runtime code writes legacy `done` on a target Run path;
- an event bus closes a Run before durable terminal state;
- API implementation is imported by Triggers;
- Triggers late-write `api.cronsRuntime`;
- Security Screening is imported only from an HTTP route on a production Turn path;
- OAuth pending state is stored in a route-local Map;
- command policy results are collapsed into ordinary exit codes on target paths;
- the memory and PG implementations diverge on the contract suite (assertions are bit-identical given the same seed);
- `LeaseStore` is acquired without a token;
- `(run_id, seq)` is generated outside `SequenceAllocator`;
- a rollout flag is read from anywhere other than the registered `RolloutFlag` port;
- `SessionReservationStore` releases a reservation before the owning Run reaches durable terminal state.

### Phase gate

- [ ] `pnpm test:architecture` exists, runs in CI, and is non-waivable per `docs/gate-enforcement.md` §6.
- [ ] Target type contracts compile.
- [ ] Legacy code still passes existing tests.
- [ ] `docs/known-violations.md` exists with seeded entries mapped to later phases.
- [ ] `docs/test-impact/phase-0.md` is merged.
- [ ] Memory and PG implementations of `LeaseStore`, `SequenceAllocator`, `SessionReservationStore`, `RolloutFlag` pass the same contract suite.
- [ ] Concurrency primitive ports carry ADR references in their JSDoc.
- [ ] No runtime behavior changes.

**Linked ADRs:** 0001, 0003, 0010, 0013.

---

## Phase 1 — Run-owned lifecycle and observation

**Branch:** `feat/run-lifecycle`

### Goals

Make Run execution the single owner of state transitions, terminal outcomes, durable event history, and observation.

### Implementation slices

#### 1.1 Run state machine

- Implement target Run and Attempt state machines.
- Remove `done` from all new write paths.
- Enforce valid transitions:
  - Run: `queued → running → awaiting_approval? → succeeded / failed / cancelled`
  - Attempt: `queued → running → suspended? → succeeded / failed / cancelled`
- Attach `FailureReason` to every failed Run.

#### 1.2 Durable Run Event log

- Assign monotonic per-Run `seq`.
- Enforce uniqueness on `(run_id, seq)`.
- Make persisted events immutable.
- Put Run state transition and its events in one transaction.
- Notify subscribers only after commit.
- Keep Attempt identity on non-terminal execution events.
- Preserve the whole event history across Attempts; never close it on Attempt failure.

#### 1.3 Execution ownership and heartbeat

- Production Turn execution must claim, heartbeat/renew, complete, or fail through the Run-owned path.
- Expired claims may invalidate only the expired Attempt using the original lease token.
- Reaper must not force-release a newer Session lease acquired after the expired Run was observed.
- A retried Attempt remains part of the same Run and continues the same event log.

#### 1.4 Run Observation contract

- Implement `snapshot()` plus `replay(from)` / `subscribe(from)`.
- API and Web consume the same Run Observation contract.
- Authorization follows Session/Run Visibility; possession of a Run ID is not enough.
- Apply producer-schema allowlisting and observation-boundary secret filtering/scanning.
- SSE remains a Web transport adapter, not the source of truth.

#### 1.5 Legacy projection and rollout

- Keep legacy rows physically unchanged.
- Project legacy reads using the accepted semantics:
  - legacy successful result → `succeeded`
  - silent result → `succeeded`
  - refused result → `failed` with `command_refused`
  - failed result → `failed` with the available failure reason
  - pending approval without continuation context → `failed` with `approval_continuation_unavailable`
- Add an explicit rollout flag for the new observation path, declared through the `RolloutFlag` port.
- Remove the old observation path at cutover; do not retain dual sources of truth.

#### 1.6 Observability baseline

Observability must be in place **before** this phase merges so that subsequent phases have operational signal. This is the metric and alert baseline; later phases extend the same metric families rather than introducing parallel ones.

**Metrics (counters unless noted):**

- `run_event_commit_total{outcome=terminal|non_terminal}` — terminal vs non-terminal commit count.
- `run_event_transaction_failures_total` — explicit failure counter.
- `run_seq_conflict_total` — duplicate `(run_id, seq)` rejections.
- `run_attempt_retry_total` — Attempt requeue count.
- `run_lease_renew_total`, `run_lease_reap_total` — ownership traffic.
- `run_lease_ownership_conflict_total` — reaper rejects of newer-session leases.
- `redaction_hit_total{boundary}` — secret-shaped strings caught at log/observation boundaries.

**Alerts (must page on-call):**

- `run_event_transaction_failures_total` rate above threshold.
- `run_seq_conflict_total` non-zero over a 15-minute window.
- `run_lease_ownership_conflict_total` non-zero.
- `redaction_hit_total` non-zero (this indicates a producer is leaking secrets).

**Logs:** structured; never include secrets (see §1.4). Each metric and alert has a runbook entry in `docs/operations.md` before Phase 1 merges.

### Phase gate

Required tests:

1. **State transition tests**
   - Invalid transitions are rejected.
   - Every terminal Run has exactly one Run Outcome.
   - Every failed Run has a Failure Reason.
   - `done` is rejected on target write paths.

2. **Transaction tests**
   - State and events commit together.
   - A failed transaction leaves neither state change nor event.
   - Duplicate `(run_id, seq)` is rejected.
   - Subscriber notification does not occur before commit.
   - A terminal event cannot be observed before terminal state is durable.

3. **Retry and Attempt tests**
   - Attempt failure can requeue while preserving the same Run.
   - Attempt events carry Attempt identity.
   - The event log remains usable after a failed Attempt.
   - A second Attempt cannot create a new Run identity.

4. **Lease tests**
   - A Run renewed before lease expiry is never reaped.
   - An expired lease loses ownership using token comparison.
   - Reaper cannot release a newer Session lease.
   - Shutdown releases only the executor-owned lease.

5. **Observation tests**
   - Snapshot and replay agree.
   - Reconnect from cursor yields no duplicate terminal event.
   - Unauthorized callers cannot enumerate or subscribe by Run ID.
   - Secret-bearing producer input is redacted before leaving the observation boundary.
   - Memory and Postgres implementations pass the same contract suite.

6. **Migration tests**
   - Legacy success, silent, refusal, failure, and pending-approval rows map as specified.
   - Existing physical rows are not rewritten by read projection.
   - New writes never use `done`.

7. **Rollout tests**
   - Flag off uses the legacy path.
   - Flag on uses target observation.
   - Flag removal task exists before merge to the next phase.

**Additional commands:**

```bash
pnpm test:architecture
pnpm test:pg
pnpm test:user-stories
```

**Linked ADRs:** 0001, 0005, 0011, 0013, 0014.

---

## Phase 2 — Command Gate and Approval Continuation

**Branch:** `feat/command-gate`

### Goals

Turn policy decisions into a production invariant and make Pending Approval a nonterminal, resumable Run state.

### Implementation slices

#### 2.1 Structured Command Gate

- Introduce `CommandRequest` with:
  - tool or operation type
  - structured arguments or argv
  - execution context
  - target resource
  - raw text where one exists
- Introduce exactly one structured decision:
  - `allow`
  - `deny`
  - `require_approval`
- Gate all Side-Effecting Operations:
  - shell execution
  - file mutation
  - publish/share
  - background job mutation
  - cron/webhook mutation
  - MCP mutation
  - memory mutation
- Gate Sensitive Reads even though they are non-mutating.
- Do not gate pure, non-sensitive reads.

#### 2.2 Production policy configuration

- Production must explicitly select a policy at startup.
- Missing production policy causes startup failure.
- Expose the existing `default-denylist` as a selectable minimum Baseline Policy.
- Allow operator policies to tighten the baseline, including allowlist mode.
- Do not silently fall back to any policy when configuration is absent.

#### 2.3 Approval model

- Approval required creates:
  - an Approval Request
  - an Approval Continuation
  - `attempt.suspended`
  - Run state `awaiting_approval`
- Preserve:
  - original Run ID
  - original Attempt ID
  - Command Request identity
  - pending tool-call identity
  - agent/session context reference
  - approval request ID
- Release executor and Run leases while the Run remains Awaiting Approval.
- Acquire a Session Continuation Reservation so another Run cannot silently mutate the same Session.

#### 2.4 Approval decision and resume

- `approvals` owns the request/decision state machine.
- `runs` owns Run and Attempt state.
- Command Gate creates the request.
- Web and IM submit decisions only; they must not create successor Runs.
- Only the original requester may approve or reject.
- Duplicate decisions are idempotent.
- Approval creates a Continuation Attempt in the same Run.
- Rejection fails the same Run with `approval_denied`.
- Expiry fails the same Run with `approval_expired`.
- Default TTL is 24 hours and must be stored on the Approval Request.
- A durable sweep expires undecided requests.

#### 2.5 Approval TTL lifecycle

The default TTL is 24 hours. The TTL lifecycle must be explicit so that historical replay and audit remain correct:

- TTL is stored on the Approval Request at creation time and never mutated except by:
  - a successful decision (terminal path; the decision time is recorded on the Run Event);
  - a renewal by the original requester (records `approval.renewed`; renewal does **not** extend past the absolute expiry, which is `created_at + max_ttl`).
- A renewal attempt after absolute expiry returns a structured `approval_expired` response and does not create an `approval.renewed` event.
- The durable sweep is the only authority for expiry events. Lazy expiry during a decision attempt is forbidden — the sweep must run, the event must persist, then a subsequent decision sees `approval_expired`.
- `max_ttl` is configurable per deployment but is recorded on the Approval Request so historical replay remains correct.

#### 2.6 Session Continuation Reservation release order

The Reservation prevents another Run from silently mutating the same Session while one is awaiting approval. The release order must be unambiguous:

1. Decision (approval / rejection / expiry) is processed and the Run state transition is **durable**.
2. Terminal Run Event (`approval.decided` or `approval.expired`) is persisted.
3. The Session Continuation Reservation is released **only after** step 2.
4. Only after step 3 does any new same-Session Run leave `queued`.

Releasing the Reservation before step 2 would leave a window where another Run observes an empty reservation but the Awaiting Approval Run is not yet terminal. This is a Phase 2 boundary check.

#### 2.7 Observability

Reuse the metrics from §1.6. Add:

- `approval_request_total{outcome=requested|approved|rejected|expired}`.
- `approval_renewal_total{outcome=accepted|rejected}`.
- `approval_ttl_sweep_total{outcome=expired|no_op}`.
- `session_reservation_release_order_violation_total` — must always be zero; non-zero is an incident.
- `command_gate_decision_total{decision=allow|deny|require_approval}`.

**Alerts (must page on-call):**

- `command_gate_decision_total{decision="deny"}` rate spike over a 15-minute window.
- `approval_ttl_sweep_total{outcome="no_op"}` sustained over more than 2× the sweep interval (suggests the sweep is dead).
- Any non-zero `session_reservation_release_order_violation_total`.

### Phase gate

Required tests:

1. **Policy tests**
   - Missing production policy fails startup.
   - Explicit baseline policy starts successfully.
   - `deny`, `allow`, and `require_approval` remain distinguishable.
   - Policy denial is not represented as an ordinary exit code.
   - Side-effecting tools cannot bypass the Gate.
   - Sensitive reads can require the Gate.
   - Pure non-sensitive reads do not require the Gate.

2. **Approval lifecycle tests**
   - Approval required suspends the Attempt.
   - Run becomes `awaiting_approval`, not terminal.
   - Original Run identity remains stable.
   - Executor lease is released.
   - Session Continuation Reservation prevents conflicting same-Session execution.
   - New same-Session Run queues while reservation is held.

3. **Resume correctness tests**
   - Approval resumes the saved command point, not a blind replay of the original input.
   - The approved command executes exactly once.
   - Agent context is available to the Continuation Attempt.
   - No successor Run is created.
   - Restart between approval and resume still resumes exactly once.

4. **Rejection and expiry tests**
   - Rejection fails the same Run with `approval_denied`.
   - Expiry fails the same Run with `approval_expired`.
   - Neither path executes the pending command.
   - Both produce terminal Run Events after durable state transition.

5. **Authorization and idempotency tests**
   - Non-requester decision is forbidden.
   - Duplicate requester decision returns the original outcome.
   - Repeated delivery cannot create a second Continuation Attempt.
   - TTL sweep runs exactly once per expired request.

6. **Observation tests**
   - `approval.requested`, `approval.decided`, `approval.expired`, `attempt.suspended`, and `attempt.resumed` are observable.
   - Suspension and resume explain why the Run was not terminal.
   - No command secret or token enters events.

**Additional commands:**

```bash
pnpm test:architecture
pnpm test:sandbox-policy
pnpm test:user-stories
pnpm test:pg
```

**Linked ADRs:** 0002, 0010, 0012.

---

## Phase 3 — Turn Admission and Security Screen

**Branch:** `feat/turn-admission`

### Goals

Make Admission a named orchestrator seam and Security Screen a real production stage.

### Implementation slices

#### 3.1 Admission seam

- Implement Turn Admission inside `orchestrator`.
- Consume narrow ports rather than an unbounded dependency bag.
- Keep the fixed waterfall:
  1. identity and authorization
  2. rate limit
  3. budget
  4. Security Screen
  5. resolution and Session lease
  6. dispatch
- Rejected work creates an Admission Record, never a Run.
- Admission Record includes decision reason, actor, source, security result, and rate-limit/budget context without secrets.

#### 3.2 Security Screen port

- Keep screening implementation behind a Security-owned port.
- Orchestrator owns stage order, not screening algorithms.
- Support modes:
  - `off`
  - `shadow`
  - `enforce`
- First production slice uses Shadow Mode.
- Shadow Record stores:
  - stage
  - decision
  - reason
  - rule identity
  - redacted excerpt
  - actor/session/run references where applicable
- Shadow Mode screen failure records `screen_unavailable` and allows the Turn.
- Enforce Mode screen failure rejects the Turn and creates an Admission Record.
- Enforce Mode requires explicit operator cutover.
- Cutover requires predeclared sample size, false-positive review, latency, availability, and security-review criteria.

#### 3.3 Observability

Add:

- `admission_decision_total{stage,decision}` for each waterfall stage (`identity`, `rate_limit`, `budget`, `screen`, `session`, `dispatch`).
- `admission_record_total{outcome=accepted|rejected}`.
- `security_screen_decision_total{mode,decision=allow|deny|unavailable}`.
- `security_screen_unavailable_total{mode}` — Shadow mode records unavailability; Enforce mode does not (fail-closed behavior is recorded as a rejection).

**Alerts (must page on-call):**

- Any Enforce-mode rejection on a production Turn.
- `security_screen_unavailable_total{mode="enforce"}` — must always be zero; non-zero indicates the screener failed in production and the Turn was rejected, which is correct behavior but indicates a screener outage.
- Rate of `admission_decision_total{stage="identity",decision="deny"}` exceeding baseline by 3×.

### Phase gate

Required tests:

1. **Waterfall order tests**
   - Identity failure prevents rate limiting, budget, screening, and dispatch.
   - Rate-limit failure prevents budget, screening, and dispatch.
   - Budget failure prevents screening and dispatch.
   - Screen failure in Enforce Mode prevents session resolution and dispatch.

2. **Admission Record tests**
   - Rejected work has no Run ID.
   - Rejected work has an Admission Record.
   - Admission rejection does not create Run Events.
   - Sensitive payloads are redacted.

3. **Shadow Mode tests**
   - Allowed, denied, failed, and unavailable decisions are recorded.
   - No Shadow decision blocks the Turn.
   - Shadow Records are separately retained from Run Events.

4. **Enforce Mode tests**
   - Denial blocks dispatch.
   - Screener failure fails closed.
   - Explicit cutover is required.
   - Automatic time-based escalation is absent.

5. **Configuration tests**
   - Missing mode has a deterministic default.
   - Invalid mode fails startup.
   - Enforce Mode without completion criteria is an operator/process decision, not automatic code behavior.

**Additional commands:**

```bash
pnpm test:architecture
pnpm test:user-stories
pnpm test:pg
```

**Linked ADRs:** 0004, 0006, 0007.

---

## Phase 4 — Trigger Runtime decoupling

**Branch:** `refactor/trigger-runtime`

### Goals

Remove the Trigger ↔ API package cycle and eliminate late runtime writes.

### Implementation slices

1. Define minimal `TriggerRuntime` in `packages/types`.
2. Expose only Trigger-required operations:
   - submit
   - health
   - identity
3. API supplies the implementation during composition.
4. Trigger consumes the contract/symbol, not `ApiService`.
5. Remove `api.cronsRuntime` late writes.
6. Keep cron schedule storage and lease machinery behind the Trigger boundary.
7. Preserve cron fire idempotency per scheduled slot.

### Phase gate

Required tests:

1. **Boundary tests**
   - `packages/triggers` does not depend on `@qm/api`.
   - `packages/api` does not import Trigger implementation for runtime dispatch.
   - No runtime code assigns `api.cronsRuntime`.
   - Architecture gate rejects the former dependency cycle.

2. **Runtime behavior tests**
   - Trigger can submit a Turn through the minimal contract.
   - Health and identity checks work.
   - Cron slot fires once per slot under duplicate delivery.
   - Lease recovery does not duplicate completed work.
    - Run Observation subscribers in Triggers see the same Run identity as API-originated Runs (the Run is the only identity that crosses the boundary; Triggers do not import `ApiService`).

3. **Failure tests**
   - Runtime submission failure produces a structured Trigger error.
   - API unavailable during fire does not silently consume the slot.
   - Retry does not double-execute successful work.

**Additional commands:**

```bash
pnpm test:architecture
pnpm test:cli
pnpm test:pg
```

**Linked ADRs:** 0003.

---

## Phase 5 — Durable IM intake and fan-out

**Branch:** `feat/im-intake`

### Goals

Make documented IM fan-out real, durable, restart-safe, and independently recoverable.

### Implementation slices

1. Add durable Intake Inbox in `im-core`.
2. Key Intake Records by provider plus provider delivery identity.
3. Deduplicate before Turn creation.
4. Implement explicit subscribers:
   - bridge
   - mirror
   - audit
5. Give each subscriber an independent durable cursor.
6. Retry failed subscribers with backoff.
7. Dead-letter exhausted subscribers while keeping them observable. Dead-letter records carry an admin-only `redelivery_url` (operator tool, not exposed to end users) and a `last_error` field that must never contain secrets. Dead-letter operations (list / inspect / replay) are admin-only, audited, and never auto-replayed.
8. Preserve platform-agnostic core; provider details remain in `im-*` adapters.

#### 5.5 Observability

Add:

- `im_intake_dedup_total{result=new|duplicate}`.
- `im_subscriber_lag{subscriber}` (gauge, in events).
- `im_subscriber_retry_total{subscriber,outcome=ok|fail}`.
- `im_subscriber_dead_letter_total{subscriber}`.

**Alerts (must page on-call):**

- Any dead-letter event.
- Subscriber lag exceeding N× the expected cadence (N is configured per subscriber).
- Subscriber retry exhausted.

### Phase gate

Required tests:

1. **Deduplication tests**
   - Duplicate live delivery creates one Turn.
   - Duplicate delivery after restart creates one Turn.
   - Duplicate delivery after cache eviction/rollover creates one Turn.
   - Distinct provider events are not conflated.

2. **Fan-out tests**
   - Bridge, mirror, and audit each receive accepted intake.
   - Each subscriber has its own cursor.
   - One failing subscriber does not block others.
   - Retry eventually redelivers to the failed subscriber.
   - Exhausted subscriber enters dead-letter without losing the failed record.

3. **Turn lifecycle tests**
   - Bridge failure does not mark intake permanently consumed.
   - Accepted intake maps to the same Turn identity on retry.
   - Outbound delivery retains its own idempotency key.

4. **Isolation tests**
   - `pnpm check:im` passes.
   - IM core has no provider-specific symbols.
   - Restart recovers in-flight intake without duplicate outbound replies.

**Additional commands:**

```bash
pnpm check:im
pnpm test:architecture
pnpm test:pg
pnpm test:smoke-wave2
```

**Linked ADRs:** 0008, 0015.

---

## Phase 6 — Connector OAuth lifecycle

**Branch:** `feat/connector-oauth`

### Goals

Move OAuth ownership out of HTTP translation and make flows restart/multi-instance safe.

### Implementation slices

1. Move flow state, consent link, provider exchange, and token persistence into Connector context.
2. Reduce API routes to HTTP adapters:
   - validate callback
   - normalize provider payload
   - invoke Connector operation
   - return/redact result
3. Delete route-local provider registries and pending-link Maps from production runtime.
4. Wire existing durable OAuth and consent stores into the route lifecycle.
5. Encrypt OAuth tokens at rest.
6. Restrict token decryption to short-lived Connector provider calls.
7. Exclude token values from logs, Run Events, Observation, Admission Records, and admin diagnostics.
8. Phase 6 may not open its first PR until a **new ADR** has been merged covering OAuth token encryption at rest. The ADR (number assigned by the architecture owner at the time of authorship) must address:
   - KEK / DEK model and key separation.
   - Rotation cadence and rotation procedure (online + offline scenarios).
   - Behavior when the key is absent at startup: **fail-closed**, treated like the missing production policy case in §2.2.
   - Audit log of decryption events, payload-free.
   - Key escrow and disaster recovery procedure.
   The ADR's review must complete before Phase 6's first PR is opened. This plan does not pre-assign the ADR number; numbering is the architecture owner's call at the time the ADR is authored.
9. Provide a runbook entry for OAuth rotation and key-absence incidents in `docs/operations.md`.

#### 6.5 Observability

Add:

- `oauth_flow_total{step=start|callback|complete,outcome=ok|fail}`.
- `oauth_token_decrypt_total{provider,outcome=ok|error}`.
- `oauth_redaction_hit_total` — count of token-shaped strings caught at the observation/log boundary. Distinct from the generic `redaction_hit_total{boundary}` so that an OAuth-specific incident is unambiguous.

**Alerts (must page on-call):**

- Any non-zero `oauth_token_decrypt_total{outcome="error"}`.
- Any non-zero `oauth_redaction_hit_total`.

### Phase gate

Required tests:

1. **Flow lifecycle tests**
   - Start, callback, and completion succeed through the Connector-owned flow.
   - Restart between start and callback can complete the flow.
   - Callback routed to another simulated instance can complete the flow.
   - Duplicate callback does not create duplicate tokens or accounts.

2. **State tests**
   - Expired consent cannot be exchanged.
   - Used consent link cannot be replayed.
   - Failed exchange remains diagnosable without exposing secrets.
   - Retry-safe provider operations do not duplicate external grants.

3. **Token protection tests**
   - Tokens are encrypted at rest.
   - Token plaintext is absent from:
     - application logs
     - Run Events
     - Observation payloads
     - Admission Records
     - Approval Records
     - admin diagnostics
   - Diagnostics may show provider, presence, expiry, and redacted identifiers only.

4. **Boundary tests**
   - Route module does not own OAuth lifecycle state.
   - Provider adapter does not bypass durable stores.
   - Architecture gate rejects process-local pending OAuth maps.

**Additional commands:**

```bash
pnpm test:architecture
pnpm test:pg
pnpm test:user-stories
```

**Linked ADRs:** 0009, 0016. (A new ADR on OAuth token encryption at rest is required by §8 of this phase; its number is assigned when the ADR is authored.)

---

## Phase 7 — Legacy cutover and cleanup

**Branch:** `chore/architecture-cutover`

### Goals

Remove obsolete paths and make the target model the only production model.

### Cleanup checklist

- [ ] Remove legacy Run terminal `done` writes.
- [ ] Remove closing event streams on Attempt failure.
- [ ] Remove orchestrator-owned subscriber truth.
- [ ] Remove Web polling/replay compensation that duplicates Run Observation.
- [ ] Remove Web/IM successor-Run approval logic.
- [ ] Remove `api.cronsRuntime` compatibility fields.
- [ ] Remove API route-local OAuth pending state.
- [ ] Remove process-local IM dedup as the authoritative mechanism.
- [ ] Remove temporary rollout flags after their cutover gate passes.
- [ ] Update `docs/architecture.md` from “current vs target” to current target behavior.
- [ ] Mark superseded ADRs only if applicable.
- [ ] Verify `done` is **physically absent** on target paths: `rg "term:\s*['\"]done['\"]" packages/` returns zero hits in target runtime code (legacy compatibility shims under `legacy/` are excluded by their location; the grep is in `pnpm test:architecture`).
- [ ] Verify every rollout flag registered in Phase 0 has a removal PR linked or is removed.

### Phase gate

#### 1. Static gates

```bash
pnpm typecheck
pnpm test
pnpm test:architecture
pnpm check:im
pnpm rescope-check
pnpm test:pg
```

#### 2. Persistence gates

- Memory/Postgres contract parity suite green.
- Migration projections pass on the production-size data sample (release blocker; see §5).

#### 3. Integration gates

```bash
pnpm test:all
pnpm test:cli
pnpm test:user-stories
pnpm test:smoke-wave2
```

#### 4. Safety gates (per-PR)

```bash
pnpm test:sandbox-policy
```

Plus per-PR safety tests:

- OAuth token redaction scan (CI gate).
- Admission rejection audit test.
- Approval suspend / resume / reject / expiry tests.

#### 5. Release blockers

Per `docs/gate-enforcement.md` §7, the following must be evidenced on the release PR, **not** on individual cleanup PRs. None of these are conditional on infrastructure availability; if the underlying infrastructure is missing, the release is paused.

- [ ] **Real-sandbox cutover rehearsal evidence attached.** If real-sandbox infrastructure is unavailable, the release does not ship; the rehearsal is a hard prerequisite, not an option.
- [ ] **OAuth token redaction scan report attached.**
- [ ] **Memory/Postgres contract parity green on the release commit.**
- [ ] **Migration projections green on a production-size data sample.**
- [ ] **On-call alert wiring verified** for the metric and alert families accumulated across phases:
  - Run Event transaction failures, duplicate seq conflicts, expired lease ownership conflicts, redaction hits (Phase 1)
  - Command Gate decisions, approval outcomes, approval continuation failures, session reservation release-order violations (Phase 2)
  - Security Screen decisions and Enforce-mode rejections (Phase 3)
  - IM subscriber lag / dead letters (Phase 5)
  - OAuth redaction hits and decryption errors (Phase 6)

#### 6. Operational gates

- [ ] Rollout flags are removed.
- [ ] Metrics and alerts added in §1.6 / §2.7 / §3.3 / §5.5 / §6.5 are wired to the on-call rotation with dashboards and runbooks.
- [ ] `docs/architecture.md` updated to current target behavior (no "current vs target" framing).
- [ ] `docs/known-violations.md` is empty (all entries resolved).
- [ ] Every cleanup item has at least one test that fails without the cleanup and passes after — the regression-basket discipline from each phase's Test Impact Assessment remains intact.

**Linked ADRs:** all of 0001–0016 plus any ADRs introduced during execution (e.g. the OAuth token encryption at rest ADR required by Phase 6 §8).

---

## Recommended merge order

| Order | Phase | Why this order |
|---|---|---|
| 1 | Phase 0 | Establish target contracts and prevent new violations. |
| 2 | Phase 1 | Run truth is the foundation for every entry point. |
| 3 | Phase 2 | Approval and policy semantics depend on nonterminal Run state. |
| 4 | Phase 3 | Admission formalizes the boundary before more intake paths migrate. |
| 5 | Phase 4 | Trigger decoupling is well isolated after Run truth exists. |
| 6 | Phase 5 | IM fan-out consumes stable Turn/Run behavior. |
| 7 | Phase 6 | OAuth is safety-critical but mostly independent of lifecycle internals. |
| 8 | Phase 7 | Cleanup only after target gates are stable. |

## Definition of done

The architecture review is implementation-complete only when **all** of the following are true:

1. Run is the sole owner of terminal state and Run Event history.
2. `done` is **physically absent** on target production paths (verified by the Phase 7 grep gate, not just by rejection-on-write).
3. State and events are transactionally consistent; Session Continuation Reservation release order is enforced (see §2.6).
4. Observation is cursor-based, authorized, and redacted.
5. Approval suspends and resumes the same Run.
6. Production policy cannot run without an explicit Command Gate baseline; production cannot start without an OAuth encryption strategy declared in a merged ADR (the one required by Phase 6 §8).
7. Admission rejects are auditable without becoming Runs.
8. Trigger, IM, and Connector OAuth boundaries match their ADRs.
9. All required memory and Postgres gates pass.
10. Legacy compensation paths and temporary rollout flags are removed.
11. Every phase has a merged Test Impact Assessment at `docs/test-impact/<phase>.md`.
12. All release blockers in `docs/gate-enforcement.md` §7 are evidenced on the final release PR.
13. Observability from §1.6 / §2.7 / §3.3 / §5.5 / §6.5 is wired to the on-call rotation with dashboards and runbooks; alerts page for the families listed in Phase 7 §5.
14. `docs/known-violations.md` is empty.
15. `docs/architecture.md` describes current target behavior, not "current vs target".
