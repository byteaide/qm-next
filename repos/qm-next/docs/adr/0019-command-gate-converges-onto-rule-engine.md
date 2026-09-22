---
status: accepted
---

# The CommandGate converges onto the sandbox rule engine

There is one rule engine, not two. Shell-shaped command requests are
evaluated by the same implementation everywhere: `args.argv` (joined) or
`rawText` feeds `scannableCommand` normalization and the safe-regex
first-match evaluator from `@qm/sandbox`, and the `CommandGate` port runs
it through a registered `CommandPolicy` (`rule-engine`) instead of a
parallel matcher. Category policies (baseline-deny, allowlist) keep
owning structured operations — publish, webhook, MCP, cron, memory
mutations — where qm's own reference deployment gates by mechanism rather
than by text. Per-scope rule sets resolve through the same
`CommandPolicyStore` the admin CRUD and simulate surfaces use, so an
operator sees, simulates, and enforces one policy.

## Considered Options

- Keep the class-based CommandGate policies as a second text matcher:
  rejected — two engines drift; the sandbox engine carries scannableCommand
  shell semantics (heredoc, quoting, wrapper, pipeline, SQL payload
  extraction) that a class-shaped matcher cannot reproduce, and simulate
  fidelity would silently diverge from enforcement.
- Collapse the CommandGate port into the sandbox package: rejected — the
  port is the ADR-0002 production invariant (structured requests, request
  ids that survive approval round-trips, no exit-code collapse); the
  sandbox engine is a text evaluator and must stay embeddable without the
  run/attempt vocabulary.
- Route structured operations through the rule engine too: rejected —
  there is no command text to scan; category policies remain the correct
  gate shape, and forcing text through them would reintroduce the dual
  representation this decision removes.
