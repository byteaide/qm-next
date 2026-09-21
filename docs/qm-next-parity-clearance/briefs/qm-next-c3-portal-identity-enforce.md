# qm-next-c3-portal-identity-enforce

## Origin

- **Created**: 2026-09-21
- **Parent task**: parity clearance (cluster 3, item: portal identity enforcement)
- **Blocked by**: none
- **Conversation context**: `parity-deviations.md #47b` notes portal identity is wired in `@qm/auth` but not enforced by the gate. Currently a portal-admin request without `portalIdentitySecret` configured falls back to unsigned-cookie trust for local dev — this is fine for dev but must not be the production path.

## What

Make the admin gate enforce portal-identity verification when `portalIdentitySecret` is configured. Without the secret configured → fail-closed (return 503) instead of falling back to unsigned cookie trust. With secret configured → require `x-portal-identity` header signed by the secret.

## Why

parity-deviations.md #47b marks this as a control-plane integrity gap. Currently a misconfigured production deployment could fall through to dev-mode identity.

## Tier

`tier:standard` — touches auth gate logic; must not break the documented `ALLOW_UNSIGNED_TEST_IDENTITY` lane for local dev.

## Files to Modify

- `EDIT: packages/auth/src/portal-identity.ts` — add explicit `verifyPortalIdentity(req, secret)` that fails closed if secret unset
- `EDIT: packages/portal/src/service.ts` — composition root: pass `portalIdentitySecret` or fail
- `EDIT: packages/api/src/routes/admin-ui-routes.ts` — admin gate uses new verifier

## Implementation Steps

1. Read `packages/auth/src/portal-identity.ts` (or equivalent) for current signature verification logic.
2. Read `packages/portal/src/service.ts:60-100` to find current secret-optional path.
3. Refactor: `verifyPortalIdentity` throws `MissingPortalSecretError` if `secret === undefined` AND `process.env.NODE_ENV === 'production'`. For dev, keep the existing unsigned-cookie trust path with a clear console warning.
4. In `portal/src/service.ts`, when `portalIdentitySecret` is undefined in production, log fatal + exit; in dev, warn + allow.
5. Update tests: add cases for (a) production without secret → fail closed, (b) dev without secret → allow with warning, (c) with secret + valid header → pass.

## Hazards

- **Dev experience**: must not break local `pnpm dev`. The `ALLOW_UNSIGNED_TEST_IDENTITY` lane stays.
- **Migration**: existing production deployments may rely on the loose path. Coordinate via runbook note in `docs/operations.md`.
- **Tests**: must not silently change test pass/fail — explicit new tests for each path.

## Verification Before Dispatch

```bash
pnpm --filter @qm/auth test
pnpm --filter @qm/portal test
pnpm --filter @qm/api typecheck
pnpm test
```

## Acceptance Criteria

- [ ] `verifyPortalIdentity` fails closed when `secret` unset + `NODE_ENV=production`

  ```yaml
  verify:
    method: codebase
    pattern: "MissingPortalSecretError|portalIdentitySecret.*required"
    path: packages/auth/src
  ```

- [ ] Dev mode still accepts unsigned cookie (with console warning)

  ```yaml
  verify:
    method: codebase
    pattern: "ALLOW_UNSIGNED_TEST_IDENTITY"
    path: packages/portal/src
  ```

- [ ] Test cases for production-fail-closed and dev-allow-pass

  ```yaml
  verify:
    method: bash
    run: "pnpm --filter @qm/auth test portal-identity"
  ```

- [ ] `docs/operations.md` updated with runbook entry for secret migration

  ```yaml
  verify:
    method: codebase
    pattern: "portalIdentitySecret"
    path: docs/operations.md
  ```

## Context & Decisions

- Decision (this brief): use `NODE_ENV === 'production'` as the strict-mode switch (matches qm convention).
- Alternative considered: an explicit `QM_STRICT_PORTAL_IDENTITY=1` env flag. Rejected because `NODE_ENV` is universal.

## Relevant Files

- `packages/auth/src/portal-identity.ts` — current verifier
- `packages/portal/src/service.ts:60-100` — composition path
- `parity-deviations.md:456-461` — deferral #47b
- `docs/operations.md` — runbook

## Dependencies

- **Blocked by**: none
- **External**: none

## Estimate

| Phase | Time |
|-------|------|
| Read current | 30m |
| Refactor + tests | 0.5 day |
| **Total** | **~1 day** |