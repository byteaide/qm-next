---
status: accepted
---

# Security Screen enters Admission in Shadow Mode

Security Screen is a named stage of Turn Admission, not a route-only diagnostic. It supports off, shadow, and enforce modes. The screener implementation is reached through a Security-owned port; Admission owns the stage order but not the screening algorithm. The screen reviews the submitted Turn input and referenced resources, not predictions about commands a model may later generate. The first production slice uses Shadow Mode: decisions are recorded for review but do not block the Turn. A Shadow Record contains structured decision metadata—stage, decision, reason, rule identity, redacted excerpt, and references to the actor, Session, and Run—rather than secrets or an unredacted full payload. An unavailable screener is recorded and bypassed in Shadow Mode, but in Enforce Mode it rejects the Turn and produces an Admission Record. Enforcement becomes active only through an explicit cutover after the shadow population meets predeclared sample-size, false-positive, review, latency, and availability targets.

## Considered Options

- Keep screening on a separate HTTP diagnostics route: rejected because the production Turn path would not pass through it.
- Enforce immediately on every Turn: rejected because untested screening decisions could create an unreviewed availability and correctness risk.
- Shadow first, then cut over explicitly: accepted because it establishes the production boundary while making enforcement a deliberate safety transition.
