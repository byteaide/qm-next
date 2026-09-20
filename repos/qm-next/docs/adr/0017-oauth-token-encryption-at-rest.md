---
status: accepted
---

# OAuth token encryption at rest

Connector OAuth Tokens are encrypted with the shared AES-256-GCM envelope (`encryptSecret`/`decryptSecret` in `@qm/connectors`) before they reach any durable store, and are decrypted only inside the Connector context for the duration of a single provider call. The key-encryption key is derived per purpose from the deployment's signing secret (`deriveConnectorKey(secret, 'connector-tokens')`), so browser-session or model-credential material cannot decrypt connector tokens and vice versa. Startup is fail-closed: when the connectors surface is enabled and no master secret is configured, boot fails the same way a missing production policy fails (plan §2.2). Every decryption is counted and audited without recording the token value or any payload. This ADR implements the ADR-0016 principle with the concrete key model the Phase 6 slices build on.

## Key model

- **KEK.** `deriveConnectorKey(config.secrets[0], 'connector-tokens')` — derived at construction, never persisted, never logged. Purpose derivation isolates connector tokens from every other consumer of the master secret (`browser-sessions`, model credentials).
- **Per-record protection.** Each token record is sealed by the GCM envelope with a fresh random IV; there is no reusable data-encryption key and therefore no DEK storage or wrapping problem. Confidentiality separation comes from the purpose-derived KEK; record separation comes from the per-record IV and GCM auth tag.
- **Storage shape.** Durable stores persist only envelope ciphertext plus non-secret metadata (provider, principal id, expiry, account type). Plaintext exists only in memory inside the short-lived Connector operation that performs the provider call.

## Rotation

- `config.secrets` follows its existing multi-entry semantics: the first entry encrypts, every entry verifies. Connector token keys inherit this: entry 1 is the current KEK, entries 2..n are previous KEKs still accepted for decryption.
- **Online rotation:** append the new secret so it becomes `secrets[0]`, restart, then run the re-encryption sweep (runbook §OAuth rotation) that re-seals every record under the new KEK. Records remain readable throughout.
- **Offline rotation:** rotate the secret in the deployment secret store first, then follow the online procedure on next boot.
- An old secret may be removed from `config.secrets` only after the sweep reports zero records still sealed under it.

## Fail-closed startup

When the connectors surface is enabled and `config.secrets` is missing or empty, construction of the connector token vault throws and boot aborts, mirroring the missing production policy behavior in plan §2.2. The error names the connectors surface and the missing key material so operators can distinguish it from other startup gates. There is no plaintext fallback mode.

## Decryption audit

- Every decrypt path increments `oauth_token_decrypt_total{provider,outcome=ok|error}` and emits a structured audit record carrying: principal id, provider, purpose, outcome, timestamp. It never carries the token value, ciphertext, or decrypted payload.
- Audit failures do not block the provider call (counters are best-effort), but decrypt errors themselves are a paging alert per plan §6.5.

## Key escrow and disaster recovery

- The master secret lives in the deployment secret store (gopass entry under `qm-next/<env>/`); its backup and restore follow the secret store's own procedure. The runbook documents the exact entry path and the verification step after restore.
- If all KEK entries are lost, sealed token rows are unrecoverable by design. Recovery is: mark every connector token `needs-reconnect` via the status probe, delete the sealed rows, and have users reconnect accounts. No plaintext recovery path exists and none will be added.

## Considered Options

- Plaintext tokens guarded by database ACLs: rejected — observation and support paths expose too many indirect channels (the ADR-0016 finding).
- Per-record DEK wrapped by an external KMS master key: rejected for this phase — the deployment has no KMS dependency; the purpose-derived KEK plus per-record GCM IV achieves the same separation without new infrastructure. Revisit if a KMS is introduced.
- Reuse the signing secret directly as the AES key without purpose derivation: rejected — one compromised consumer of the master secret would be able to decrypt every other consumer's secrets.
- Store tokens in a secret manager instead of the app database: rejected — the durable-run/Observation boundary needs token presence metadata in the same transactional store as the rest of the connector state; secret managers cannot participate in those transactions.
