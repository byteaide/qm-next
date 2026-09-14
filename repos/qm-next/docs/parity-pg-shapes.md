# PG parity shape audit (2.4)

Cross-check of qm `test/postgres-*.test.ts` case shapes against qm-next's PG
coverage. Source of truth: `repos/qm/test/postgres-*.test.ts` (22 files,
~120 cases) audited 2026-09-14.

## Method

qm keeps separate memory and PG suites, so its PG files mostly assert
**durability shapes**: cross-instance visibility, restart survival, legacy
migration, index existence. qm-next's strategy is stronger where stores
exist: the **same contract body runs against memory and Postgres**
(memory-semantics parity by construction), plus explicit durability tests
(restart, cross-instance, prune). The audit therefore classifies each qm
file by what qm-next's approach covers or deliberately differs on.

## Mapping

| qm file (cases) | qm-next coverage | bucket |
|---|---|---|
| postgres-store (36: session lease, summaries, attributedTurns, tape, null-byte, indexes) | `@qm/store` session contract re-run over PG (lease mutual exclusion + recovery, monotonic seq, participants, thread heal); summaries/analytics surface via api relay tests. qm analytic internals (attributedTurns join, SQL-preview parity, tape watermarks) belong to qm's larger session design — recorded as design scope, not test gaps | contract re-run + by-design |
| postgres-map (12) | DurableMap PG: **added now** — table-name guard + cross-instance coherence (`stores.test.ts`); claim exactly-once via keychain PG test; cron round-trip via cron store PG cases; legacy fire-history migration n/a (fresh schema) | explicit + added now |
| postgres-directory-store (19) | directory contract re-run over PG + restart survival test. qm-specific shapes (email case-fold, Slack Connect, workspace URL) deviate by design in the qm-next directory model | contract re-run + by-design |
| postgres-grant-store (9) | grant ledger semantics via `@qm/auth` + share/files relay (12.0/13.0); qm warm-cache version shapes are qm grant-store internals | by-design |
| postgres-admin-grants (2) | admin PG grants round-trip **+ added now**: separate-store reads the promotion back | explicit + added now |
| postgres-audit-log (3) | record/tail/recordOnce round-trip **+ added now**: recordOnce idempotent across sink instances; legacy `audit_events` migration n/a | explicit + added now |
| postgres-memory-service (7) | memory contract re-run over PG (fold/dedupe/caps/recall/query/CAS/history/restore/metadata) | contract re-run |
| postgres-credential-usage-sink (2) | admin PG sinks round-trip | explicit |
| postgres-metrics-sink (3) | round-trip; column back-fill n/a (no legacy installs) | explicit + n/a |
| postgres-error-log (3) | admin PG sinks round-trip | explicit |
| postgres-egress-audit-sink (2) | admin PG sinks round-trip | explicit |
| postgres-replay-dedupe (2) | single-claim round-trip **+ added now**: expired entry pruned, stops blocking (fresh-instance claim) | explicit + added now |
| postgres-surface-cache (8) | context-policy store (channel-policy equivalent) + sessions surface via store contract; tsvector/matview message-cache shapes land with the 16.0 search lane / 21.0 schema diff | planned 16.0/21.0 |
| postgres-config-store (16: SOUL CAS/restore/history) | SOUL/config store subsystem pending | planned 16.0 |
| postgres-rate-limiter (1) | subsystem pending | planned 16.0 |
| postgres-budget (2) | subsystem pending | planned 16.0 |
| postgres-task-store (3) | subsystem pending | planned 16.0 |
| postgres-delivery-store (3) | qm-next deliveries are the runtime bridge queue (memory); durable outbound queue reconciles with migration | planned 16.0/21.0 |
| postgres-file-artifact-store (7) | files/blobs relay over sandbox + blob routes; durable artifact store pending | planned 16.0 |
| postgres-toolcalls-migration (3) | n/a — fresh schema, no legacy `(run_id, attempt, call_index)` installs to heal | n/a |
| postgres-instance-registry (1) | runs PG: beats + supersession | explicit |
| postgres-run-activity-store (1) | runs PG: append/list cross-connection | explicit |

## Test-infra fix surfaced by the audit

`scripts/run-pg.sh` waited on `pg_isready` only, which succeeds against the
initdb throwaway server before first-boot restart — the first PG-probing
suite file (`admin`, sorts first) raced the restart window and **silently
skipped** its PG cases in ~2 of 3 runs (exit 0 hides skips). The script now
requires a real `psql SELECT 1` to succeed twice, a second apart, before
exporting `QM_NEXT_PG_URL`.

## Gates at audit time

`pnpm test:pg`: 563 tests, 559 pass, 0 fail, 4 skipped — the skips are the
four key-gated real-model smokes (deviation #36 pattern), nothing else.
