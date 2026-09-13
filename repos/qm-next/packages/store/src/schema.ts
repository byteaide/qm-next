/**
 * Schema DDL for the M1 store surface: runs queue and
 * session/entry/lease/tape/LLM-request tables. Fresh-install statements
 * only — qm's legacy migrations stay behind.
 */
export const RUN_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS runs(
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
      request TEXT NOT NULL, result TEXT, delivery_state TEXT, idempotency_key TEXT UNIQUE,
      attempts INT NOT NULL DEFAULT 0, error_attempts INT NOT NULL DEFAULT 0,
      max_attempts INT NOT NULL DEFAULT 3,
      lease_token TEXT, lease_expires_at BIGINT, worker_id TEXT,
      created_at BIGINT NOT NULL, started_at BIGINT, finished_at BIGINT, seq BIGSERIAL
    )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_status_created_seq ON runs(status, created_at, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_session_active_created
      ON runs(session_id, created_at DESC) WHERE status IN ('pending','running')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_running_per_session ON runs(session_id) WHERE status='running'`,
]

export const SESSION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sessions(
      id TEXT PRIMARY KEY, type TEXT NOT NULL, scope_id TEXT NOT NULL,
      thread_ref TEXT UNIQUE NOT NULL, created_at BIGINT NOT NULL,
      title TEXT, channel_name TEXT, surface TEXT, last_activity BIGINT
    )`,
  `CREATE TABLE IF NOT EXISTS session_entries(
      session_id TEXT NOT NULL, seq INT NOT NULL, parent_seq INT,
      type TEXT NOT NULL, payload TEXT, scope_label TEXT NOT NULL, created_at BIGINT NOT NULL,
      PRIMARY KEY(session_id, seq)
    )`,
  `CREATE INDEX IF NOT EXISTS session_entries_session_seq ON session_entries(session_id, seq)`,
  `CREATE TABLE IF NOT EXISTS participants(
      session_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      valid_from BIGINT NOT NULL, valid_to BIGINT,
      valid_from_seq INT, valid_to_seq INT,
      PRIMARY KEY(session_id, principal_id)
    )`,
  `CREATE TABLE IF NOT EXISTS session_leases(
      session_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at BIGINT NOT NULL,
      holder TEXT, acquired_at BIGINT
    )`,
  `CREATE TABLE IF NOT EXISTS session_tape(
      session_id TEXT NOT NULL, seq INT NOT NULL,
      kind TEXT NOT NULL, payload TEXT, scope_label TEXT NOT NULL, harness TEXT,
      meta TEXT, entry_seq INT, covers_entry_seq INT, created_at BIGINT NOT NULL,
      PRIMARY KEY(session_id, seq)
    )`,
  `CREATE INDEX IF NOT EXISTS session_tape_session_seq ON session_tape(session_id, seq)`,
  `CREATE TABLE IF NOT EXISTS llm_requests(
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_seq INT, step INT NOT NULL,
      model TEXT NOT NULL, scope_label TEXT NOT NULL, created_at BIGINT NOT NULL,
      request TEXT, prompt_hash TEXT, prompt_envelope TEXT, truncated BOOLEAN NOT NULL DEFAULT FALSE,
      ttft_ms BIGINT, duration_ms BIGINT, step_gap_ms BIGINT, tool_wall_ms TEXT,
      gap_phases TEXT, usage TEXT, transport TEXT
    )`,
  `CREATE INDEX IF NOT EXISTS llm_requests_session_created ON llm_requests(session_id, created_at)`,
]
