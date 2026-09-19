---
status: accepted
---

# Project legacy Runs with new Run semantics

Historical Runs remain stored in their original form, but read projections use the accepted Run semantics. A legacy execution-complete marker maps through its Turn result: silent work becomes `succeeded`; refusal becomes `failed` with Command Refusal as the Failure Reason. A legacy pending-approval marker with no reliable Approval Continuation context is projected as `failed` with `approval_continuation_unavailable`; migration must inventory these records rather than rerun their inputs automatically. New writes never use the ambiguous legacy terminal mapping.

## Considered Options

- Return legacy `done` unchanged: rejected because it preserves a second public lifecycle language.
- Rewrite all historical rows immediately: rejected because it increases migration risk without improving the write model.
- Treat every legacy `done` as success: rejected because it hides refusals and pending work.
- Project legacy data at read time: accepted because callers see one lifecycle model while the risky data rewrite is deferred.
