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

```yaml
- id: KV-001
  rule: legacy `done` writes on target Run paths
  phase: 1
  location:
    - packages/types/src/run.ts
    - packages/store/src/memory-run-store.ts
    - packages/store/src/postgres-run-store.ts
    - packages/web-ui/src/server.ts
    - packages/orchestrator/tests/orchestrator.test.ts
    - packages/runs/tests/runs.test.ts
    - packages/store/tests/stores.test.ts
    - packages/boot/tests/profile.test.ts
    - packages/web-ui/tests/web-ui.test.ts
    - packages/web-ui/tests/web-ui-relay.test.ts
    - packages/api/tests/api.test.ts
    - packages/api/src/routes/admin-routes.ts
    - packages/im-bridge/tests/im-bridge.test.ts
    - packages/triggers/tests/triggers.test.ts
    - packages/triggers/tests/triggers-service.test.ts
    - packages/admin/tests/admin.test.ts
  notes: RunStatus union still carries 'done' as the legacy terminal
    state. Runtime writes and type references are acknowledged here;
    Phase 1 freezes the target state machine (`succeeded`/`failed`/
    `cancelled`) and rejects `done` on target write paths. Tests that
    assert `status === 'done'` are updated in Phase 1 alongside the
    runtime migration.

  Note: `packages/api/src/services/surface-context-queue.ts` and
  `packages/api/src/routes/context-routes.ts` carry `status: 'done'`
  strings but those are an unrelated `SurfaceContextResult` enum,
  not `RunStatus`. They are not in scope for KV-001.

- id: KV-004
  rule: IM platform symbols in im-core
  phase: 0  # enforced by the gate already; this entry exists so the
    # gate knows to skip the existing im-feishu / spike-feishu files.
  location: packages/im-feishu/src, packages/spike-feishu/src
  notes: Provider adapters legitimately name platforms. Core service code
    must not (pnpm check:im enforces; architecture gate inherits the same
    boundary).

- id: KV-005
  rule: command policy results collapsed into exit codes
  phase: 2
  location: packages/sandbox/src/policy.ts (legacy string-union return)
  notes: The legacy sandbox policy returns the legacy string union. Phase 2
    migrates it to the typed `CommandDecision` interface from `@qm/types`.

- id: KV-006
  rule: legacy RunEventBus publish without `seq` from SequenceAllocator
  phase: 1
  location: packages/orchestrator/src/orchestrator.ts (publishes to legacy bus)
  notes: The orchestrator still publishes on the legacy bus where the
    publisher assigns `seq` itself. Phase 1 routes new writes through the
    typed envelope and the SequenceAllocator.

- id: KV-007
  rule: process-local IM dedup Map still present (non-authoritative)
  phase: 7
  location:
    - packages/im-core/src/runtime/registry.ts
  notes: Phase 5 made the durable Intake Inbox the dedup authority
    (provider + eventId, ADR-0008); the registry's in-process `seenEvents`
    Map remains only as a first-level guard ahead of the durable accept.
    Phase 7 removes it together with the `target.im-intake` rollout flag
    ("Remove process-local IM dedup as the authoritative mechanism").
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
