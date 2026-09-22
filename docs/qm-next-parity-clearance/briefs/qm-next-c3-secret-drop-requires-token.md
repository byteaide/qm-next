# qm-next-c3-secret-drop-requires-token

## Origin

- **Created**: 2026-09-21
- **Parent task**: parity clearance (cluster 3, item: secret-drop `requiresToken`)
- **Blocked by**: none (independent small fix)
- **Conversation context**: `parity-lanes-routes.ts:146` has `requiresToken: true` as a flag but the drop URL doesn't actually carry the capability token. qm embeds the token in the URL; qm-next doesn't.

## What

Embed the calling capability token in the secret-drop URL returned from `POST /v1/secret-drops` (or equivalent). When the redeemed drop form page hits the URL, the token is required and verified before the form is rendered.

## Why

parity-deviations.md #47a marks the missing `requiresToken` binding as the last piece for control plane / secret-drop parity. Without it, anyone with the drop link can redeem.

## Tier

`tier:simple` — small, isolated edit; capability token minting is already wired.

## Files to Modify

- `EDIT: packages/api/src/routes/parity-lanes-routes.ts:140-160` — mint a `SECRET_DROP_AUD` capability token and embed in returned URL
- `EDIT: packages/api/src/routes/parity-lanes-routes.ts` — `/secret-drops/redeem` handler verifies token before serving form

## Implementation Steps

1. Read `parity-lanes-routes.ts:100-160` (current 401 + drop form/redeem ladder).
2. Read `packages/auth/src/capability-token.ts` for `mintCapabilityToken` API; the `SECRET_DROP_AUD` constant is already exported.
3. On mint: `const token = await mintCapabilityToken({ aud: SECRET_DROP_AUD, actorId: ctx.actor.id, exp: now + TTL }, secret, orgId)`. Embed as query param `?t=<token>` in returned URL.
4. On redeem: parse `t`, `verifyCapabilityToken`; if invalid/expired → 401. If valid → serve form.
5. Update tests: `tranche7-routes.test.ts:349-356` — extend to assert the token is present and that a request without it gets 401.

```typescript
// parity-lanes-routes.ts (sketch)
const dropToken = await mintCapabilityToken(
  { aud: SECRET_DROP_AUD, actorId: principalId, exp: Date.now() + 5 * 60 * 1000 },
  secrets, orgId
)
return sendJson(ctx, 200, { url: `${publicUrl}/d/${dropId}?t=${dropToken}` })
```

## Hazards

- **TTL**: too long → token reusable if leaked; too short → user friction. 5-10 min is the standard drop-link window.
- **URL logging**: this URL must not land in pnpm or test snapshots — redact in test output.
- **Replay**: minting a new drop with same id should revoke the old token. Use the existing `replayDedupe` from `auth`.

## Verification Before Dispatch

```bash
pnpm --filter @qm/api test tranche7
pnpm --filter @qm/api typecheck
pnpm test
```

## Acceptance Criteria

- [ ] Mint response URL contains `?t=<token>`

  ```yaml
  verify:
    method: codebase
    pattern: "SECRET_DROP_AUD"
    path: packages/api/src/routes/parity-lanes-routes.ts
  ```

- [ ] Redeem without token → 401

  ```yaml
  verify:
    method: bash
    run: "pnpm --filter @qm/api test tranche7"
  ```

- [ ] Redeem with valid token → 200 + form

  ```yaml
  verify:
    method: bash
    run: "pnpm --filter @qm/api test tranche7"
  ```

- [ ] `parity-deviations.md` updated: #47a marked ✅ with commit link

  ```yaml
  verify:
    method: codebase
    pattern: "secret-drop.*requiresToken|requiresToken.*secret-drop"
    path: docs/parity-deviations.md
  ```

## Context & Decisions

- Decision (this brief): 5-minute TTL for drop token. Matches qm's drop form window.
- The `replayDedupe` PG-backed dedupe (P5 20.0) handles replay naturally if we use `jti`.

## Relevant Files

- `packages/api/src/routes/parity-lanes-routes.ts:100-160` — current mint/redeem ladder
- `packages/auth/src/capability-token.ts:52-67` — `mintCapabilityToken` signature
- `packages/api/tests/tranche7-routes.test.ts:349-356` — existing test
- `parity-deviations.md:427-431` — deferral to close

## Dependencies

- **Blocked by**: none
- **External**: none

## Estimate

| Phase | Time |
|-------|------|
| Read current implementation | 15m |
| Token embed + verify | 0.5 day |
| Tests | 0.25 day |
| **Total** | **~0.5 day** |