# qm-next-c2-codex-device-login

> ⚠️ **BATCH 2 — BLOCKED.** Do not dispatch until Codex credentials are available.

## Origin

- **Created**: 2026-09-21
- **Parent task**: parity clearance (cluster 2, item: codex-device-login)
- **Blocked by**: Codex auth credentials (CHATGPT_AUTH or OPENAI_API_KEY + ChatGPT subscription)
- **Conversation context**: `user-model-auth-routes.ts:55-83` returns 502 for all three codex/subscription flows. qm supports them; qm-next doesn't.

## What

Implement the three missing OAuth/device-login flows:
1. `POST /v1/user-model-auth/codex/start` — initiate device login
2. `POST /v1/user-model-auth/codex/complete` — poll/complete device flow
3. `POST /v1/user-model-auth/codex/poll` — device flow status

## Why

Users with ChatGPT subscriptions can't authenticate the codex harness through qm-next. Currently the harness is registered but the auth path is 502. Blocks any ChatGPT-subscriber onboarding.

## Tier

`tier:standard` — OAuth flow is a known pattern, but device-login specifics (codex binary, ChatGPT endpoint stability) need verification with real credentials.

## Files to Modify

- `EDIT: packages/api/src/routes/user-model-auth-routes.ts:55-83` — replace 502 stubs with real handlers
- `NEW: packages/harness-codex/src/codex-device-login.ts` — port qm's `src/harness/codex-device-login.ts`
- `EDIT: packages/harness-codex/src/index.ts` — export new login module

## Implementation Steps

1. **WAIT** for codex credentials (CHATGPT_AUTH or subscription OAuth).
2. Read qm's `src/harness/codex-device-login.ts` and `src/harness/codex-auth-file.ts` for shape.
3. Port `createCodexDeviceLogin` to `@qm/harness-codex`.
4. Replace 502 stubs in `user-model-auth-routes.ts`.
5. Wire into api service composition.
6. Test with real credentials (requires CHATGPT_AUTH env var).

```typescript
// packages/harness-codex/src/codex-device-login.ts (skeleton)
export interface CodexDeviceLoginOptions {
  codexBinary?: string
  onPoll: (status: 'pending' | 'authorized' | 'expired') => void
}

export function createCodexDeviceLogin(opts: CodexDeviceLoginOptions): {
  start(): Promise<{ userCode: string; verificationUri: string }>
  complete(userCode: string): Promise<{ token: string; accountId: string }>
}
```

## Hazards

- **Token storage**: codex tokens are sensitive; must use `secret-envelope` from `@qm/connectors`.
- **Binary availability**: codex binary must be present in sandbox; check `QM_CODEX_BINARY_PATH`.
- **Endpoint stability**: ChatGPT's device-login endpoint may change; use the same constant qm uses.
- **Account-id claim**: JWT claim `https://api.openai.com/auth` carries `chatgpt_account_id`; parse per parity-deviations #114.

## Resume Condition

- Codex auth credentials available (`CHATGPT_AUTH` env or similar)
- Worker has access to a Codex subscription account for live testing
- Resume worker then ports and tests the three flows

## Acceptance Criteria

- [ ] Three 502 stubs replaced with real handlers

  ```yaml
  verify:
    method: codebase
    pattern: "codex device-login binary is not available"
    path: packages/api/src/routes/user-model-auth-routes.ts
    expect: absent
  ```

- [ ] Device-login flow tested end-to-end with real credentials

  ```yaml
  verify:
    method: bash
    run: "pnpm --filter @qm/api test user-model-auth"
  ```

- [ ] Tokens stored via `secret-envelope` (not plaintext)

  ```yaml
  verify:
    method: codebase
    pattern: "secret-envelope|encryptSecret"
    path: packages/harness-codex/src
  ```

## Relevant Files

- `packages/api/src/routes/user-model-auth-routes.ts:55-83` — current 502 stubs
- `qm/src/harness/codex-device-login.ts` — source to port
- `qm/src/harness/codex-auth-file.ts` — related auth code
- `parity-deviations.md:128-133` — #22 deferral
- `parity-deviations.md:114-118` — JWT claim helper location

## Dependencies

- **Blocked by**: Codex credentials
- **External**: ChatGPT subscription or OPENAI_API_KEY, codex binary

## Estimate

| Phase | Time |
|-------|------|
| Wait for credentials | — |
| Port + wire | 2 days |
| Live testing | 1-3 days (depends on ChatGPT endpoint stability) |
| **Total** | **~3-5 days (after credentials)** |