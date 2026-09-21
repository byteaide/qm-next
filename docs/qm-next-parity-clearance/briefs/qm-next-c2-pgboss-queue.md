# qm-next-c2-pgboss-queue

## Origin

- **Created**: 2026-09-21
- **Parent task**: parity clearance (cluster 2, item: pg-boss job queue)
- **Blocked by**: none
- **Conversation context**: pg-boss is documented in `parity-deviations.md` 16.0 follow-ups as blocked by pnpm-lockfile-only policy; user has now authorised the install.

## What

Add `pg-boss` as an alternative job-queue backend for `@qm/triggers` and other long-running scheduled work (cron sweeps, monitor polls). Current tick-based scheduler stays as fallback. Selection is by composition root config.

## Why

qm uses pg-boss for durable scheduled tasks. qm-next has only a tick-based scheduler (`packages/triggers/src/contract.ts` comment references this). For production durability across restarts and multi-instance, a job queue is needed.

## Tier

`tier:simple` — `pg-boss` is a single dep; adapter is a thin wrapper around the existing `TriggerSink` interface.

## Files to Modify

- `EDIT: packages/triggers/package.json` — add `pg-boss` dep
- `NEW: packages/triggers/src/pgboss-sink.ts` — `TriggerSink` impl over pg-boss
- `EDIT: packages/triggers/src/contract.ts` — note pgboss availability
- `EDIT: packages/api/src/service.ts` — composition root selects `pgbossSink` when `JOB_QUEUE=pgboss`

## Implementation Steps

1. Read `packages/triggers/src/contract.ts` and existing tick scheduler implementation.
2. Add `pg-boss` to `packages/triggers/package.json` dependencies.
3. Write `createPgBossSink({ connectionString })` that satisfies `TriggerSink` (subscribe / publish / ack / list).
5. On startup, `pg-boss.start()` and create schema via `pgboss.create()` for known trigger types.
6. Add a feature flag in composition root: `JOB_QUEUE=pgboss` switches from tick to pgboss.
7. Unit test: enqueue + worker drain round-trip using `pg-boss`'s in-memory test mode if available, else a Postgres container.

```typescript
// packages/triggers/src/pgboss-sink.ts (skeleton)
import PgBoss from 'pg-boss'
import type { TriggerSink } from './contract.ts'

export function createPgBossSink(connectionString: string): TriggerSink {
  const boss = new PgBoss(connectionString)
  let started: Promise<void> | null = null
  const ensure = () => (started ??= boss.start())
  return {
    async publish(topic, payload, opts) {
      await ensure()
      return boss.send(topic, payload, { ...opts })
    },
    async subscribe(topic, handler) {
      await ensure()
      await boss.work(topic, async ([job]) => { await handler(job.data); await job.complete() })
    },
    // ... ack / list
  }
}
```

## Hazards

- **Lockfile policy**: previous block was `pnpm-lockfile-only`; user authorised install. Add to `packages/triggers/package.json` only, not root.
- **Schema isolation**: pg-boss creates its own schema; ensure it doesn't collide with our existing trigger tables.
- **Backpressure**: pg-boss has retry/expire policies; match qm's defaults.

## Verification Before Dispatch

```bash
pnpm --filter @qm/triggers test
pnpm --filter @qm/triggers typecheck
pnpm test:pg
```

## Acceptance Criteria

- [ ] `pg-boss` in `packages/triggers/package.json`

  ```yaml
  verify:
    method: codebase
    pattern: '"pg-boss"'
    path: packages/triggers/package.json
  ```

- [ ] `createPgBossSink()` exported from `@qm/triggers`

  ```yaml
  verify:
    method: codebase
    pattern: "export function createPgBossSink"
    path: packages/triggers/src
  ```

- [ ] Enqueue + worker round-trip green

  ```yaml
  verify:
    method: bash
    run: "pnpm --filter @qm/triggers test pgboss"
  ```

- [ ] `pnpm test:pg` green (no regression on trigger contract)

  ```yaml
  verify:
    method: bash
    run: "pnpm test:pg"
  ```

## Context & Decisions

- Decision (this brief): keep tick scheduler as default; pgboss is opt-in via `JOB_QUEUE=pgboss`. Avoids forcing every dev to spin up pg-boss schema.
- pg-boss's connection string must equal `DATABASE_URL` (it shares the connection).
- No new IM platform symbols.

## Relevant Files

- `packages/triggers/src/contract.ts:17` — comment mentions pgboss
- `parity-deviations.md:712-715` — explicit deferral
- `packages/triggers/src/` — existing tick-based impl

## Dependencies

- **Blocked by**: none
- **External**: `pg-boss` npm package

## Estimate

| Phase | Time |
|-------|------|
| Read existing trigger sink | 30m |
| Impl + adapter | 1 day |
| Test (real pg container) | 0.5 day |
| **Total** | **~1.5-2 days** |