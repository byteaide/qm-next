# Known Architecture Violations

Status: **Live — 2026-09-19 Phase 0**

This file enumerates the architecture violations currently present in the
codebase. Each entry maps to the phase that resolves it. The architecture
gate (`pnpm test:architecture`) flags NEW occurrences of these patterns;
entries listed here are **acknowledged**, not silenced — a PR that adds a
new occurrence still fails review until the corresponding phase lands.

Each entry follows this shape:

```yaml
- id: KV-NNN
  rule: short description of the rule the entry violates
  phase: <phase number>            # which phase removes this violation
  location: <file:line or directory>   # where the violation currently lives
  notes: <optional context>
```

The architecture gate consults the `id:` and `location:` fields of this
file to decide whether a hit is acknowledged. When the phase that removes
the violation merges, the corresponding entries are deleted here and the
gate asserts no hits remain.

## Phase 0 seed entries

These are the legacy paths the 2026-09-19 architecture review recorded.
They are still present; the architecture gate acknowledges them.

As of the Phase 7 cutover (2026-09-20), KV-004 is the only remaining live
entry and is a **permanent allowlist**, not an unresolved violation: provider
adapters legitimately name platforms, and the entry exists so the gate skips
the adapter packages. All phase-resolvable violations recorded in this file
are resolved (see "Phase-resolved entries" below).

```yaml
- id: KV-004
  rule: IM platform symbols in im-core
  phase: 0  # enforced by the gate already; this entry exists so the
    # gate knows to skip the existing im-feishu / spike-feishu files.
  location: packages/im-feishu/src, packages/spike-feishu/src
  notes: Provider adapters legitimately name platforms. Core service code
    must not (pnpm check:im enforces; architecture gate inherits the same
    boundary).
```

## Phase-resolved entries

Entries move here as the corresponding phase ships. When the entry is
deleted from the live block above, the architecture gate asserts that no
hits remain in the tree.

- id: KV-002a
  rule: triggers package imports @qm/api
  phase: 4 (resolved — merged in "Merge Phase 1+4")
  resolution: `packages/triggers` depends only on the minimal
    `TriggerRuntime` contract from `@qm/types`; the composition seam is
    `TriggerRuntimeCordisService` in `@qm/api`. The TriggersService
    architecture test asserts no `@qm/api` dependency or import.

- id: KV-002
  rule: `api.cronsRuntime` compatibility write (single sanctioned seam)
  phase: 7 (resolved — chore/architecture-cutover)
  resolution: the `wire-cron-runtime.ts` composition service and the
    `api.cronsRuntime` field are deleted. Cron schedule storage, the
    scheduler, and the bridge delivery queue stay behind the Trigger
    boundary; the parity cron/admin/monitoring routes read the Cordis
    service registry lazily (`ctx.reflect.get('triggers'|'im-bridge')`),
    so the API never owns a copy and nothing writes into API state.
    The Triggers architecture test asserts zero `cronsRuntime` hits
    across `packages/api/src` and `packages/triggers/src`.

- id: KV-003
  rule: route-local OAuth pending Maps
  phase: 6 (resolved — feat/connector-oauth)
  resolution: the route-local `pendingLinks` Map and the route-owned
    callback state machine in `packages/api/src/routes/connector-routes.ts`
    are deleted. OAuth flow state, consent links, provider exchange, and
    token persistence live in the Connector context (`@qm/connectors`)
    behind the durable `oauth_flows` / `consent_links` stores (ADR-0009),
    and tokens are sealed by the vault (ADR-0017) before any durable
    write. Routes are HTTP adapters: validate, normalize, invoke,
    redact. The architecture gate's `new Map<string, OAuthFlow>` grep
    asserts zero hits in production runtime code.

- id: KV-001
  rule: legacy `done` writes on target Run paths
  phase: 7 (resolved — chore/architecture-cutover, slice 7.4)
  resolution: the run stores stamp every fresh row `runSource='target'`
    and the legacy `status='done'` write branch in `complete()` is
    deleted — terminal truth lives exclusively in `targetState`
    (ADR-0001). The web wire and admin metrics project the target state;
    claim/busy/waitFor semantics consult `targetState`. The
    `term:\s*'done'` grep gate stays at zero hits, and the
    `SurfaceContextResult` enum strings in
    `surface-context-queue.ts` / `context-routes.ts` remain out of scope
    (unrelated type). Historical physical rows with `status='done'` keep
    reading through the Phase 1 projection until `migrate:qm` rewrites
    them.

- id: KV-005
  rule: command policy results collapsed into exit codes
  phase: 7 (resolved — chore/architecture-cutover)
  resolution: the `LegacyCommandDecision` string alias is deleted from
    `@qm/types`; `CommandRule.decision` carries the canonical
    `CommandDecisionValue`, and the sandbox `PolicyVerdict` is shaped like
    the typed `CommandDecision` (decision + `ruleId` rule identity +
    reason). Deny/approval outcomes stay structured errors
    (`CommandDenied` / `NeedsApproval`) — never exit codes.

- id: KV-007
  rule: process-local IM dedup Map still present (non-authoritative)
  phase: 7 (resolved — chore/architecture-cutover)
  resolution: the im-core registry's `seenEvents` Map and its eviction
    policy are deleted; the registry passes every emitted event through
    to `onEvent`. Duplicate recognition is the durable Intake Inbox
    accept's job (provider + eventId, ADR-0008) — restart- and
    multi-instance-safe. The `target.im-intake` rollout flag was removed
    in the same slice; durable intake is unconditional. Registry tests
    assert the pass-through contract and the im-intake wiring tests
    cover the durable dedup invariant.

- id: KV-006
  rule: legacy RunEventBus publish without `seq` from SequenceAllocator
  phase: 7 (resolved — chore/architecture-cutover, slice 7.6)
  resolution: the legacy `RunEventBus` contract (`run-events.ts`), its
    memory implementation, the orchestrator's self-sequenced
    delta/progress/status publishing, and the web legacy SSE
    `/api/runs/:id/events` stream are deleted. The orchestrator produces
    typed `attempt.started` / `progress` (redacted excerpts, ADR-0014) /
    `attempt.finished` events through the target event log — `seq` comes
    from the SequenceAllocator inside the bus; the turn runner publishes
    the Run-terminal `run.finished` after the RunStore commits, so the
    orchestrator owns no subscriber truth (ADR-0001). The web SPA rides
    `/api/runs/:id/observation/subscribe` (`run_observation` frames over
    the durable log), and the api `/v1` observation routes are wired
    unconditionally.
