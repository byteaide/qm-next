---
status: accepted
---

# Connector tokens stay out of observation

Connector OAuth Tokens are encrypted at rest and readable only through the Connector context for a short-lived provider call. They must not enter logs, Run Events, Observation payloads, Admission Records, or admin diagnostics. Diagnostics may describe token presence, provider, expiry, and redacted identifiers, but never reveal the token value.

## Considered Options

- Rely on database permissions for plaintext tokens: rejected because observation and support paths expose too many indirect channels.
- Allow token values in privileged diagnostics: rejected because a support path becomes a credential-export path.
- Encrypt within the Connector boundary: accepted because the context that needs the credential can mediate every use and redaction boundary.
