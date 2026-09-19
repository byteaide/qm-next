---
status: accepted
---

# Runtime contracts decouple Trigger and API

Behavior shared between Trigger and API is declared in a stable Runtime Contract layer. Each side contributes or consumes through Cordis without importing the other package's implementation. This removes the Trigger ↔ API cycle, makes dependency direction explicit, and keeps late property writes out of the integration seam.

## Considered Options

- Let Trigger import an interface-only entry from API: rejected because the dependency still points through the API implementation package.
- Let Trigger define the callback contract and make API adapt to it: rejected because runtime ownership would remain ambiguous.
- Put the contract in a stable independent layer: accepted because neither collaborator owns the other's boundary. The shared declarations initially live in `packages/types`; extraction into a dedicated package is deferred until runtime behavior or dependencies force the split. The first concrete boundary is a minimal `TriggerRuntime`: Triggers depend only on the operations they need, such as submit, health, and identity, while API supplies the implementation during composition. Cron schedule storage and lease machinery remain behind that boundary; API internals are not exposed. API does not receive a Trigger-owned runtime by late property assignment.
