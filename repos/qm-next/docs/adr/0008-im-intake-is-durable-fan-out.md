---
status: accepted
---

# IM intake is durable fan-out

IM intake uses a durable Inbox keyed by an Intake Key for each external delivery. Accepted intake is dispatched to explicit Intake Subscribers such as bridge, mirror, and audit. Delivery is at-least-once; subscribers and Turn creation deduplicate idempotently. A failed subscriber does not erase the intake or silently lose mirror and audit processing.

## Considered Options

- Keep one synchronous bridge callback: rejected because it contradicts the documented fan-out and cannot recover failed processing.
- Persist only a deduplication map while continuing inline fan-out: rejected because subscriber failure and audit delivery remain unowned.
- Let each provider adapter invent its own intake semantics: rejected because duplicates and delivery guarantees would differ by surface.
