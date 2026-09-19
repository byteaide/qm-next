---
status: accepted
---

# Observation redacts secrets in depth

Event producers may write only fields explicitly declared by the event schema. The observation boundary applies deny-by-default field filtering and secret scanning before delivery; when it detects sensitive content, it emits a Redaction Marker plus non-secret metadata rather than the value. Web rendering is not a redaction boundary, and privileged diagnostics do not receive raw secret payloads by default.

## Considered Options

- Hide secrets only in UI templates: rejected because API, IM, Trigger, and logs would still observe them.
- Trust producers alone: rejected because new tools and event kinds would eventually miss a field.
- Use schema filtering plus observation scanning: accepted because explicit producers remain usable while defense in depth catches leaks.
