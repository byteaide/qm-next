---
status: accepted
---

# IM subscribers have independent cursors

Each Intake Subscriber keeps its own durable Subscriber Cursor. A failing subscriber retries with backoff and eventually dead-letters while remaining observable; it does not roll back or block other subscribers. This preserves at-least-once delivery, audit completeness, and fault isolation across bridge, mirror, and audit paths.

## Considered Options

- Use one shared cursor: rejected because mirror or audit failures would pause turn bridging.
- Require every subscriber to succeed synchronously: rejected because external consumers could block safety-critical intake.
- Isolate retries and dead-letter per subscriber: accepted because subscribers have different availability and recovery characteristics.
