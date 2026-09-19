---
status: accepted
---

# Command Gate enforces Command Policy before execution

Every Side-Effecting Operation passes a Command Gate immediately before execution as a structured Command Request, including the tool or operation, structured arguments, execution context, target, and raw text when one exists. Sensitive Reads may also require the gate even though they are non-mutating. Pure reads against non-sensitive resources do not. Policy rules declare which fields they evaluate; matching an unstructured string is a compatibility capability, not the definition of command safety. This gate is distinct from Turn Admission: Admission decides whether a Turn may enter the runtime, while Command Gate decides whether an individual command may execute. Production composition cannot leave the gate unconfigured or reduce a Command Decision to an ordinary exit code.

A production deployment must explicitly select its policy at startup; a missing production policy is a startup error, not a silent allow. The built-in `default-denylist` is the minimum Baseline Policy and may be tightened to an allowlist, but it is never substituted implicitly when configuration is absent. A Command Decision is exactly one of allowed, denied, or approval required. Denial fails the Run as a Command Refusal. Approval required places the command in Pending Approval; execution continues only after an explicit Approval, and it remains blocked if the request is denied or expires.

## Considered Options

- Keep policy checks on a diagnostic HTTP route: rejected because production Turn paths could bypass the rule.
- Provide a broad privileged override: rejected because silent policy bypass is indistinguishable from a policy violation.
- Flatten deny and approval-required outcomes into command failures: rejected because callers could not distinguish safety outcomes from execution failure.
- Route every exception through explicit Approval: accepted because it keeps enforcement universal while making exceptions auditable.
