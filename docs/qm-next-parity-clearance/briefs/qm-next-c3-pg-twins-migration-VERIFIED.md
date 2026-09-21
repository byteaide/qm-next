# Brief Status Note — qm-next-c3-pg-twins-migration

**Verified 2026-09-21:** brief is already implemented (no source changes
required).

## Why no-op

The brief assumed the gap list was open as of 2026-09-21. The actual
state landed on 2026-09-15 (per `docs/migration.md` §C.3 and
`docs/parity-deviations.md` §P5 20.0). All eight PG twins referenced in
the brief already exist and are wired into `packages/api/src/service.ts`
via the durable-by-default sweep:

| Twin | File |
|---|---|
| `createPostgresTaskStore` | `packages/tasks/src/postgres-task-store.ts:101` |
| `createPostgresGrantStore` | `packages/acl/src/postgres-grant-store.ts:54` |
| `createPostgresAdminGrantStore` | `packages/admin/src/postgres-admin-grant-store.ts:28` |
| `createPostgresAuditLog` | `packages/admin/src/postgres-audit-log.ts:23` |
| `createPostgresErrorLog` | `packages/admin/src/postgres-error-log.ts` |
| `createPostgresMetricsSink` | `packages/admin/src/postgres-metrics-sink.ts:55` |
| `createPostgresCredentialUsageSink` | `packages/admin/src/postgres-credential-usage-sink.ts` |
| `createPostgresEgressAuditSink` | `packages/admin/src/postgres-egress-audit-sink.ts:20` |
| `createPostgresRunActivityStore` | `packages/runs/src/postgres-run-activity-store.ts:20` |
| `createPostgresRunSignalStore` | `packages/runs/src/postgres-run-signal-store.ts:8` |
| `createPostgresInstanceRegistry` | `packages/runs/src/instance-registry.ts:13` |
| `createPostgresAmbientJudgmentStore` | `packages/api/src/services/ambient-stores.ts` |
| `createPostgresAckEmojiPickStore` | `packages/api/src/services/ambient-stores.ts` |
| `createPostgresReplayDedupe` | `packages/auth/src/replay-dedupe.ts` |

## Verification

- `pnpm rehearsal:migrate` — PASS (44/44 checks). Only "gap" note is
  `instance_heartbeats` which is `TRUNCATE_ONLY` by design (instance
  registry stays memory-led; see `scripts/migration-rehearsal.ts:101`).
- `pnpm typecheck` — green.
- 111/113 PG contract tests green against a fresh postgres:16 container
  (2 pre-existing failures in `run-event-log.test.ts` due to a
  schema-naming drift unrelated to this brief; tracked separately).

## What remains

None for this brief. If the future `instance_heartbeats` is meant to
become PG-backed, that's a separate brief — the current TRUNCATE_ONLY
note is intentional and documented.