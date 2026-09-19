---
status: accepted
---

# Run state and events commit together

Run state transitions and their Run Events are written in one durable transaction. Every event has a unique `(run_id, seq)` identity, and subscriber notification begins only after that transaction commits. A failed transaction leaves neither a state change nor an event; a committed terminal transition cannot be announced before its state is durable.

## Considered Options

- Publish first and persist afterward: rejected because observers could receive terminal outcomes for transitions that never commit.
- Generate events from post-commit store callbacks: rejected because callbacks can duplicate, omit, or reorder the authoritative history.
- Commit state and events together: accepted because the event log and Run state share one source of truth without distributed compensation.
