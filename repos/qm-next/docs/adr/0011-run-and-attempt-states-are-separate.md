---
status: accepted
---

# Run and Attempt states are separate

A Run moves through `queued`, `running`, and `awaiting_approval` before reaching exactly one terminal state: `succeeded`, `failed`, or `cancelled`. An Attempt moves through `queued`, `running`, and `suspended` before reaching one of those terminal states. There is no `done` state: the stored outcome, Failure Reason, and terminal event determine what happened. This separation lets an executor stop while the business Run remains alive, such as when work is awaiting approval.

## Considered Options

- Keep `done`: rejected because it conflated success, refusal, silence, and pending approval.
- Reuse one state machine for Run and Attempt: rejected because an Attempt can stop while the Run remains awaiting approval.
- Let harnesses add private Run states: rejected because observers would need adapter-specific lifecycle semantics.
