---
status: accepted
---

# Run owns terminal events and observation

Run execution is the sole owner of a Run's Terminal Event and its observable lifecycle history. The history is durable for the whole Run, while Attempt-scoped events carry their Attempt identity; an Attempt Failure may permit another Attempt but never ends the Run. A subscriber-facing event stream closes only after the Run Outcome transition is durable.

The Run Outcome mapping is closed: successful work and Silent Success become `succeeded`; Command Refusal, execution failure, and timeout become `failed`; explicit cancellation becomes `cancelled`. Queued and Pending Approval are never terminal, and Admission rejection does not create a Run.

Production execution must hold a valid claim for the life of an Attempt through renewal; an expired claim may cause the Attempt to lose ownership, but it must not leave the Run simultaneously owned by two executors.

Run observation uses a source-neutral Run Observation contract: consumers read an authorized snapshot and then replay or subscribe from an Event Cursor. The snapshot is projected from Run-owned durable state, not rebuilt independently by every client or kept in a second authoritative store. The initial durable set covers Run creation, Attempt boundaries including suspension and continuation, Command Gate decisions, approval requests, decisions, and expiry, cancellation, failure, success, and optional redacted assistant/progress events. Approval events include `attempt.suspended`, `attempt.resumed`, `approval.requested`, `approval.decided`, and `approval.expired`; a decided event carries whether the decision was approved or rejected and references its Approval Continuation. The Run Event history is typed and immutable, with one monotonic sequence per Run and an Attempt identity on non-terminal execution events. Consumers deduplicate by Run identity and sequence. Run Visibility is inherited from the Run's Session authorization; possession of a Run ID is not authorization. Event history remains readable through the configured operational and audit retention window after the Run becomes terminal. Secret values are redacted at the observation boundary.

## Considered Options

- Let Orchestrator own terminal state while Runs stores snapshots: rejected because it preserves two owners.
- Let callers notify an API that records terminal outcomes: rejected because it spreads lifecycle ownership across entry points.
- Close the event stream after each Attempt: rejected because retry would strand later observers.
- Rely on best-effort notifications and status polling: rejected because callers cannot distinguish missed notifications from unfinished Runs.

## Consequences

Terminal transitions are irrevocable once accepted by Run. Consumers must tolerate at-least-once delivery and deduplicate idempotently. During migration, a legacy observation path may run behind an explicit rollout control, but the durable Run-owned history remains the only authoritative source; the legacy path is removed at cutover rather than preserved as a second system of record.
