# qm-next-c2-emoji-upload

## Origin

- **Created**: 2026-09-21
- **Parent task**: parity clearance (cluster 2, item: emoji-upload-service)
- **Blocked by**: none (IM-specific but unrelated to provider porting)
- **Conversation context**: `parity-lanes-routes.ts:248` returns "the emoji uploader isn't available in this deployment". The 199L `emoji-upload-service.ts` is documented as IM-specific but the routing/stub is what's broken.

## What

Make the existing emoji-upload route functional: accept a multipart upload, validate, store the emoji bytes via `DurableByteStore`, register the emoji with the IM provider's emoji registry (currently no IM provider registered → return clear "no provider wired" shape).

## Why

The 502/501 surfaces around emoji are user-visible (admin UI surfaces emoji upload). Clearing this is small but reduces parity-deviations count.

## Tier

`tier:standard` — IM-provider-aware code lives in `@qm/connectors`; the brief must not assume provider presence.

## Files to Modify

- `EDIT: packages/api/src/routes/parity-lanes-routes.ts:248` — replace 502 stub with real handler
- `NEW: packages/connectors/src/emoji-upload-service.ts` — port qm's 199L service (provider-neutral)
- `EDIT: packages/connectors/src/index.ts` — export `EmojiUploadService`

## Implementation Steps

1. Read `packages/api/src/routes/parity-lanes-routes.ts:240-260` to see the current stub.
2. Read qm's `src/connectors/emoji-upload-service.ts` (199L) for shape and contract.
3. Port to `packages/connectors/src/emoji-upload-service.ts`:
   - validate (filename, content-type, size)
   - store bytes via injected `DurableByteStore` (key by sha256)
   - emit audit event (`emoji.uploaded`)
   - call provider's `registerEmoji` if a provider is wired; otherwise return `{ ok: true, pendingProviderRegistration: true }`
4. Wire `EmojiUploadService` into api service composition.
5. Replace the 502 stub in `parity-lanes-routes.ts` with the real handler.

## Hazards

- **No provider**: must not crash when no IM provider is wired. Return a clear shape, not 500.
- **Size cap**: enforce (e.g., 256 KB) to prevent DoS.
- **Audit sinks**: durable-by-default already enabled (P5 20.0); ensure new event lands in audit table.

## Verification Before Dispatch

```bash
pnpm --filter @qm/connectors test
pnpm --filter @qm/connectors typecheck
pnpm test
```

## Acceptance Criteria

- [ ] `EmojiUploadService` exported from `@qm/connectors`

  ```yaml
  verify:
    method: codebase
    pattern: "export (class|function) .*Emoji"
    path: packages/connectors/src
  ```

- [ ] 502 stub replaced with real handler in `parity-lanes-routes.ts`

  ```yaml
  verify:
    method: codebase
    pattern: "isn't available in this deployment"
    path: packages/api/src/routes/parity-lanes-routes.ts
    expect: absent
  ```

- [ ] Upload round-trip test (validate + store + audit) green

  ```yaml
  verify:
    method: bash
    run: "pnpm --filter @qm/connectors test emoji-upload"
  ```

- [ ] No provider → graceful response (200 with `pendingProviderRegistration: true`), not 500

  ```yaml
  verify:
    method: codebase
    pattern: "pendingProviderRegistration"
    path: packages/connectors/src
  ```

## Context & Decisions

- The 199L service is documented as IM-specific but the core flow (validate/store/audit) is provider-neutral
- Provider registry is out of scope — port the no-provider graceful path
- Slack/Feishu-specific behaviour deferred to provider packages (Feishu provider exists; Slack dropped per user decision)

## Relevant Files

- `packages/api/src/routes/parity-lanes-routes.ts:248` — current stub
- `packages/connectors/src/oauth-flow-store.ts` — example of provider-aware pattern in this package
- `parity-deviations.md:859-861` — documented deferral to be closed

## Dependencies

- **Blocked by**: none
- **External**: none

## Estimate

| Phase | Time |
|-------|------|
| Read + plan | 30m |
| Port service | 1 day |
| Wire + tests | 0.5 day |
| **Total** | **~1.5 days** |