---
status: accepted
---

# Approvals are requester-scoped and expire

Only the original requester may approve or reject an Approval Request in the first lifecycle. Administrator approval and delegation require an explicit future authorization model rather than widening the default state machine. Requests carry a TTL, defaulting to twenty-four hours and configurable by deployment; a durable sweep expires undecided requests and fails the same Run with `approval_expired`. This prevents a privileged or stale decision from silently resuming another principal's work.

## Considered Options

- Let any Session participant decide: rejected because participation does not imply authority over the requester's command.
- Give administrators implicit approval power: rejected because emergency privilege should be explicit and auditable, not a side effect of role inheritance.
- Leave requests pending forever: rejected because unresolved safety gates would hold Session reservations indefinitely.
