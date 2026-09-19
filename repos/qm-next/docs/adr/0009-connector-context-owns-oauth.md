---
status: accepted
---

# Connector context owns OAuth lifecycle

The Connector context owns OAuth flow state, consent links, provider exchange, and token persistence. HTTP is an adapter that receives callbacks and invokes Connector operations; it does not own process-local pending links or provider lifecycle. Existing durable OAuth and consent stores are the intended boundary for restart-safe and multi-instance-safe flows.

## Considered Options

- Keep pending OAuth links in API route memory: rejected because restart or another instance cannot complete the callback.
- Replace the route map with an API-owned table: rejected because it leaves OAuth ownership in HTTP translation.
- Move the lifecycle into Connector stores behind an HTTP adapter: accepted because the boundary already exists and matches the external-account domain.
