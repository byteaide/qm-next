---
status: accepted
---

# The soul layer is composed protocol frames owned by the orchestrator

The system prompt is a fixed-order composition, not a single stored string.
The orchestrator composes it each turn from named segments in a stable order:
a mode frame selected by turn origin (autonomous for ambient and automated
turns with a destination, conversation for interactive DM/web turns, fallback
otherwise), the scope's effective soul (org policy authoritative, lower-scope
instructions guarded as non-overriding), a shared behavioral core, the
rendered security policy, and live facts (computer profile, time, memory
recall, onboarding). A byte boundary recorded after the stable segments feeds
the harness prompt-cache boundary. Rendering is fail-loud: an unresolved
template token aborts the compose instead of reaching the model. Platform
vocabulary never enters core protocol text — channel-specific wording arrives
as injected variables sourced from the IM provider, keeping the check:im gate
meaningful.

## Considered Options

- Keep the one-line configured prompt: rejected because agent behavior
  contracts (silence-by-default, delivery verbs, memory-as-index, credential
  allowlist) would live nowhere; the model improvises them per turn.
- Compose frames inside the resolution decorator chain: rejected because mode
  selection needs turn-origin context (origin kind, surface, destination)
  that resolution must not own, and decorator order would silently govern
  prompt segment order.
- A dedicated soul package: rejected for now — the composer needs admission
  outcomes and harness-facing types; a package split would freeze a seam
  before the segment set stabilizes. Revisit once segments exceed the
  orchestrator package boundary.
- Render memory/skills blocks inside the composer: rejected — the existing
  resolution decorators already own those blocks and their stores; the
  composer only fixes their position relative to the cache boundary.
