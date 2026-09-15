/**
 * qm → qm-next migration rehearsal (p002 P5 19.3).
 *
 * Exercises scripts/migrate-qm.ts end-to-end against two real Postgres
 * databases:
 *   1. ensures the qm-next target schema by running the schema owners'
 *      statements / constructors (the same code paths production boots)
 *   2. seeds the source with a qm-shaped synthetic dataset covering every
 *      migration class: entity copies, the session/directory/crons/skills
 *      transforms, durable-map blob copies, the config seed family, the
 *      pending-approvals drain note and a PG-twin gap
 *   3. runs the migrator CLI dry (rollback), then --commit, verifies counts
 *      and transformed values, then --rollback and verifies the target is
 *      clean again
 *
 * Env: QM_MIGRATE_SOURCE_URL, QM_MIGRATE_TARGET_URL (container orchestration
 * lives in scripts/run-migration-rehearsal.sh).
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createPgPool } from '../packages/store/src/pg-pool.ts'
import { RUN_SCHEMA_STATEMENTS, SESSION_SCHEMA_STATEMENTS } from '../packages/store/src/schema.ts'
import { CRONS_SCHEMA_STATEMENTS } from '../packages/triggers/src/postgres-cron-store.ts'
import { APPROVALS_SCHEMA_STATEMENTS } from '../packages/approvals/src/postgres-approval-store.ts'
import { DIRECTORY_SCHEMA_STATEMENTS } from '../packages/directory/src/postgres-directory-store.ts'
import { SKILLS_SCHEMA_STATEMENTS } from '../packages/skills/src/postgres-store.ts'
import { MEMORY_SCHEMA_STATEMENTS } from '../packages/memory/src/postgres-store.ts'
import { DELIVERIES_SCHEMA_STATEMENTS } from '../packages/im-core/src/runtime/postgres-delivery-queue.ts'
import { CHANNEL_POLICY_SCHEMA_STATEMENTS } from '../packages/api/src/services/channel-policy-store.ts'
import { FILE_ARTIFACTS_SCHEMA_STATEMENTS } from '../packages/api/src/services/file-store.ts'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

type Row = Record<string, unknown>

const SOURCE_URL = process.env.QM_MIGRATE_SOURCE_URL
const TARGET_URL = process.env.QM_MIGRATE_TARGET_URL
if (!SOURCE_URL || !TARGET_URL) throw new Error('QM_MIGRATE_SOURCE_URL and QM_MIGRATE_TARGET_URL are required')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok: ${label}`)
  } else {
    failures += 1
    console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---- phase 1: ensure target schema via the schema owners ------------------------
//
// Statement arrays are the schema owners' own DDL (same constants production
// uses). Blob destinations are ensured the way qm-next ensures every
// DurableMap table (createPostgresMap). Constructor-only stores (tasks, acl,
// admin sinks, run activity/signals, instance registry, …) are deliberately
// NOT ensured here: their absence exercises the migrator's PG-twin gap path
// and documents exactly which schema surfaces remain composition-dependent
// (20.0 input).

const BLOB_DESTINATIONS = [
  'skill_bundles',
  'skill_packs',
  'monitors',
  'model_credentials',
  'custom_model_providers',
  'admin_slack_installation',
  'keychain_credentials',
  'keychain_grants',
  'keychain_asks',
  'secret_drops',
  'credential_liveness',
  'device_flow_cutover',
  'device_flow_cutover_resets',
  'mcp_servers',
  'connector_status',
  'connector_clients',
  'oauth_flows',
  'consent_links',
  'browser_sessions',
  'insight_cursors',
  'webhooks',
]

async function ensureTargetSchema(): Promise<void> {
  console.log('phase 1: ensure qm-next target schema')
  const pool = createPgPool(TARGET_URL!, [
    ...RUN_SCHEMA_STATEMENTS,
    ...SESSION_SCHEMA_STATEMENTS,
    ...CRONS_SCHEMA_STATEMENTS,
    ...APPROVALS_SCHEMA_STATEMENTS,
    ...DIRECTORY_SCHEMA_STATEMENTS,
    ...SKILLS_SCHEMA_STATEMENTS,
    ...MEMORY_SCHEMA_STATEMENTS,
    ...DELIVERIES_SCHEMA_STATEMENTS,
    ...CHANNEL_POLICY_SCHEMA_STATEMENTS,
    ...FILE_ARTIFACTS_SCHEMA_STATEMENTS,
  ])
  const { createPostgresMap } = await import('../packages/store/src/durable-map.ts')
  // Constructor-only stores (20.0): a durable api boot instantiates these,
  // so the rehearsal mirrors that — no more PG-twin gap notes for them.
  // instance_heartbeats stays un-ensured by design (TRUNCATE_ONLY note).
  const closers: Array<{ close?(): Promise<void> }> = []
  const { createPostgresTaskStore } = await import('../packages/tasks/src/postgres-task-store.ts')
  const { createPostgresGrantStore } = await import('../packages/acl/src/postgres-grant-store.ts')
  const { createPostgresProcessRegistry } = await import('../packages/processes/src/process-registry.ts')
  const { createPostgresRunActivityStore, createPostgresRunSignalStore } = await import('../packages/runs/src/index.ts')
  const { createPostgresReplayDedupe } = await import('../packages/auth/src/replay-dedupe.ts')
  const {
    createPostgresAdminGrantStore,
    createPostgresAuditLog,
    createPostgresErrorLog,
    createPostgresMetricsSink,
    createPostgresCredentialUsageSink,
    createPostgresEgressAuditSink,
  } = await import('../packages/admin/src/index.ts')
  const { createPostgresAmbientJudgmentStore, createPostgresAckEmojiPickStore } = await import('../packages/api/src/services/ambient-stores.ts')
  try {
    await pool.pool()
  const pushCloser = (store: unknown): void => {
    closers.push(store as { close?(): Promise<void> })
  }
  pushCloser(createPostgresTaskStore(TARGET_URL!))
  pushCloser(createPostgresGrantStore(TARGET_URL!))
  pushCloser(createPostgresProcessRegistry(TARGET_URL!))
  pushCloser(createPostgresRunActivityStore(TARGET_URL!))
  pushCloser(createPostgresRunSignalStore(TARGET_URL!))
  pushCloser(createPostgresReplayDedupe(TARGET_URL!))
  pushCloser(createPostgresAdminGrantStore(TARGET_URL!))
  pushCloser(createPostgresAuditLog(TARGET_URL!))
  pushCloser(createPostgresErrorLog(TARGET_URL!))
  pushCloser(createPostgresMetricsSink(TARGET_URL!))
  pushCloser(createPostgresCredentialUsageSink(TARGET_URL!))
  pushCloser(createPostgresEgressAuditSink(TARGET_URL!))
  pushCloser(createPostgresAmbientJudgmentStore(TARGET_URL!, 'default'))
  pushCloser(createPostgresAckEmojiPickStore(TARGET_URL!, 'default'))
    for (const table of BLOB_DESTINATIONS) {
      const map = createPostgresMap<Row>(pool, table)
      await map.get('__warm__')
    }
  } finally {
    for (const closer of closers) await closer.close?.().catch(() => undefined)
    await pool.close()
  }
}

// ---- phase 2: seed the qm-shaped source ------------------------------------------

const DDL = [
  `CREATE TABLE IF NOT EXISTS sessions( id TEXT PRIMARY KEY, type TEXT NOT NULL, scope_id TEXT NOT NULL, thread_ref TEXT UNIQUE NOT NULL, created_at BIGINT NOT NULL )`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS channel_name TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS surface TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_activity BIGINT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS messages INT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turns INT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS forked_from_session_id TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS forked_from_title TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS fork_boundary_seq INT`,
  `CREATE TABLE IF NOT EXISTS session_entries( session_id TEXT NOT NULL, seq INT NOT NULL, parent_seq INT, type TEXT NOT NULL, payload TEXT, scope_label TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(session_id, seq) )`,
  `CREATE TABLE IF NOT EXISTS participants( session_id TEXT NOT NULL, principal_id TEXT NOT NULL, valid_from BIGINT NOT NULL, valid_to BIGINT, PRIMARY KEY(session_id, principal_id) )`,
  `ALTER TABLE participants ADD COLUMN IF NOT EXISTS title TEXT`,
  `ALTER TABLE participants ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE participants ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE participants ADD COLUMN IF NOT EXISTS color TEXT`,
  `ALTER TABLE participants ADD COLUMN IF NOT EXISTS valid_from_seq INT`,
  `ALTER TABLE participants ADD COLUMN IF NOT EXISTS valid_to_seq INT`,
  `CREATE TABLE IF NOT EXISTS session_leases( session_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at BIGINT NOT NULL )`,
  `ALTER TABLE session_leases ADD COLUMN IF NOT EXISTS holder TEXT`,
  `ALTER TABLE session_leases ADD COLUMN IF NOT EXISTS acquired_at BIGINT`,
  `CREATE TABLE IF NOT EXISTS session_tape( session_id TEXT NOT NULL, seq INT NOT NULL, kind TEXT NOT NULL, harness TEXT, payload TEXT NOT NULL, scope_label TEXT NOT NULL, bare_text TEXT, ts TEXT, change_time TEXT, hidden BOOLEAN, overheard BOOLEAN, author TEXT, entry_seq INT, covers_entry_seq INT, created_at BIGINT NOT NULL, PRIMARY KEY(session_id, seq) )`,
  `CREATE TABLE IF NOT EXISTS session_llm_requests( id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_seq INT, step INT NOT NULL, model TEXT NOT NULL, scope_label TEXT NOT NULL, request TEXT NOT NULL, truncated BOOLEAN NOT NULL DEFAULT FALSE, created_at BIGINT NOT NULL )`,
  `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS ttft_ms INT`,
  `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS duration_ms INT`,
  `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS step_gap_ms INT`,
  `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS tool_wall_json TEXT`,
  `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS usage_json TEXT`,
  `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS transport_json TEXT`,
  `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS gap_phases_json TEXT`,
  `ALTER TABLE session_llm_requests ALTER COLUMN request DROP NOT NULL`,
  `ALTER TABLE session_llm_requests ADD COLUMN IF NOT EXISTS prompt_hash TEXT`,
  `CREATE TABLE IF NOT EXISTS llm_prompt_envelopes( hash TEXT PRIMARY KEY, body TEXT NOT NULL, created_at BIGINT NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS runs( id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, request TEXT NOT NULL, result TEXT, idempotency_key TEXT UNIQUE, attempts INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL DEFAULT 3, lease_token TEXT, lease_expires_at BIGINT, worker_id TEXT, created_at BIGINT NOT NULL, started_at BIGINT, finished_at BIGINT )`,
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS delivery_state TEXT`,
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS error_attempts INT NOT NULL DEFAULT 0`,
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS seq BIGSERIAL`,
  `CREATE TABLE IF NOT EXISTS tool_calls( run_id TEXT NOT NULL, call_index INT NOT NULL, output TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(run_id, call_index) )`,
  `CREATE TABLE IF NOT EXISTS run_activity( id BIGSERIAL PRIMARY KEY, run_id TEXT NOT NULL, seq BIGINT NOT NULL, parent_seq BIGINT, type TEXT NOT NULL, payload JSONB NOT NULL, created_at BIGINT NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS run_signals( id BIGSERIAL PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, created_at BIGINT NOT NULL, consumed_at BIGINT )`,
  `ALTER TABLE run_signals ADD COLUMN IF NOT EXISTS payload JSONB`,
  `CREATE TABLE IF NOT EXISTS instance_heartbeats( instance_id TEXT PRIMARY KEY, build_sha TEXT NOT NULL, started_at BIGINT NOT NULL, beat_at TIMESTAMPTZ NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS memory_revisions( id BIGSERIAL PRIMARY KEY, scope_id TEXT NOT NULL, seq BIGINT NOT NULL, op TEXT NOT NULL, body TEXT NOT NULL, author TEXT, at BIGINT NOT NULL, UNIQUE (scope_id, seq) )`,
  `CREATE TABLE IF NOT EXISTS tasks( id TEXT PRIMARY KEY, session_id TEXT NOT NULL, origin_run_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped', 'failed')), created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS task_events( id BIGSERIAL PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('created', 'status_changed')), from_status TEXT, to_status TEXT NOT NULL, created_at BIGINT NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS process_sessions( process_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, kind TEXT NOT NULL, command TEXT NOT NULL, started_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, status TEXT NOT NULL )`,
  `ALTER TABLE process_sessions ADD COLUMN IF NOT EXISTS session_ref TEXT`,
  `ALTER TABLE process_sessions ADD COLUMN IF NOT EXISTS run_id TEXT`,
  `CREATE TABLE IF NOT EXISTS acl_grants( owner_scope_id TEXT NOT NULL, path TEXT NOT NULL, grantee_scope_id TEXT NOT NULL, permission TEXT NOT NULL, granted_by TEXT NOT NULL, PRIMARY KEY (owner_scope_id, path, grantee_scope_id, permission) )`,
  `CREATE TABLE IF NOT EXISTS acl_grants_version( only_row BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (only_row), v BIGINT NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS admin_grants( principal_id TEXT NOT NULL, scope_id TEXT NOT NULL, role TEXT NOT NULL, granted_by TEXT, created_at BIGINT, PRIMARY KEY (principal_id, scope_id, role) )`,
  `CREATE TABLE IF NOT EXISTS audit_log( id BIGSERIAL PRIMARY KEY, at BIGINT NOT NULL, principal_id TEXT NOT NULL, action TEXT NOT NULL, resource TEXT NOT NULL, scope_label TEXT NOT NULL, status TEXT, detail TEXT )`,
  `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS idempotency_key TEXT`,
  `CREATE TABLE IF NOT EXISTS directory_members( org_id TEXT NOT NULL, principal_id TEXT NOT NULL, display_name TEXT NOT NULL, display_name_lc TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (org_id, principal_id) )`,
  `CREATE TABLE IF NOT EXISTS directory_channels( org_id TEXT NOT NULL, channel_id TEXT NOT NULL, name TEXT NOT NULL, name_lc TEXT NOT NULL, is_private BOOLEAN NOT NULL DEFAULT FALSE, roster_known BOOLEAN NOT NULL DEFAULT FALSE, PRIMARY KEY (org_id, channel_id) )`,
  `ALTER TABLE directory_channels ADD COLUMN IF NOT EXISTS is_external BOOLEAN NOT NULL DEFAULT FALSE`,
  `CREATE TABLE IF NOT EXISTS directory_channel_members( org_id TEXT NOT NULL, channel_id TEXT NOT NULL, principal_id TEXT NOT NULL, PRIMARY KEY (org_id, channel_id, principal_id) )`,
  `CREATE TABLE IF NOT EXISTS directory_groups( org_id TEXT NOT NULL, group_id TEXT NOT NULL, roster_known BOOLEAN NOT NULL DEFAULT FALSE, PRIMARY KEY (org_id, group_id) )`,
  `CREATE TABLE IF NOT EXISTS directory_group_members( org_id TEXT NOT NULL, group_id TEXT NOT NULL, principal_id TEXT NOT NULL, PRIMARY KEY (org_id, group_id, principal_id) )`,
  `CREATE TABLE IF NOT EXISTS directory_sync( org_id TEXT PRIMARY KEY, members_hash TEXT, channels_hash TEXT, groups_hash TEXT, channel_members_synced BOOLEAN NOT NULL DEFAULT FALSE, updated_at BIGINT NOT NULL )`,
  `ALTER TABLE directory_sync ADD COLUMN IF NOT EXISTS members_synced_at BIGINT`,
  `ALTER TABLE directory_sync ADD COLUMN IF NOT EXISTS channels_synced_at BIGINT`,
  `ALTER TABLE directory_sync ADD COLUMN IF NOT EXISTS groups_synced_at BIGINT`,
  `CREATE TABLE IF NOT EXISTS environments( id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT, owner_actor_id TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS ambient_judgments( id BIGSERIAL PRIMARY KEY, org_id TEXT NOT NULL, surface TEXT NOT NULL, container TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT, prompt TEXT, model TEXT, latency_ms INT, ts_from TEXT, ts_to TEXT, created_at BIGINT NOT NULL )`,
  `ALTER TABLE ambient_judgments ADD COLUMN IF NOT EXISTS asked_by TEXT`,
  `CREATE TABLE IF NOT EXISTS ack_emoji_picks( id BIGSERIAL PRIMARY KEY, org_id TEXT NOT NULL, surface TEXT NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL, outcome TEXT NOT NULL, picked TEXT, icon TEXT, message TEXT, candidates TEXT, model TEXT, latency_ms INT, created_at BIGINT NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS durable_map_table( id TEXT PRIMARY KEY )`,
  `DROP TABLE IF EXISTS durable_map_table`,
  `CREATE TABLE IF NOT EXISTS crons( id TEXT PRIMARY KEY, json JSONB NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS cron_fire_log( cron_id TEXT NOT NULL, fire_key TEXT NOT NULL, fired_at BIGINT NOT NULL, json JSONB NOT NULL, PRIMARY KEY (cron_id, fire_key), FOREIGN KEY (cron_id) REFERENCES crons(id) ON DELETE CASCADE )`,
  `CREATE TABLE IF NOT EXISTS skills( id TEXT PRIMARY KEY, json JSONB NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS skill_bundles( id TEXT PRIMARY KEY, json JSONB NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS skill_packs( id TEXT PRIMARY KEY, json JSONB NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS monitors( id TEXT PRIMARY KEY, json JSONB NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS model_credentials( id TEXT PRIMARY KEY, json JSONB NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS custom_model_providers( id TEXT PRIMARY KEY, json JSONB NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS slack_installation( id TEXT PRIMARY KEY, json JSONB NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS approvals( id TEXT PRIMARY KEY, json JSONB NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS approval_grants( id TEXT PRIMARY KEY, json JSONB NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS webhooks( id TEXT PRIMARY KEY, json JSONB NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS channel_policy(
      org_id TEXT NOT NULL, container TEXT NOT NULL,
      orders TEXT NOT NULL DEFAULT '', bots JSONB NOT NULL DEFAULT '{}'::jsonb,
      set_by TEXT, updated_at BIGINT NOT NULL,
      PRIMARY KEY(org_id, container)
    )`,
  `ALTER TABLE channel_policy ADD COLUMN IF NOT EXISTS ambient_enabled BOOLEAN`,
  `CREATE TABLE IF NOT EXISTS channel_policy_history(
      id BIGSERIAL PRIMARY KEY,
      org_id TEXT NOT NULL, container TEXT NOT NULL,
      orders TEXT NOT NULL, set_by TEXT, session_id TEXT,
      created_at BIGINT NOT NULL
    )`,
  `ALTER TABLE channel_policy_history ADD COLUMN IF NOT EXISTS bots JSONB`,
  `ALTER TABLE channel_policy_history ADD COLUMN IF NOT EXISTS ambient_enabled BOOLEAN`,
  `CREATE TABLE IF NOT EXISTS file_artifacts(
      id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'file',
      owner_scope_id TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL,
      mimetype TEXT NOT NULL, size_bytes BIGINT NOT NULL,
      blob_key TEXT, sha256 TEXT, direction TEXT NOT NULL,
      created_by TEXT NOT NULL, created_in_scope TEXT,
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE, source TEXT NOT NULL DEFAULT 'live'
    )`,
]

const SEED: Array<[string, string, unknown[]]> = [
  ['sessions', `INSERT INTO sessions (id, type, scope_id, thread_ref, created_at, title, surface, last_activity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    ['s1', 'im', 'org:default', 'slack:C1:1700000000.000100', 1700000000000, 'Legacy title from session', 'slack', 1700003600000]],
  ['sessions', `INSERT INTO sessions (id, type, scope_id, thread_ref, created_at) VALUES ($1,$2,$3,$4,$5)`,
    ['s2', 'im', 'org:default', 'slack:C1:1700000000.000200', 1700000900000]],
  ['participants', `INSERT INTO participants (session_id, principal_id, valid_from, valid_to, title, archived, pinned, color) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    ['s1', 'U1', 1700000000000, null, 'Owner view title', false, true, '#ff0000']],
  ['participants', `INSERT INTO participants (session_id, principal_id, valid_from, valid_to, title) VALUES ($1,$2,$3,$4,$5)`,
    ['s1', 'U2', 1700000100000, null, 'Second view title']],
  ['participants', `INSERT INTO participants (session_id, principal_id, valid_from, valid_to, archived, pinned) VALUES ($1,$2,$3,$4,$5,$6)`,
    ['s2', 'U2', 1700000900000, null, true, false]],
  ['session_entries', `INSERT INTO session_entries (session_id, seq, parent_seq, type, payload, scope_label, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    ['s1', 1, null, 'user', 'hello robot', 'org:default', 1700000005000]],
  ['session_entries', `INSERT INTO session_entries (session_id, seq, parent_seq, type, payload, scope_label, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    ['s1', 2, 1, 'assistant', 'hi human', 'org:default', 1700000009000]],
  ['session_entries', `INSERT INTO session_entries (session_id, seq, parent_seq, type, payload, scope_label, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    ['s2', 1, null, 'user', 'second thread', 'org:default', 1700000905000]],
  ['session_tape', `INSERT INTO session_tape (session_id, seq, kind, harness, payload, scope_label, bare_text, ts, change_time, hidden, overheard, author, entry_seq, covers_entry_seq, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    ['s1', 1, 'message', 'pi', '{"role":"user"}', 'org:default', 'hello robot', '1700000005.000100', '1700000005.000100', false, false, 'U1', 1, null, 1700000005000]],
  ['session_tape', `INSERT INTO session_tape (session_id, seq, kind, harness, payload, scope_label, hidden, overheard, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    ['s1', 2, 'context_event', 'pi', '{"kind":"compaction"}', 'org:default', true, true, 1700000010000]],
  ['session_tape', `INSERT INTO session_tape (session_id, seq, kind, payload, scope_label, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    ['s2', 1, 'message', '{"role":"user"}', 'org:default', 1700000905000]],
  ['llm_prompt_envelopes', `INSERT INTO llm_prompt_envelopes (hash, body, created_at) VALUES ($1,$2,$3)`,
    ['hash1', 'PROMPT ENVELOPE BODY', 1700000004000]],
  ['session_llm_requests', `INSERT INTO session_llm_requests (id, session_id, turn_seq, step, model, scope_label, request, truncated, created_at, ttft_ms, duration_ms, step_gap_ms, tool_wall_json, usage_json, transport_json, gap_phases_json, prompt_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    ['l1', 's1', 1, 1, 'glm-5.2', 'org:default', '{"messages":[]}', false, 1700000006000, 120, 900, 30, '[]', '{"input":10}', '{"wire":"openai"}', '[]', 'hash1']],
  ['session_llm_requests', `INSERT INTO session_llm_requests (id, session_id, turn_seq, step, model, scope_label, request, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    ['l2', 's2', 1, 1, 'glm-5.2', 'org:default', null, 1700000906000]],
  ['runs', `INSERT INTO runs (id, session_id, status, request, result, attempts, created_at, finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    ['r1', 's1', 'complete', 'hello robot', 'hi human', 1, 1700000007000, 1700000010000]],
  ['run_activity', `INSERT INTO run_activity (run_id, seq, parent_seq, type, payload, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    ['r1', 1, null, 'turn_start', '{"ok":true}', 1700000007000]],
  ['run_signals', `INSERT INTO run_signals (run_id, kind, text, created_at, consumed_at) VALUES ($1,$2,$3,$4,$5)`,
    ['r1', 'interrupt', 'stop', 1700000008000, 1700000008500]],
  ['instance_heartbeats', `INSERT INTO instance_heartbeats (instance_id, build_sha, started_at, beat_at) VALUES ($1,$2,$3,$4)`,
    ['i1', 'deadbeef', 1700000000000, new Date('2026-01-01T00:00:00Z').toISOString()]],
  ['memory_revisions', `INSERT INTO memory_revisions (scope_id, seq, op, body, author, at) VALUES ($1,$2,$3,$4,$5,$6)`,
    ['personal:U1', 1, 'add', 'User likes prime numbers', 'agent', 1700000010000]],
  ['tasks', `INSERT INTO tasks (id, session_id, origin_run_id, title, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    ['t1', 's1', 'r1', 'write primes script', 'completed', 1700000007100, 1700000009900]],
  ['task_events', `INSERT INTO task_events (task_id, run_id, type, from_status, to_status, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    ['t1', 'r1', 'created', null, 'pending', 1700000007100]],
  ['process_sessions', `INSERT INTO process_sessions (process_id, scope_id, kind, command, started_at, expires_at, status, session_ref, run_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    ['p1', 'org:default', 'exec', 'python3 x.py', 1700000008000, 1700000108000, 'running', 'sess:1', 'r1']],
  ['acl_grants', `INSERT INTO acl_grants (owner_scope_id, path, grantee_scope_id, permission, granted_by) VALUES ($1,$2,$3,$4,$5)`,
    ['personal:U1', '/skills', 'org:default', 'read', 'U1']],
  ['acl_grants_version', `INSERT INTO acl_grants_version (only_row, v) VALUES (TRUE, $1)`, [7]],
  ['admin_grants', `INSERT INTO admin_grants (principal_id, scope_id, role, granted_by, created_at) VALUES ($1,$2,$3,$4,$5)`,
    ['U1', 'org:default', 'org_admin', 'bootstrap', 1700000000000]],
  ['audit_log', `INSERT INTO audit_log (at, principal_id, action, resource, scope_label, status, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [1700000010000, 'U1', 'keychain.grant', 'keychain:aws', 'org:default', 'ok', null]],
  ['directory_members', `INSERT INTO directory_members (org_id, principal_id, display_name, display_name_lc, type) VALUES ($1,$2,$3,$4,$5)`,
    ['org1', 'U1', 'Ada Lovelace', 'ada lovelace', 'internal']],
  ['directory_members', `INSERT INTO directory_members (org_id, principal_id, display_name, display_name_lc, type) VALUES ($1,$2,$3,$4,$5)`,
    ['org1', 'U2', 'Grace Hopper', 'grace hopper', 'guest']],
  ['directory_members', `INSERT INTO directory_members (org_id, principal_id, display_name, display_name_lc, type) VALUES ($1,$2,$3,$4,$5)`,
    ['org1', 'U3', 'Alan T', 'alan t', 'internal']],
  ['directory_channels', `INSERT INTO directory_channels (org_id, channel_id, name, name_lc, is_private, is_external, roster_known) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    ['org1', 'C1', 'general', 'general', false, false, true]],
  ['directory_channels', `INSERT INTO directory_channels (org_id, channel_id, name, name_lc, is_private, is_external, roster_known) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    ['org1', 'C2', 'secret', 'secret', true, true, false]],
  ['directory_channel_members', `INSERT INTO directory_channel_members (org_id, channel_id, principal_id) VALUES ($1,$2,$3)`,
    ['org1', 'C1', 'U1']],
  ['directory_channel_members', `INSERT INTO directory_channel_members (org_id, channel_id, principal_id) VALUES ($1,$2,$3)`,
    ['org1', 'C1', 'U2']],
  ['directory_groups', `INSERT INTO directory_groups (org_id, group_id, roster_known) VALUES ($1,$2,$3)`,
    ['org1', 'G1', true]],
  ['directory_group_members', `INSERT INTO directory_group_members (org_id, group_id, principal_id) VALUES ($1,$2,$3)`,
    ['org1', 'G1', 'U3']],
  ['directory_sync', `INSERT INTO directory_sync (org_id, members_hash, channels_hash, groups_hash, channel_members_synced, updated_at, members_synced_at, channels_synced_at, groups_synced_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    ['org1', 'mh', 'ch', 'gh', true, 1700000050000, 1700000050000, 1700000040000, 1700000030000]],
  ['environments', `INSERT INTO environments (id, org_id, name, owner_actor_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    ['e1', 'org1', 'staging', 'U1', 1700000000000, 1700000000000]],
  ['ambient_judgments', `INSERT INTO ambient_judgments (org_id, surface, container, decision, reason, model, latency_ms, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    ['org1', 'slack', 'C1', 'ignore', 'not actionable', 'glm-5.2', 340, 1700000020000]],
  ['ack_emoji_picks', `INSERT INTO ack_emoji_picks (org_id, surface, channel, ts, outcome, picked, candidates, model, latency_ms, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    ['org1', 'slack', 'C1', '1700000000.000100', 'random', 'eyes', '["eyes","ok"]', null, 0, 1700000001000]],
  ['crons', `INSERT INTO crons (id, json) VALUES ($1,$2)`,
    ['c1', { ownerScopeId: 'org:default', owner: 'U1', createdBy: 'U1', destination: { type: 'slack', target: 'C1' }, enabled: true, createdAt: 1700000000000, lastFiredAt: 1700003600000, nextFireAt: 1700007200000, lastAttemptAt: 1700003600000, schedule: { cron: '0 12 * * *', timezone: 'UTC' }, title: 'Daily standup', action: 'summarize yesterday', fireLog: [{ fireKey: 'k0', threadRef: 'x', firedAt: 1 }], archived: false }]],
  ['crons', `INSERT INTO crons (id, json) VALUES ($1,$2)`,
    ['c2', { ownerScopeId: 'org:default', owner: 'U2', createdBy: 'U2', enabled: false, createdAt: 1700000900000, schedule: { everyMs: 60000, firstFireAt: 1700000900000 }, message: 'pulse' }]],
  ['cron_fire_log', `INSERT INTO cron_fire_log (cron_id, fire_key, fired_at, json) VALUES ($1,$2,$3,$4)`,
    ['c1', '1700003600000', 1700003600000, { fireKey: '1700003600000', threadRef: 'slack:C1:t', firedAt: 1700003600000, status: 'complete' }]],
  ['cron_fire_log', `INSERT INTO cron_fire_log (cron_id, fire_key, fired_at, json) VALUES ($1,$2,$3,$4)`,
    ['c1', '1700000000000', 1700000000000, { fireKey: '1700000000000', threadRef: 'slack:C1:t0', firedAt: 1700000000000 }]],
  ['skills', `INSERT INTO skills (id, json) VALUES ($1,$2)`,
    ['sk1', { id: 'sk1', scopeId: 'org:default', manifest: { name: 'primes', description: 'prime helper', requiredCapabilities: ['exec'], body: 'Use python to reason about primes.' }, signature: 'sig1', status: 'published', createdBy: 'U1', version: 3, grantedCapabilities: ['exec'], approvals: ['U2'], createdAt: 1700000000000, updatedAt: 1700000100000, lastUsedAt: 1700000200000 }]],
  ['skills', `INSERT INTO skills (id, json) VALUES ($1,$2)`,
    ['sk-bad', { id: 'sk-bad', scopeId: 'org:default', manifest: { name: '' }, status: 'draft', createdBy: 'U1', version: 1 }]],
  ['skill_bundles', `INSERT INTO skill_bundles (id, json) VALUES ($1,$2)`, ['b1', { name: 'bundle-one', files: 2 }]],
  ['skill_packs', `INSERT INTO skill_packs (id, json) VALUES ($1,$2)`, ['pk1', { packId: 'pack-one', commit: 'abc' }]],
  ['monitors', `INSERT INTO monitors (id, json) VALUES ($1,$2)`, ['m1', { scopeId: 'org:default', kind: 'log', pattern: 'ERROR' }]],
  ['model_credentials', `INSERT INTO model_credentials (id, json) VALUES ($1,$2)`, ['mc1', { provider: 'anthropic', mounted: true }]],
  ['custom_model_providers', `INSERT INTO custom_model_providers (id, json) VALUES ($1,$2)`, ['cp1', { id: 'sensenova', protocol: 'openai' }]],
  ['slack_installation', `INSERT INTO slack_installation (id, json) VALUES ($1,$2)`, ['org1', { botToken: 'xoxb-sealed', teamId: 'T1' }]],
  ['approvals', `INSERT INTO approvals (id, json) VALUES ($1,$2)`, ['req:1', { sessionId: 's1', command: 'rm -rf /tmp/x', kind: 'approval', createdAt: 1700000050000 }]],
  ['approval_grants', `INSERT INTO approval_grants (id, json) VALUES ($1,$2)`, ['U1:git push', { session: true, always: false }]],
  ['webhooks', `INSERT INTO webhooks (id, json) VALUES ($1,$2)`, ['w1', { url: 'https://example.com/hook', secret: 'shhh' }]],
  ['channel_policy', `INSERT INTO channel_policy (org_id, container, orders, bots, ambient_enabled, set_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    ['default-org', 'C123', 'summarize daily', '{}', true, 'U1', 1700000060000]],
  ['channel_policy_history', `INSERT INTO channel_policy_history (org_id, container, orders, bots, ambient_enabled, set_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    ['default-org', 'C123', 'summarize daily', '{}', true, 'U1', 1700000060000]],
  ['file_artifacts', `INSERT INTO file_artifacts (id, kind, owner_scope_id, path, name, mimetype, size_bytes, blob_key, sha256, direction, created_by, created_in_scope, created_at, updated_at, enabled, source)
     VALUES ('fa1', 'file', 'personal:U1', 'artifacts/fa1/notes.txt', 'notes.txt', 'text/plain', 12, 'files/deadbeef', 'deadbeef', 'in', 'U1', NULL, 1700000070000, 1700000070000, TRUE, 'live')`, []],
]

async function seedSource(): Promise<void> {
  console.log('phase 2: seed qm-shaped source dataset')
  const src = createPgPool(SOURCE_URL!, [])
  try {
    for (const stmt of DDL) await src.q(stmt)
    for (const [, stmt, params] of SEED) {
      await src.q(stmt, params)
    }
    const counts: Row = {}
    for (const t of ['sessions', 'participants', 'session_entries', 'session_tape', 'session_llm_requests', 'crons', 'skills', 'directory_members']) {
      const rows = await src.q(`SELECT COUNT(*)::BIGINT AS n FROM "${t}"`)
      counts[t] = Number(rows[0]!.n)
    }
    console.log(`  seeded: ${JSON.stringify(counts)}`)
  } finally {
    await src.close()
  }
}

// ---- phase 3-6: drive the migrator CLI -------------------------------------------

interface RunOutcome {
  code: number
  stdout: string
}

function runMigrator(args: string[]): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', path.join(ROOT, 'scripts/migrate-qm.ts'), ...args], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      process.stdout.write(d)
    })
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString()
      process.stderr.write(d)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: out }))
  })
}

interface TargetState {
  [table: string]: number
}

async function targetCounts(tables: string[]): Promise<TargetState> {
  const target = createPgPool(TARGET_URL!, [])
  try {
    const state: TargetState = {}
    for (const t of tables) {
      const exists = await target.q(`SELECT 1 AS one FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [t])
      state[t] = exists.length > 0 ? Number((await target.q(`SELECT COUNT(*)::BIGINT AS n FROM "${t}"`))[0]!.n) : -1
    }
    return state
  } finally {
    await target.close()
  }
}

async function targetQuery(text: string, params: unknown[] = []): Promise<Row[]> {
  const target = createPgPool(TARGET_URL!, [])
  try {
    return await target.q(text, params)
  } finally {
    await target.close()
  }
}

async function main(): Promise<void> {
  const seedTables = ['sessions', 'session_entries', 'participants', 'session_tape', 'llm_requests', 'session_leases', 'runs', 'run_activity', 'run_signals', 'instance_heartbeats', 'memory_revisions', 'tasks', 'task_events', 'process_sessions', 'acl_grants', 'acl_grants_version', 'admin_grants', 'audit_log', 'directory_people', 'directory_spaces', 'directory_space_members', 'directory_rosters', 'directory_sync_state', 'crons', 'cron_fire_log', 'skills', 'skill_bundles', 'skill_packs', 'monitors', 'model_credentials', 'custom_model_providers', 'admin_slack_installation', 'turn_metrics', 'error_events', 'credential_usage', 'egress_events', 'source_auth_replay', 'approvals', 'ambient_judgments', 'ack_emoji_picks', 'channel_policy', 'channel_policy_history', 'file_artifacts', 'deliveries', 'webhooks']

  await ensureTargetSchema()
  await seedSource()

  const seedPath = path.join(ROOT, 'docs/migration-seed.sample.json')

  console.log('phase 3: dry run (must roll back)')
  const dry = await runMigrator([`--source=${SOURCE_URL}`, `--target=${TARGET_URL}`, `--export-seed=${seedPath}`])
  check('dry run exits 0', dry.code === 0)
  check('dry run keeps target empty', (await targetCounts(['sessions', 'crons', 'skills', 'directory_people'])).sessions === 0)
  const fs = await import('node:fs')
  check('seed file written', fs.existsSync(seedPath))
  if (fs.existsSync(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as { tables: Record<string, unknown[]> }
    check('seed carries approval_grants', Array.isArray(seed.tables.approval_grants) && seed.tables.approval_grants.length === 1)
    check('seed carries webhooks', Array.isArray(seed.tables.webhooks) && seed.tables.webhooks.length === 1)
  }

  console.log('phase 4: commit')
  const commit = await runMigrator([`--source=${SOURCE_URL}`, `--target=${TARGET_URL}`, '--commit'])
  check('commit exits 0', commit.code === 0)

  console.log('phase 5: verify migrated state')
  const state = await targetCounts(seedTables)
  // 20.0 twin sweep: a durable boot lands every twin table, so the
  // migrator carries their seeded rows. Only `instance_heartbeats` stays
  // un-ensured (-1, TRUNCATE_ONLY note path by design).
  const expect: TargetState = {
    sessions: 2,
    session_entries: 3,
    participants: 3,
    session_tape: 3,
    llm_requests: 2,
    session_leases: 0,
    runs: 1,
    run_activity: 1,
    run_signals: 1,
    instance_heartbeats: -1,
    memory_revisions: 1,
    tasks: 1,
    task_events: 1,
    process_sessions: 1,
    acl_grants: 1,
    acl_grants_version: 1,
    admin_grants: 1,
    audit_log: 1,
    directory_people: 3,
    directory_spaces: 3,
    directory_space_members: 3,
    directory_rosters: 2,
    directory_sync_state: 3,
    crons: 2,
    cron_fire_log: 2,
    skills: 1,
    skill_bundles: 1,
    skill_packs: 1,
    monitors: 1,
    model_credentials: 1,
    custom_model_providers: 1,
    admin_slack_installation: 1,
    ambient_judgments: 1,
    ack_emoji_picks: 1,
    // 20.0 twins landed: these targets now exist at boot and the
    // migrator carries their rows (drain-class tables stay empty).
    channel_policy: 1,
    channel_policy_history: 1,
    file_artifacts: 1,
    deliveries: 0,
    webhooks: 0,
  }
  for (const [table, want] of Object.entries(expect)) {
    check(`${table} = ${want}`, state[table] === want, `got ${state[table]}`)
  }

  const ownerFold = await targetQuery(`SELECT title, pinned, archived FROM sessions WHERE id = 's1'`)
  check('session s1 folds owner participant view-state', ownerFold[0]?.title === 'Legacy title from session' && ownerFold[0]?.pinned === true)
  const fold2 = await targetQuery(`SELECT archived, title FROM sessions WHERE id = 's2'`)
  check('session s2 folds archived participant', fold2[0]?.archived === true && fold2[0]?.title === null)
  const tape = await targetQuery(`SELECT meta FROM session_tape WHERE session_id = 's1' AND seq = 1`)
  const tapeMeta = tape[0]?.meta != null ? (typeof tape[0].meta === 'string' ? JSON.parse(String(tape[0].meta)) : tape[0].meta) : {}
  check('tape meta carries camelCase TapeMeta', tapeMeta.bareText === 'hello robot' && tapeMeta.author === 'U1' && tapeMeta.ts === '1700000005.000100')
  const tape2 = await targetQuery(`SELECT meta FROM session_tape WHERE session_id = 's1' AND seq = 2`)
  const tape2Meta = tape2[0]?.meta != null ? (typeof tape2[0].meta === 'string' ? JSON.parse(String(tape2[0].meta)) : tape2[0].meta) : {}
  check('tape flags migrate into meta', tape2Meta.hidden === true && tape2Meta.overheard === true)
  const llm = await targetQuery(`SELECT prompt_envelope, tool_wall_ms, usage FROM llm_requests WHERE id = 'l1'`)
  check('llm envelope joined + json tail columns renamed', llm[0]?.prompt_envelope === 'PROMPT ENVELOPE BODY' && llm[0]?.tool_wall_ms === '[]' && llm[0]?.usage === '{"input":10}')
  const people = await targetQuery(`SELECT provider_user_id, type FROM directory_people WHERE provider_user_id = 'U2'`)
  check('directory people map provider + type', people[0]?.provider_user_id === 'U2' && people[0]?.type === 'guest')
  const groups = await targetQuery(`SELECT kind FROM directory_spaces WHERE space_id = 'G1'`)
  check('qm group becomes kind=group space', groups[0]?.kind === 'group')
  const cron = await targetQuery(`SELECT owner_id, schedule, destination, enabled FROM crons WHERE id = 'c1'`)
  const cronSchedule = cron[0]?.schedule != null ? (typeof cron[0].schedule === 'string' ? JSON.parse(String(cron[0].schedule)) : cron[0].schedule) : {}
  const cronDest = cron[0]?.destination != null ? (typeof cron[0].destination === 'string' ? JSON.parse(String(cron[0].destination)) : cron[0].destination) : {}
  check('cron blob lands as columns', cron[0]?.owner_id === 'U1' && cronSchedule.cron === '0 12 * * *' && cronDest.target === 'C1' && cron[0]?.enabled === true)
  const skill = await targetQuery(`SELECT name, body, granted_capabilities FROM skills WHERE id = 'sk1'`)
  const granted = skill[0]?.granted_capabilities != null ? (typeof skill[0].granted_capabilities === 'string' ? JSON.parse(String(skill[0].granted_capabilities)) : skill[0].granted_capabilities) : []
  check('skill blob lands as columns', skill[0]?.name === 'primes' && String(skill[0]?.body).startsWith('Use python') && Array.isArray(granted) && granted[0] === 'exec')
  const journal = await targetQuery(`SELECT COUNT(*)::BIGINT AS n, COUNT(DISTINCT run_id)::BIGINT AS runs FROM qm_migration_journal`)
  check('journal records the commit run', Number(journal[0]?.n) >= 1 && Number(journal[0]?.runs) === 1)

  console.log('phase 6: rollback')
  const rollback = await runMigrator([`--target=${TARGET_URL}`, '--rollback'])
  check('rollback exits 0', rollback.code === 0)
  const cleared = await targetCounts([...seedTables, 'qm_migration_journal'])
  const leftovers = Object.entries(cleared).filter(([, n]) => n > 0)
  check('target clean after rollback', leftovers.length === 0, JSON.stringify(leftovers))

  fs.rmSync(seedPath, { force: true })
  if (failures > 0) {
    console.error(`migration rehearsal: ${failures} check(s) FAILED`)
    process.exit(1)
  }
  console.log('migration rehearsal: PASS')
}

main().catch((error) => {
  console.error('migration rehearsal:', error)
  process.exit(1)
})
