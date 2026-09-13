# Parity Deviations — qm-next vs qm

Discovered deviations are recorded here when found, never silently applied.
Each entry names the qm source shape, the qm-next shape, and why.

## P1 contract freeze (2026-09-13)

1. **`HarnessTurnInput.tools` optional** — qm requires `tools: ToolContext` on
   every turn; qm-next keeps it optional until the profile-assembly contract
   (P1 task 4.1) lands. Harnesses that require a toolset throw a clear runtime
   error when it is absent; the mock harness is unaffected.

2. **Security-screening callbacks deferred** — `screenExternalContent`,
   `screenToolResult`, `screenSecurity`, and `HarnessSecurityScreenInput` stay
   out of the frozen surface until P4 (tasks 14.0/16.0). Already noted in the
   M1 header; unchanged by P1.

3. **`HarnessModelUtilities` P4 members deferred** — `judge`, `pickAckEmoji`,
   `summarizeApproval` arrive with the P4 IM-domain backfill (task 14.0).
   P1 adds only `contextTokenBudget` (compaction path).

4. **Harness auth env typing** — qm's `keychainHarnessAuthEnv` returns
   `NodeJS.ProcessEnv`; the frozen `HarnessAuthEnvFactory` returns
   `Record<string, string>` so `@qm/types` stays dependency-free. Consumers
   spread it into child env, which is type-compatible.

5. **`CredentialResolver` bundling** — qm wires `keychain`,
   `resolveProviderKeys`, and harness-auth-env as separate construction
   arguments. qm-next freezes them as one `CredentialResolver` port with the
   same capabilities; assembly (4.1) provides the single seam.

6. **Surface search source values platform-neutral** — qm's
   `SurfaceSearchResult.source` includes `'slack'` and the search opt
   `source: 'mirror' | 'slack'`; the IM-isolation gate (`check:im`) forbids
   platform names in core. Frozen as `'cache' | 'live'` and `'mirror' | 'live'`.

7. **`WebhookVerification.scheme` open union** — qm names the
   provider-specific signing scheme literally; core keeps the generic schemes
   (`hmac-sha256 | github | stripe`) and allows plugin-registered extensions
   via `(string & {})`. Stored qm data remains type-compatible.

8. **`ToolContext` is type-level parity** — the full member surface is frozen
   so harness translations compile faithfully, but P1 runtime implementations
   cover the sandbox-backed core (`execute`/`read`/`write`/`computerStatus`/
   `restartComputer`); publish, background, MCP, memory, cron/webhook,
   control, and surface actions activate with their P4 subsystems.
   `ToolContextDeps` (assembly side) is deliberately not frozen yet.

9. **SessionStore tape/LLM-record methods added in P1** — `appendTape`,
   `getTape`, `recordLlmRequest`, `listLlmRequests` move from deferred to
   frozen with memory + PG implementations in the same commit. PG paths are
   smoke-verified; systematic coverage lands with task 2.4 (对拍测试).

10. **Goal hooks as vocabulary only** — `GoalRecord`/`GoalStatus`/`GrindBudget`
    are frozen in `@qm/types`; goal enforcement machinery stays internal to
    the harness package (same layering as qm).
