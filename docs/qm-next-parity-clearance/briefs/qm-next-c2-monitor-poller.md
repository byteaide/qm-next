# qm-next-c2-monitor-poller


## Origin

- **Created**: 2026-09-21
- **Parent task**: parity clearance (cluster 2, item: MonitorPoller)
- **Blocked by**: triggers/runs surface exposure (`runTrigger` / `IdentityService` / `DeliveryStore` / `IdempotencyStore` / `SandboxHandle`)
- **Conversation context**: `parity-deviations.md:712-715` notes the poller depends on surfaces not in `@qm/monitors`. Store + broker are in; poller awaits trigger surface.

## What

Implement the monitor poller (qm's `src/monitors/monitor-poller.ts`, 296L) inside `@qm/monitors`. Drives: arm → fire (calls `runTrigger`) → cursor advance → sweep on next interval.

## Why

Currently `@qm/monitors` has store + broker but no poller. Users can arm a monitor but nothing fires it. The store side is complete; this brief completes the runtime side.

## Tier

`tier:thinking` — needs cross-package dependency injection decisions; how to wire `runTrigger` without creating circular deps.

## Files to Modify

- `NEW: packages/monitors/src/monitor-poller.ts` — port qm's poller
- `EDIT: packages/monitors/src/index.ts` — export poller
- `EDIT: packages/api/src/service.ts` — composition wiring

## Implementation Steps

1. **WAIT** for these surfaces to be exposed (or composed in) to `@qm/monitors`:
   - `runTrigger` from `@qm/triggers`
   - `IdentityService` from `@qm/auth`
   - `DeliveryStore` from `@qm/im-core`
   - `IdempotencyStore` from `@qm/store`
   - `SandboxHandle` from `@qm/sandbox`
2. Once available, read qm's `src/monitors/monitor-poller.ts` (296L) for shape.
3. Port to `packages/monitors/src/monitor-poller.ts` using `@qm/types` types only (no cross-package circular imports).
4. Compose into api service; arm a test monitor + verify fire.
5. Contract tests: arm → tick → fire → cursor advance → sweep.

```typescript
// packages/monitors/src/monitor-poller.ts (skeleton)
export interface MonitorPollerDeps {
  monitorStore: MonitorStore
  broker: MonitorBroker
  runTrigger: RunTriggerFn
  identity: IdentityService
  delivery: DeliveryStore
  idempotency: IdempotencyStore
  sandbox: SandboxHandle
}

export function createMonitorPoller(deps: MonitorPollerDeps): {
  start(): void
  stop(): void
}
```

## Hazards

- **Circular deps**: `monitors` ↔ `triggers` historically. Use composition root wiring (function injection) rather than import.
- **Cursor recovery**: if process restarts mid-fire, monitor must resume from cursor without double-firing. Idempotency store is critical here.

## Acceptance Criteria

- [ ] `createMonitorPoller` exported from `@qm/monitors`

  ```yaml
  verify:
    method: codebase
    pattern: "export function createMonitorPoller"
    path: packages/monitors/src
  ```

- [ ] Arm + tick + fire e2e test green

  ```yaml
  verify:
    method: bash
    run: "pnpm --filter @qm/monitors test poller"
  ```

- [ ] `parity-deviations.md` 16.0 follow-up marked ✅

  ```yaml
  verify:
    method: codebase
    pattern: "MonitorPoller.*✅|monitor-poller.*✅"
    path: docs/parity-deviations.md
  ```

## Resume Condition

- `runTrigger`, `IdentityService`, `DeliveryStore`, `IdempotencyStore`, `SandboxHandle` all importable from `@qm/monitors` (or injected via composition)
- Resume worker then implements the poller

## Relevant Files

- `packages/monitors/src/monitor-broker.ts:6` — current poller-deferred comment
- `packages/monitors/src/monitor-store.ts:8` — same comment
- `parity-deviations.md:712-715, 855-858` — deferral records
- `qm/src/monitors/monitor-poller.ts` — source to port (296L)

## Dependencies

- **Blocked by**: triggers/runs/identity/delivery/idempotency/sandbox surface exposure to `@qm/monitors`
- **External**: none

## Estimate

| Phase | Time |
|-------|------|
| Wait for unblock | — |
| Port + tests | 2-3 days |
| **Total** | **~2-3 days (after unblock)** |