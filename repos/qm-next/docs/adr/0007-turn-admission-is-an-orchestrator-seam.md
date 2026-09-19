---
status: accepted
---

# Turn Admission is an orchestrator seam with a fixed waterfall

Turn Admission is a named seam inside the Orchestrator rather than an HTTP-only concern or a dependency bag. It consumes narrow ports for identity, rate limiting, budget, security screening, resolution, and session leasing. The production order is fixed: identity and authorization, rate limit, budget, Security Screen, resolution and session lease, then dispatch. This avoids paying expensive screening work for callers who have already failed cheaper prerequisites and keeps resource ownership out of route handlers.

## Considered Options

- Screen before identity and rate limiting: rejected because unauthenticated or abusive traffic would consume the most expensive stage.
- Charge budget only after screening: rejected because it lets rejected work consume screening capacity without an admission guard.
- Let deployments reorder every stage: rejected because authorization, accounting, and safety semantics would become composition-specific.
- Put admission in HTTP routes: rejected because non-HTTP Turn paths would bypass the same policy.
