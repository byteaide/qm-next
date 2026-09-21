# qm-next Monitor Poller — Design PRD (cluster 2)

**Date**: 2026-09-21
**Supersedes blocker note in**: `briefs/qm-next-c2-monitor-poller.md`
**Tier**: `standard` (design resolved below; was `thinking`)
**Target**: 1 engineer, ~1.5-2 days

## Context

qm's `repos/qm/src/monitors/monitor-poller.ts` (296L) is the runtime side of
monitors: arm → poll process output → classify event → fire a turn +
delivery → advance cursor → sweep on exit/expire. qm-next has the store and
broker (`packages/monitors/src/monitor-store.ts`, `monitor-broker.ts`) but no
poller — users can arm a monitor and nothing ever fires it
(`monitor-broker.ts:6` and `monitor-store.ts:8` self-document the deferral).

The original brief listed five "missing surfaces" (`runTrigger`,
`IdentityService`, `DeliveryStore`, `IdempotencyStore`, `SandboxHandle`) as
the blocker. Investigation against current main (`c739c8c`) shows qm-next's
composition already provides structurally equivalent pieces — the blocker
dissolves with a wiring design, not new infrastructure.

## Dependency mapping (qm → qm-next)

| qm poller dep | qm-next equivalent | Evidence |
|---|---|---|
| `runTrigger` + `TriggerDeps` | `FireEngine.submit(spec)` — same engine `CronScheduler` uses | `packages/triggers/src/fire.ts:53`, `scheduler.ts:64` |
| `run: TurnRequest → TurnResult` | `FireEngineDeps.sessions/runs/resolution` assembled at the composition root | `fire.ts:19-32` |
| `DeliveryStore` | `ImDeliveryQueue` via `FireEngineDeps.deliveries` | `service.ts:547` |
| `IdempotencyStore` | fireKey dedup carried on `SubmitSpec.fireKey` inside the fire engine | `fire.ts:36` |
| `IdentityService` | principal fields on the submit spec (`ownerId`/`ownerType`) | `fire.ts:38-39`, `actorOf` |
| `SandboxHandle.readProcess` | `ProcessRegistry` tail with cursor — the broker already consumes `BackgroundOutputTail {outputTail, cursor, exitCode}` | `monitor-broker.ts:33-37` |
| `MonitorStore.advance/recordError/setEnabled` | already exported by `@qm/monitors` | `monitor-store.ts:53-62` |
| `LeaderLease` | exported from `@qm/triggers` (`lease.ts`) | `triggers/index.ts:9` |

## Design decisions

| Question | Decision | Rationale |
|---|---|---|
| Circular deps (`monitors` ↔ `triggers`) | `@qm/monitors` declares a structural `MonitorFireSubmit` interface locally (the `submit(spec)` shape); the composition root injects the same `createFireEngine` bundle the cron scheduler uses. Zero new cross-package imports | Function injection at the composition root; matches the broker's existing type-only `@qm/processes` import pattern |
| Poller deps shape | `{ monitors, processes, fire, now?, maxFiresPerTick?, heartbeatMs?, minFireIntervalMs? }` | Everything else lives inside the fire engine |
| Event classification | Ported verbatim from qm: `output` / `exited` / `expired` / `lost` / `quiet` heartbeat (default 180s) + `minFireIntervalMs` (60s) + caps (16k event, 4k tail, 64k read, 20 fires/tick) | User-visible agent prompts stay identical to qm (`renderEvent`, `describeEvent`, `replyGuidance`) |
| fireKey vocabulary | Preserved: `monitor:<id>:<cursor>` / `:exit` / `:expired` / `:lost` / `:quiet:<since>` | Same dedup semantics the fire engine (and any future idempotency layer) expects |
| Boot wiring | `monitorPoller?: boolean` + `monitorPollerIntervalMs?: number` on `ApiConfig`; assembled in `service.ts` beside the cron scheduler, gated on monitors + triggers being present | Same gating pattern as `deployGit`; no boot when deps absent |
| Process liveness | Reuse the broker's process-gone handling from `@qm/processes` | One liveness definition, not two |

## Scope

**IN**

- `packages/monitors/src/monitor-poller.ts` — port of qm's poller (tick loop, per-monitor poll, event classification, fire + advance + sweep)
- `packages/monitors/src/index.ts` — export `createMonitorPoller` + types
- `packages/api/src/service.ts` — composition wiring + config schema fields
- `packages/monitors/tests/monitor-poller.test.ts` — contract tests with a fake `ProcessRegistry` and a recording fire engine
- `repos/qm-next/docs/parity-deviations.md` — flip the 16.0 MonitorPoller follow-up to ✅

**OUT**

- Multi-instance leader election beyond the existing lease export
- New stores or IM-domain delivery changes
- Cron/trigger sink behaviour changes (poller is a consumer, same as the scheduler)

## Verification

```bash
pnpm --filter @qm/monitors test
pnpm typecheck && pnpm test
pnpm check:im && pnpm rescope-check
```

Contract tests: arm → tick → fire recorded with `fireKey=monitor:<id>:<cursor>`
→ advance recorded → mark process exited → tick → `:exit` fire + `setEnabled(false)`
→ next tick no-ops. Cover quiet heartbeat, pattern filtering, lost process,
min-fire-interval, and max-fires-per-tick.

## Risks

| Risk | Mitigation |
|---|---|
| `FireEngine.submit` semantics differ from qm's `runTrigger` (consent ladder, destination visibility) | Monitor destinations flow through the same `destination` field the scheduler uses; test with a recording engine asserts the spec shape, and one integration test exercises the real engine |
| Double-fire within a tick | Per-tick seen-set; leader lease gates multi-instance (noop lease default, same as qm) |
| Prompt-drift from qm | `renderEvent` strings ported byte-for-byte; qm file referenced by line in the port |
