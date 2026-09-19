---
status: accepted
---

# Approval suspends the same Run

When Command Gate returns approval required, the current Attempt becomes Suspended and the Run becomes Pending Approval; it does not become `done` and does not spawn a successor Run. The executor lease is released, while a durable Approval Continuation preserves the original Run, Attempt, Command Request, pending tool call, agent context reference, and approval request identity. An approved decision creates a Continuation Attempt in the same Run.

The `approvals` context owns the request-and-decision state machine. The Run context owns Pending Approval and Attempt state. Command Gate creates the request; Web and IM may submit decisions but do not invent follow-up Runs. A rejection or expiry fails the same Run with `approval_denied` or `approval_expired`. A Session Continuation Reservation preserves session coherence after the executor lease is released. A new Run for the same Session queues behind the reservation; only the requester’s explicit cancellation or replacement releases it early. Only the original requester may approve or reject a request in the first lifecycle; delegation and administrator approval require a separate explicit authorization model. An undecided request expires by default after twenty-four hours through a durable sweep; deployments may configure a different TTL on the Approval Request. Decision transitions and continuation triggers are durable and idempotent, so duplicate clicks cannot create duplicate Attempts.

## Considered Options

- Mark the Run done and create a successor Run: rejected because Pending Approval is not terminal and the continuation loses its original lifecycle.
- Hold the executor and session lease while waiting: rejected because approvals may last far longer than a safe execution claim.
- Rerun the original TurnInput: rejected because it can repeat side effects and does not resume the suspended command point.
- Let each surface own resume behavior: rejected because Web and IM already diverged and approval could disappear between surfaces.
