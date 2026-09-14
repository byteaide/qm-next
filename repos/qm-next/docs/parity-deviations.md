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

## Lane A1/A2 (2026-09-13, local implementation)

11. **DurableMap lives in @qm/store** — qm keeps `persistence/durable-map.ts`
    in core; the qm-next translation lands in the store package as the shared
    KV substrate. The optional per-pool `schema` hook is dropped — qm-next
    applies DDL through `createPgPool` statements.

12. **orgId injected, not global** — qm's keychain reads `configOrgId()` at
    write sites; qm-next has no config module, so `createKeychain` takes an
    optional `orgId` provider and org fields are omitted when absent.

13. **secret-source rebuilt from usage** — the qm original file was
    unreadable under the source-access guard (secret-bearing basename); the
    consumer-visible surface (`get(name)`) was rebuilt with env and map
    implementations. Byte-level fidelity is not claimed.

14. **Keychain manifest/ask-notice renderers deferred** —
    `renderKeychainManifest`, `renderAskNotice`, and the SAVE_HINT copy are
    IM-prompt/API-contract consumers; they arrive with the P4 IM domain and
    P3 keychain routes, not with the store.

15. **Model stores staged** — `custom-provider-store`,
    `model-credential-store`, `user-model-credential-store`, and
    `subscription-oauth` follow with their P3 routes; the P1 core ships the
    resolution layer (pi-models, provider-endpoints, custom-providers
    runtime registry, gateway) that harnesses consume.

## Lane B (2026-09-13, local implementation)

16. **secret-masking rebuilt from usage** — qm's `security/secret-masking.ts`
    is unreadable under the source-access guard (secret-bearing basename).
    The port keeps `redactCommand`'s readable flag/echo/export patterns
    verbatim and rebuilds the env-value masker beneath it: secret-looking
    env names (>=8-char values) mask to `[redacted]`. Exact qm marker text
    is unverified.

17. **WorkspaceStore seam narrowed to layer data** — qm's ro-layers and
    local-sandbox read the workspace store directly; the qm-next sandbox
    consumes pre-resolved `RoLayerData` through `opts.layerData` until the
    workspace package lands.

18. **Blob staging deferred to the control-plane phase** —
    `createExecBlobStaging` needs the `/v1/blobs` API and capability-token
    minting (P3 routes); P1 ships exec file ops and backup only.

## Lane A3 (2026-09-13, local implementation)

19. **Claude OAuth token endpoint injected, not hardcoded** — qm
    hardcodes the Claude token URL in `subscription-oauth.ts`; the value is
    pattern-redacted by the local source-access guard on every read path, so
    the port takes `claudeTokenUrl` as a required `createSubscriptionOAuth`
    option with no default. Call sites must supply the public endpoint (or
    verify the known public value) before subscription logins go live. The
    ChatGPT issuer (`https://auth.openai.com`) was readable in qm and ships
    as a constant.

20. **codex JWT claim helper lives in the model package** — qm's
    `codexOAuthJwtAccountIdFromToken` sits in `harness/codex-auth-file.ts`;
    the harness package is a later lane, so the model package carries a local
    copy with identical semantics (base64url payload, `chatgpt_account_id`
    under the `https://api.openai.com/auth` claim).

## Lane A4 (2026-09-13, local implementation)

21. **tar codec homed in `@qm/credentials`** — device-flow credential
    capture parses the sandbox tar inside the credentials package; moving
    the codec down from `@qm/sandbox` keeps the dependency direction
    (sandbox → credentials) acyclic. `@qm/sandbox` re-exports
    `makeTar`/`parseTar` so its public shape is unchanged.

22. **secret-drop and codex-device-login deferred with their consumers** —
    qm's `secret-drop.ts` (and its test) is unreadable under the local
    source-access guard, and its only consumers are P3 control-plane routes
    (api, wiring, capability tokens); `codex-device-login.ts` drives the
    Codex app-server, which lands with the harness lane (3.2). Both port
    together with those consumers.

## Lane B2 / harness-pi (2026-09-13, local implementation)

23. **pi-coding-agent vendored from upstream 0.82.0, not the qm security
    fork** — qm pins `0.82.0-qm-security.3`, a fork tarball published only on
    GitHub (unreachable from this environment); the npm registry serves the
    identical-base upstream `@earendil-works/pi-coding-agent@0.82.0`, which
    is vendored as `@qm/pi-coding-agent`. Swap in the fork tarball (same
    package shape) once GitHub is reachable; `pi-ai` needs no swap since qm
    itself consumes upstream 0.82.0 from the registry.

24. **config seam injected instead of qm's global config** — qm's
    `piHarnessConfigOptions(config)` and `coreToolOptions(config: Config)`
    read the 1,214-line global config; the harness takes the same fields as
    explicit options (`PiHarnessOptions`, structural `HarnessToolConfigSeed`)
    so the caller wires env/config values in. Related naming deltas: the
    surface search source literal is `live` (qm: `slack`) per the frozen
    platform-neutral contract, the default surface tool name is `surface`
    (qm: `slack`), and the surface-tool description text is
    platform-neutralized.

25. **tape audience filtering and run-signal request payloads deferred** —
    `filterTapeForAudience`/`tapeEventsEntitled` need qm's
    `principalEntitledToScope` from the resolution stack (P4/M3) and the
    orchestrator's audience plumbing, so `tape-fold` ports the fold/lint/heal
    core only; `RunSignal` drops the `request` field until the runs lane
    (P2 8.0) ports `TurnRequest` consumers. Both land with their consumers.

## Tool context assembly / 4.2a (2026-09-13)

26. **P1 ToolContext is sandbox-core only; M3 surfaces answer their
    graceful-unavailable values** — qm's `createToolContext`
    (src/tools/primitives.ts, 1,233 lines) wires ledger caching, command
    policy/approvals, control plane, reach, skills, memory, publishing and
    surface delivery. The P1 port (`packages/orchestrator/src/tool-context.ts`)
    implements execute/read/write/computer status and background process
    sessions over the Sandbox port; memory returns null, history empty,
    crons/webhooks/soul `control_unavailable`, publish/playground/MCP/sharing
    throw honest errors, surface delivery refuses. No command policy yet:
    execute runs everything the internal actor asks (the admission gate is
    internal-only identity); the approval pipe exists (harness) but nothing
    throws NeedsApproval until the policy lane.

27. **Local sandbox image is a P1 subset, unpinned** — qm builds
    `qm-sandbox-local` from `fly/Dockerfile` (claude-code, codex, gh, aws CLI,
    browser engine, digest-pinned bases) plus `local/Dockerfile`
    (microvm-agent). qm-next ports the same two-stage shape and the identical
    91-line agent daemon, but the base image drops claude/codex/browser,
    keeps gh + aws CLI + python venv to match the advertised profile spec,
    uses unpinned base tags (digest pins return with the image-supply lane),
    and defaults `LOCAL_SANDBOX_PLATFORM` to the host arch (qm pins
    linux/amd64 for Fly). `scripts/local-sandbox-build.sh` keeps the
    fingerprint label so staleness warnings work.

28. **No per-turn tool ledger** — qm caches tool results per (run, attempt,
    call index) through a ledger store; P1 executes every call live (no
    replay dedupe). The `once()` seam lands with the runs/replay lane.

## P2 convergence / multi-engine + runs (2026-09-13)

29. **Engine harness options drop the qm `Config` adapters** — qm exposes
    `claudeHarnessConfigOptions(config)` / `codexHarnessConfigOptions(config)`
    / `openCodeHarnessConfigOptions(config)` over the qm global `Config`;
    qm-next assembles engine options directly in the composition root
    (`packages/api/src/service.ts`) and the profile YAML. The adapters are
    re-created from the config seam when the P3 control plane lands.

30. **Per-package narrow task-store interfaces** — qm's harnesses consume the
    shared `TaskStore` (src/tasks/task-store.ts) for subagent task tracking;
    the tasks subsystem is P4. The ports type the narrow used surface
    (`create`/`get`/`transitionStatus`) per harness package
    (ClaudeTaskStore/CodexTaskStore/OpenCodeTaskStore) and accept `undefined`.
    These fold into the real store when P4 lands.

31. **Claude/codex/opencode tool options default `surfaceName: 'api'`** — qm's
    unreachable no-turn fallback names surface `"slack"`; qm-next keeps the
    platform-neutral surface vocabulary (P1 check:im discipline). The branch
    is unreachable (single-call runs pass a turn); recorded for traceability.

32. **Codex `recordLlmRequest` drops the abort-signal argument** — the frozen
    `@qm/types` recorder signature is `(rec)`; qm passes a 5s-timeout signal.
    The 5s timeout race stays (it rejects the race), the callee-side cancel
    is dropped until the contract grows the signal parameter.

33. **Run-signal contract lifted into `@qm/types`; poll helper moved to
    `@qm/runs`** — P1 parked the memory store + `startSignalPoll` inside
    `@qm/harness-pi`; with the P2 PG store arriving, the port contract lives
    next to the other run contracts and the poll helper lives with the other
    run runtime pieces; harness-pi re-exports both for compatibility.
    `RunSignal.request` is typed as `TurnInput` (qm: `TurnRequest`).

34. **Reaper error sink and leader lease are structural** — qm's reaper
    imports the admin `ErrorLog` and `persistence/leader-lease`; qm-next
    types the used surface locally (`ReaperErrorSink`, `LeaderLease`) so the
    admin sinks (P3) and triggers lease implementation satisfy it
    structurally. `REAPER_LEASE_KEY` keeps the qm value.

35. **Worker drops `resolveTurnOrigin`** — qm derives `TurnOrigin` from the
    raw request; qm-next `TurnInput` carries `origin` as a required field, so
    the worker replays `run.request` verbatim and only stamps
    runId/attempt/finalAttempt/background/cancel/queueMs. The turn-runner
    swap (api runner → `@qm/runs` worker) lands with the composition pass.

36. **Engine real-task smokes are credential-gated** — P2 acceptance calls
    for one real-task smoke per engine. pi is proven (P1 4.2, feishu +
    glm-5.2 over the SenseNova custom provider). claude/codex/opencode smokes
    need provider credentials (Anthropic key/OAuth, ChatGPT auth or
    OPENAI_API_KEY, opencode provider keys) that this environment does not
    hold; the P1-established skip-until-key pattern applies. Registration,
    profile switching, and the contract gates are the interim evidence.

## P3 lane A tranche 1 (2026-09-14, routes framework + directory/reach/crons)

37. **`either` auth treats the signed bearer as the capability principal (lane
    A)** — qm separates plugin-signer source auth from agent capability
    tokens; qm-next has no capability tokens until the control plane (12.0).
    The route framework authenticates `either` routes when a bearer is
    present and leaves `ctx.capability` null; capability-required branches
    (reach 403, keychain 401, consent 403) key off `ctx.actor`/`capability`
    so the 12.0 guard split is a framework-local change. Deviation scope:
    auth plumbing only — response shapes are unchanged.

38. **Cron routes land at the M3 store scope** — qm's capability-mode fields
    (`runAs`, `destinationKey`, `unattendedGrants`, personal `scope`) and the
    consent store arrive with the IM-domain backfill (14.0); the routes
    refuse those fields with qm's 400 error codes (message names the lane)
    and consent always reports "no consent pending" (qm's common case).
    Source-mode surface (create/list/get/patch/delete/disable/run/runs + fire
    log) is complete over `@qm/triggers`.

39. **Reach send gate is 501 until surface delivery is wired** — resolution,
    validation, membership/visibility, files checks and rate limiting are
    complete; the final send returns qm's `not_configured` 501 (files need
    blob staging from the control plane, 12.0; text delivery lands with the
    web-ui backend, 13.0). The 200 success path (`deliveryId`) is deferred,
    not reshaped.

40. **Directory routes translate the qm vocabulary onto the provider-neutral
    store** — qm's members/channels/groups sync maps to DirectorySyncPush
    (people/spaces/spaceMembers) with provider pinned to `slack` and
    instance `default` until real provider adapters land; `slackId` backfill
    keeps the qm resolve contract. `deactivate`/`reactivate` stay
    identity-gated 404 (identity service lands with the control plane), and
    audit events (`principal.*`, `skill_pack.*`…) defer to the 12.0 audit
    sinks.

41. **Keychain routes ride the qm-next Keychain with lane-A gaps** — the 11
    routes map 1:1 onto `createKeychain` (save/list/overview/delete, grant
    create/use/revoke, ask create/list/decline, use script as text/plain,
    `KeychainError` → `{error:"keychain"}` + own status). Deferred to later
    lanes: overview `usage`/`scopeNames` are empty until the
    credential-usage + scope-name sources land (12.0); the ask-owner notice
    enqueue rides the im-bridge wiring (13.0); the own-use `liveActor` gate
    and the triggered-turn 403 need real capability tokens (12.0/14.0).
    `config.keychain` backs the routes with memory maps in lane A;
    production swaps Postgres maps without touching the routes.

## P3 lane A tranche 3 (2026-09-14, surface sessions/conversations)

42. **Surface sessions/conversations land on an additively extended
    SessionStore** — `@qm/types` gains `Session.archived/pinned/color`,
    `SessionPatch`, and five additive store methods (`listByParticipant`,
    `searchEntries`, `patchSession`, `forkSession`, `discardSession`)
    implemented by both the memory and Postgres stores (PG contract tests
    stay PG-gated). Response shapes mirror qm's app layer
    (`{session, entries, earlierEntries?}`, `SessionSearchHit` fields,
    conversation view) with lane-A simplifications: transcript windowing
    skips qm's 400 KB byte-budget trim and payload projection; search
    snippets are composed in the route; `regenerateTitle` is deterministic
    (first user entry) instead of the LLM title pass; the conversation seed
    turn runs synchronously over the orchestrator (qm enqueues) so
    seed-refusal rollback keeps its exact `409 seed_turn_refused` shape.
    `POST /v1/session-cap` answers `503 not_configured` until capability
    minting lands (12.0), and the background views stay dep-gated 404 until
    the sandbox process-sessions lane; approvals answer qm's empty list.

43. **Memory/skills routes ride the lane-A principal as the capability** —
    qm gates the agent memory face on capability-token memory grants
    (`capability.memory.{read,write,orgWrite}`); the lane-A signed bearer
    carries only `{p}`, so the routes derive grants from the principal:
    read/write = the personal scope, orgWrite unset → org-scope requests
    403 exactly like an unprivileged qm capability, and the
    "recall not enabled" 403 is unreachable until real tokens land (12.0).
    Skill list/detail shapes drop packs (`source:"native"`, `pack` omitted,
    `assetCount:0`, `files:[]`, `grantedCapabilities:[]`), `editable` is
    `createdBy === viewer` (admin override with the 12.0 admin service),
    and qm's `trigger_blocked` 403s need the trigger mode (13.0). DELETE is
    a soft archive (restore republishes) matching qm; hard delete stays a
    store-level operation. Audit events (`memory.self.*`, `memory.agent.*`,
    skill audit) land with the 12.0 audit sinks.

44. **Context/surface-cache/projects lane-A service substitutions** —
    qm-next has no surface channel registry or directory of Slack channels
    yet, so: (a) surface-context queues requests as addressed — the
    `not_visible`/`identity_unverified` 403 pre-checks, `channel_not_found`
    404 and `ambiguous_channel` 409 need the IM bridge (13.0); (b)
    `/v1/surface-file` answers `download: null` (子集) because blob-read
    capability tokens land with the control plane (12.0); (c) context-policy
    accepts any `principalId` — qm's `listContexts` membership check needs
    the context registry; (d) projects treat every bearer principal as
    internal, members render `displayName: principalId`, slack-channel
    linking accepts any channel id and the in-use guard compares other
    projects' links instead of channel sessions; (e) the in-memory
    queue/cache/policy/project registries are per-process (Postgres swaps in
    behind the same interfaces); (f) audit events (`search.query`,
    `surface.ingest`, `surface.policy.set`, `project.*`) land with the 12.0
    sinks; (g) environments list only the viewer's own registries, the
    attach scope is the caller's personal scope, and the capability-missing
    403 maps to an unauthenticated request (deviation #43 equivalence).

45. **Files/grants/share/soul/config/deployments/connectors/webhooks/blobs
    lane-A service substitutions** — (a) sharing (`/v1/share`,
    `/v1/deployments/:id/share`) requires an agent capability token —
    source-signed callers included — so it answers the qm 403 for everyone
    until the 12.0 control plane mints tokens (recipient resolution,
    candidates, and grant plumbing land then); (b) the deployment proxy
    lane (`/d/<slug>/**`, the admin proxy, and the git http-backend routes)
    is not registered — it needs the deploy runtime and gate (13.0);
    `/v1/deployments/:id/fetch` answers `502 upstream_unreachable` and
    logs answer `{logs:null}` (no live runtime); `git-url` keeps the qm
    capability 403 and `owner-url` the unwired-`DEPLOY_APPS_DOMAIN` 503;
    (c) `/v1/connectors` wires the token store but no OAuth provider
    registry or consent links: the catalog is `{catalog: []}` (providers
    are deployment config), provider-keyed routes answer qm's
    unknown-provider 404s, `consent/mint` + `consent/redeem` 404 when
    unwired, and the callback rejects unknown states with
    `oauth_callback_failed`; the `{aud:"oauth-consent"}` route shape is
    enforced by the framework; (d) runtime-config/surface-config read a
    static lane-A model catalog (qm's pi registry, trimmed to the
    webui+base selectable entries) with all provider keys assumed
    available; (e) soul shared-scope writes need `managesScope` (real
    directory check, 13.0) so only personal scopes are writable; (f) file
    visibility is owner-or-grant with the grant ledger standing in for
    qm's ACL; (g) the in-memory file/webhook/blob/deployment/layer/
    connector/soul/runtime-config stores are per-process (Postgres swaps
    in behind the same interfaces); (h) webhook deliveries verify all four
    qm signature schemes but reach an agent only with the 13.0 IM bridge —
    accepted deliveries answer 202; (i) blob transfers accept bearer-or-
    anonymous callers (source-signature and blob-transfer-capability
    verification land with the 12.0 control plane; declared sha-256 is
    still enforced); (j) audits for this tranche land with the 12.0 sinks.

46. **Admin block + closing modules lane-A substitutions** — (a) the admin
    guard ladder is qm-verbatim (unwired admin → 404; missing `?scope=` →
    400; no org-admin grant → 403) and every handler is timed()-wrapped,
    but the heavy integrations answer qm's unwired shapes: identity →
    external-users 404 / email-allowed false; model credentials, MCP
    servers, slack-emoji, and the sandbox-routes surface → 404
    (`not_supported` for sandbox-routes); observability aggregates
    (metrics/runs) return empty latency summaries (the run store lacks a
    list in lane A); the admin resource manifest is empty so
    `PUT /scopes/:scope/:resource` answers 404 unknown resource, and
    command-policy-simulate answers 501 (no policy engine — 13.0);
    retention returns the scope id without the attribution report; (b)
    admin file reads/downloads require the caller to already see the file
    (owner-or-grant) — qm's admin bypass lands with the ACL (12.0), and
    admin uploads land in the caller's personal scope; (c) onboarding
    status is stored as a memory marker line (qm's notebook grammar lands
    with 13.0); (d) users are composed from the directory roster plus
    admin grants (participant attribution needs the session-store list
    API); (e) skill-pack register/sync/import surface the lane-A fetch
    error — register records qm's fetch-failure import row and returns the
    pack, catalog/import/sync answer 400 with the fetch message (qm would
    crash with a 500), importedCount is 0; (f) user-model-auth OAuth
    device flows answer qm's 502 gates (no codex binary / subscription
    OAuth); API keys are stored without provider-side validation; (g)
    secret-drop mint requires an agent capability token (401 for everyone
    until 12.0 mints tokens) while the form/redeem ladder is fully
    functional over the in-memory drop store; keychain persistence of
    redeemed drops lands with the 12.0 keychain service wiring; (h)
    `/v1/credentials/broker` answers 404 (service creds unwired) and
    `/v1/auth/broker/claim` answers qm's 503 (replay store not durable);
    (i) the cron destination PUT maps qm's clear-to-undefined onto the
    qm-next `destination: null` patch.

47. **12.0 control plane (lane B tranche 1) substitutions** — the `@qm/admin`
    and `@qm/auth` packages land (grant store + service, scoped event sinks
    with memory+PG twins, retention/attribution/users, invite email;
    signed payloads, capability tokens, replay dedupe, source-auth, AWS
    role broker, portal identity) and the api framework verifies the
    `x-agent-capability` header. Resolves the unwired shapes deferred by
    #45(a,i,j) and #46(g,h): `/v1/share` now validates the qm body and
    shares files through the grant ledger behind a verified capability
    (skill/deploy/cron targets still 404 until their stores converge at
    13.0; recipient-name resolution 404s until the directory resolver
    lands); blob transfers accept a bound blob-transfer capability
    (direction + 32-hex id on reads) beside the bearer/anonymous lane;
    `/v1/credentials/broker` proxies entitled aud-gated calls through the
    keychain service-credential reader with host/method/path pinning and
    usage/audit records (404 without a keychain); `/v1/auth/broker/claim`
    claims nonces over the durable replay store (PG under DATABASE_URL,
    qm's 503 when memory-only); secret-drop mint verifies the capability,
    refuses `triggered` callers and mints single-use drops over the real
    store. Remaining substitutions: (a) qm's `secret-drop.ts` source is
    unreadable behind the source-access guard, so the mint route is
    reconstructed from `docs/parity-api-contract.md` + the drop-store
    contract — the drop URL carries no embedded capability token yet (qm's
    `requiresToken` binding lands with the 13.0 web runtime); (b) a
    verified capability authenticates the request as its `actorId` (qm
    keeps capability and actor separate and adds portal identity on top —
    portal identity is wired in `@qm/auth` but not yet enforced by the
    gate); (c) aud routes now demand a capability token qm-verbatim
    (401 `<aud> capability token required` without one) instead of lane
    A's bearer-aud fallback; (d) `identity` and capability
    scope-membership checks (qm `authorizesCapabilityScope`) stay
    unwired, so revoked-scope 403s cannot fire yet; (e) admin metrics
    reads the real turn-metrics sink and audit/errors/egress read the
    sinks, but runs-based aggregates keep session-scope mapping null (no
    `sessionsByThreadRefs` seam) and the anatomy/phase histograms land
    with the observability convergence; (f) `check:im` was red since the
    parity routes introduced qm's IM-named contract vocabulary — the gate
    now scans every core package except the api parity surface for
    platform symbols and adds an SDK-import scan (no provider SDK may be
    imported outside `packages/im-*`) so the invariant it protects is
    actually enforceable.

48. **Admin console (12.0 tranche 2) substitutions** — the qm plugins/admin
    SPA (576KB single-file shell) is ported byte-level to
    `packages/api/admin-ui/` and served under `/admin/ui` with qm's
    CSP-hash/etag/gzip discipline; the `/api/*` proxy dispatches
    in-process onto `/v1/admin/*` (Fastify inject) with the
    `x-admin-actor` header and qm's READS/WRITES route ladder.
    Substitutions: (a) identity — the portal identity header verifies via
    `@qm/auth` once `portalIdentitySecret` is configured; without a secret
    the unsigned `admin` cookie is trusted for local development (qm's
    ALLOW_UNSIGNED_TEST_IDENTITY lane generalized — production must set
    the secret); (b) branding injection and the streaming blob-staged file
    upload path are not ported yet — they land with the portal/web-runtime
    convergence (13.0), the UI's scope-config branding PUT still proxies;
    (c) the console is served by the api process itself instead of qm's
    standalone sidecar (same origin, no source-auth signing needed);
    `plugins/portal` SSO remains the last 12.0 tranche.

49. **Portal SSO (12.0 tranche 3) substitutions** — the qm portal is a
    standalone front door (port 8097) that relays to separate web-ui/admin
    upstreams over the private network; qm-next runs one process, so the
    new `@qm/portal` package ports the issuing side in-process: sealed
    session/tmp cookies (domain-separated HMAC keys), the OIDC
    authorization-code + PKCE client (jose JWKS verification, Slack ok:false
    semantics, verified-email principal rules with domain/email allow-lists
    and an invited-gate hook), the five-minute single-use admin-login links
    (jti consumed through the durable replay-dedupe store) and an onRequest
    gate that admits valid admin sessions onto `/admin/ui` by minting the
    short-TTL `x-portal-identity` header the console verifies — the same
    assertion qm's proxy forwarded over the wire. Substitutions: (a) the
    surface-relay half of the qm portal (web-ui/admin/deployment proxies,
    webhook/OIDC-broker/drop-form/consent passthroughs) has no target here —
    those API lanes already exist in-process from earlier tranches, so only
    `/auth/*`, logout and the admin gate are mounted; (b) impersonation
    (`portal_impersonate` cookie + core impersonate route) is unported until
    the admin surface grows an impersonate lane; (c) playground anonymous
    sessions and the surface-config branding poll stay with the 13.0
    web-runtime convergence; (d) production boot checks reduce to the
    loop-guard (auth endpoint on the portal's own origin), the local-bypass
    locality rule and session TTL sanity — the full qm production checklist
    lands with deployment hardening.

50. **Web-ui convergence relay substitutions (13.0)** — qm's web-ui server
    signs every `/api/*` request and relays it to the core over the private
    network; qm-next runs one process, so the web server relays through
    in-process Fastify injects carrying a short-TTL per-user bearer (the
    same trust shape — a signed surface naming its user — with no wire hop;
    the api app instance is exposed on ApiService for this). Substitutions:
    (a) relay-only lanes that have no qm-next target stay heartbeat/501 —
    `/api/deliveries/events` (web delivery drain needs the delivery bus),
    `/api/sessions/:id/background/:pid/output` (process sessions have no web
    surface yet); (b) `ui-state` stays a dev-local in-memory map (qm persists
    it in core; the ui-state lane was outside the frozen 11.0 contract);
    (c) `scope-resources` is composed in the web server from the file /
    webhook / deployment relays plus the local crons and skills views, with
    webhook secrets redacted — qm composes it inside core; (d) the file list
    shape is translated (`{files}` over the api lane → `{owned, shared}` for
    the SPA); (e) the webhook verification error copy names "the supported
    signature schemes" instead of listing platform names, keeping
    check-im-isolation clean; (f) the principals allow-list and the
    portal-identity auth mode arrive via web-ui config (qm reads
    WEB_UI_PRINCIPALS / PORTAL_IDENTITY_SECRET from env).

51. **Ambient model judge adaptations (14.0 tranche 1)** — qm judges ambient
    chatter in batches replayed from the surface cache (delta since the
    container cursor, backdrop rows, rollup holds, solicited wakes via
    `asked_by`). qm-next judges each overheard message live as the bridge
    observes it, so: (a) one candidate per judge call — the qm prompt and
    JSON decision grammar are ported verbatim but the batch canvas is a
    single message; (b) standing orders (including the action-bot trigger
    lines) are composed per container from the channel policy and ride the
    candidate (`AmbientCandidate.orders`) instead of a batch field;
    (c) `asked_by` is parsed but not yet acted on — ambient turns keep the
    `ambient` origin, so solicited wakes degrade to proactive; (d) the bot
    ledger applies per event (ignore-mode bots skip, rollup-mode bots hold
    inside their window against the cursor, action-mode bots always judge)
    and unregistered bot events stay skipped, matching qm's self-exclusion
    without a self marker; (e) cursors are a per-container DurableMap
    (`ambient_cursors`) rather than qm's artifact map, and judgment records
    land in `ambient_judgments` with qm's columns; (f) the judge port is
    qm's `models.judge` from the default harness via
    `ApiService.ambientJudge` — `ambientJudgeMode: 'keyword'` keeps the
    deterministic stub for smokes and the e2e. The context-policy managed
    store can be shared as the ambient policy
    (`ambientPolicySource: 'api'`); the boot-local memory store remains
    the default for e2e arming.

52. **Reaction-as-ack adaptations (14.0 tranche 2)** — qm reacts to the
    trigger message only while the reply is streaming in (remove on first
    output block, ack text posted at the same moment); qm-next runs are
    non-streaming to IM, so the ack is reaction-only: react after
    `delayMs` (default 2s) if the run is still in flight, remove when the
    terminal reply is enqueued for delivery. Consequences: (a) no ack
    text line — the full reply is the first and only output; (b) the
    feishu provider removes by listing the message's reactions of that
    emoji type and deleting the first app-owned one (the API needs a
    reaction id the add response carries but the queue does not retain),
    so a user reacting with the same emoji may absorb the removal; (c) a
    run finishing between the liveness check and the add enqueue can
    leave an orphan reaction (qm has the same window); (d) emoji names
    map to Feishu `emoji_type` keys by uppercasing with
    spaces/dashes→underscores; unsupported names fail the op and burn the
    delivery-loop retries, so deployments should keep candidates within
    the platform set; (e) approval-resume turns and ambient turns (no
    trigger-message ref) never schedule acks; (f) pick observability
    lands in `ack_emoji_picks` with qm's columns, and
    `/v1/admin/ack-emoji-picks` reads it.

53. **Agent-request adaptations (14.0 tranche 3)** — qm's `[[ask-agent]]`
    flow is Slack-shaped (directory classify, conversations.open DM,
    Block Kit cards); the qm-next port is provider-neutral: (a) the
    directive regex accepts any provider-native user id (`<@id>`, `@id`,
    or bare); (b) DM resolution is a bridge port (`resolveDm`) backed by
    the directory sync (dm spaces + membership) — requests whose DM
    cannot resolve stay pending with a warning instead of degrading;
    (c) the approval card rides the provider renderer's optional
    `renderAgentRequest` (Lark implemented; button values embed the
    `qm.agent-request.v1` codec) with a neutral actionable-text fallback;
    (d) the approved personal turn runs as the target user in their dm
    thread (`provider:dm:<id>`) with qm's handoff instruction, and the
    result delivers back into the origin thread via the recorded route —
    qm additionally updates per-message status texts and labels, which
    the non-streaming bridge expresses as plain deliveries;     (e) only the
    target user may decide (store-enforced), duplicates dedupe, and
    re-recording never resurrects a decided request; (f) the registry is
    memory in `@qm/approvals` and Postgres (`agent_requests`) via the
    api's durable-by-default flag.

54. **Consent, edit notices, ask sweeps, and provenance adaptations
    (14.0 tranche 4)** — qm delivers notices to virtual principal
    destinations and runs ask resolutions through `runTrigger`; qm-next
    providers only deliver to concrete spaces, so: (a) recipient consent
    ports verbatim as pure helpers (`consentRequiredRecipient`,
    `recipientConsentSatisfied`, `decideRecipientConsent`) in
    `@qm/triggers`, the stamp rides `CronRecord.recipientConsent`
    (memory + Postgres `recipient_consent` JSONB with an additive ALTER
    for existing tables), and the fire engine (turn and direct-relay
    paths) refuses the fire, records the qm skip note, and sends the
    owner a skip notice to their resolved DM instead of qm's principal
    destination; (b) consent/edit/ask notices resolve the recipient's
    bot-DM through the directory (`resolveProviderDm`) — silently skipped
    (warn for asks) when no DM has synced, since a pending consent still
    holds deliveries safely; (c) the consent decision route implements
    qm's error ladder (capability 403, decision 400, unknown 404,
    no_consent 400, not_recipient 403); webhook consent is deferred with
    the webhooks consent backfill, and destination retargeting (no
    qm-next route) never re-stamps; (d) qm notifies cron edits only for
    `scopeShared` crons — qm-next has no shared mode yet, so any
    non-owner edit notifies the owner via qm's composer with an
    sha-256 fingerprint dedupe key, and the ref stays plain text (no
    admin-URL link yet); (e) ask resolution is a bridge sweep
    (`askResolutions`, default 30s) over qm's `createAskExpirySweep`
    shape: each resolved ask becomes a personal turn in the requester's
    DM carrying qm's resolution input (approved one-time/standing with
    the keychain-use command, declined, expired) — an unresolvable DM is
    marked notified with a warning instead of pinning the sweep, and qm's
    `fireAskResolution` fallback text + drop-resolution flow are not
    ported (no recorded requester destination and the secret-drop flow
    differs); (f) delivery provenance extends `DeliveryOrigin`
    (`surface/fireKey/sourceScopeId/sourceThreadRef/sourceTitle/
    sourceSessionId`) stamped by the fire engine and consumed by
    `/v1/admin/deliveries/shadow`, which lists live trigger-provenanced
    deliveries rather than qm's shadow dry-runs (no shadow mode exists).
