# qm-next-c3-pg-twins-migration

## Origin

- **Created**: 2026-09-21
- **Parent task**: parity clearance (cluster 3, item: PG twins gap list)
- **Blocked by**: none (migration is a one-shot run + constructor wiring)
- **Conversation context**: `docs/migration.md` 20.0 checklist marks per-pg-twin gap list — tasks / acl / admin sinks / runs activity / signals / instance registry / ambient / ack stores remain constructor-only (memory leg). Closing this means: every store gets a Postgres twin with the same `DurableMap<T>` shape.

## What

For each constructor-only store listed in `migration.md` 20.0, add a `createPostgres*Store()` impl following the existing `createPostgresRunStoreDeliveryQueue` / `createPostgresChannelPolicyStore` / `createPostgresFileStore` pattern (added in P5 20.0).

## Why

`pnpm rehearsal:migrate` currently prints the gap list as "constructor-only stores un-ensured". Each gap means: data written in-memory in dev doesn't survive cutover. Each closed twin makes the migrator's PG-twin coverage 100%.

## Tier

`tier:standard` — multiple packages, each follows a known pattern, but coordination across the constructor wiring is non-trivial.

## Files to Modify

For each constructor-only store, add a Postgres twin. Current gap items (from `docs/migration.md` 20.0):

- `packages/tasks/src/` — `createPostgresTaskStore`
- `packages/acl/src/` — `createPostgresAclStore` (memory `GrantPersistence` already exposed per parity-deviations #726)
- `packages/admin/src/` — admin sinks PG twin
- `packages/runs/src/activity-store.ts`, `runs/src/signal-store.ts` — PG twins
- `packages/runs/src/instance-registry.ts` — already has `instance_heartbeats`; ensure registration path uses PG
- `packages/approvals/src/ambient-store.ts`, `approvals/src/ack-store.ts` — PG twins

Plus composition root wiring in `packages/api/src/service.ts` to select PG twin when `DATABASE_URL` is set.

## Implementation Steps

1. Read `docs/migration.md` 20.0 section for the exact gap list (may have evolved).
2. For each item:
   - Read the existing memory impl
   - Read one of the existing PG twins as reference (`createPostgresDeliveryQueue` in `packages/im-core/src/`)
   - Write `createPostgres*Store({ pool })` impl using the same shape
   - Add contract tests (`PG variant skipped without DATABASE_URL` per parity-deviations #868)
3. Wire into `packages/api/src/service.ts` composition root.
4. Re-run `pnpm rehearsal:migrate` and confirm gap list shrinks to zero.

```typescript
// packages/tasks/src/postgres-task-store.ts (skeleton)
export function createPostgresTaskStore(pool: Pool): TaskStore {
  return {
    async create(input) { /* INSERT INTO tasks ... RETURNING */ },
    async get(id) { /* SELECT * FROM tasks WHERE id = $1 */ },
    async transitionStatus(id, toStatus) { /* UPDATE */ },
    // ...
  }
}
```

## Hazards

- **Schema conflict**: ensure new tables don't collide with existing migrations. Use `CREATE TABLE IF NOT EXISTS` style.
- **Transaction semantics**: state machines like `tasks` need explicit transaction wrapping; verify against existing impl.
- **Test load**: each new PG twin needs a contract test; total wall-clock for testing can be significant.

## Verification Before Dispatch

```bash
pnpm --filter @qm/store test
pnpm test:pg
pnpm rehearsal:migrate
```

## Acceptance Criteria

- [ ] Each gap-store has a `createPostgres*Store()` impl

  ```yaml
  verify:
    method: bash
    run: "rg -l 'createPostgres.*Store' packages"
  ```

- [ ] `pnpm rehearsal:migrate` gap list is empty

  ```yaml
  verify:
    method: bash
    run: "pnpm rehearsal:migrate 2>&1 | grep -c 'un-ensured'"
    # Note: actual exit criterion is the count being 0
  ```

- [ ] Each new PG twin has a contract test (memory + PG parity)

  ```yaml
  verify:
    method: bash
    run: "pnpm test:pg | grep -c 'pass'"
  ```

- [ ] `docs/migration.md` updated: gap list marked closed

  ```yaml
  verify:
    method: codebase
    pattern: "20\\.0.*closed|gap list"
    path: docs/migration.md
  ```

## Context & Decisions

- Decision (this brief): treat each store as a leaf task; do not refactor the shared `DurableMap<T>` shape (qm-next already uses it per parity-deviations #704).
- 8 stores × ~0.5 day each = ~4 days wall-clock for the brief. Parallelisable across workers if needed.

## Relevant Files

- `docs/migration.md` 20.0 — gap list source of truth
- `packages/im-core/src/postgres-delivery-queue.ts` — reference PG twin pattern
- `packages/store/src/postgres-channel-policy-store.ts` — reference PG twin
- `packages/api/src/service.ts:1030-1050` — composition root durable-by-default sweep

## Dependencies

- **Blocked by**: none
- **External**: none

## Estimate

| Phase | Time |
|-------|------|
| Inventory gap stores | 30m |
| Impl 8 PG twins | 3 days (parallel) |
| Composition + runbook | 0.5 day |
| **Total** | **~4 days** (or ~1.5 days with 3 parallel workers) |