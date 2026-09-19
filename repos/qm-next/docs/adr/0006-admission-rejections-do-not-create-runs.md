---
status: accepted
---

# Admission rejections do not create Runs

Work rejected at Admission never becomes a Run and therefore never produces Run Events. Rejections are persisted as an Admission Record containing the decision reason and relevant actor, source, security, and rate-limit context. Callers receive an admission rejection rather than a failed Run.

## Considered Options

- Create an immediately failed Run for every rejection: rejected because it obscures whether execution ever began and corrupts Run metrics.
- Return only an HTTP error: rejected because security and abuse investigations would lose the rejection evidence.
- Persist a separate Admission Record: accepted because it preserves the Run boundary while making rejected attempts auditable.
