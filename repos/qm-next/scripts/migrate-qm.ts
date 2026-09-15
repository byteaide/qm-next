/**
 * qm → qm-next data migration (p002 P5 19.2).
 *
 * Reads a qm production Postgres (read-only) and lands data into an empty
 * qm-next Postgres whose schema was created by the qm-next stores themselves
 * (durable-by-default: boot qm-next against the target before migrating).
 *
 * Shapes and decisions per table: docs/migration.md Part A. Summary:
 *   - entity copies: identical end-state DDL, columns = runtime intersection
 *   - session domain: sessions fold owner-participant view state; tape flat
 *     columns become TapeMeta JSON; session_llm_requests + llm_prompt_envelopes
 *     become llm_requests
 *   - directory: Slack-shaped org tables become provider-neutral people/spaces
 *   - crons/skills: DurableMap JSON blobs become real columns
 *   - config-family blobs: exported to a JSON seed file (--export-seed=...)
 *   - durable-map twin tables: row-for-row JSON copies where the target table
 *     exists (missing target table = PG-twin gap, skipped with a note)
 *
 * Safety model:
 *   - default is a dry run: every write happens inside one target transaction
 *     that is rolled back at the end
 *   - --commit commits and records a per-table journal (qm_migration_journal)
 *   - --rollback clears the tables of the latest journal run (reverse order)
 *   - refusal to migrate into non-empty target tables (--force overrides)
 *
 * Run from repos/qm-next:
 *   node --import tsx/esm scripts/migrate-qm.ts --source $QM_PG_URL --target $NEXT_PG_URL [--commit]
 */
import { createPgPool, errMessage, type PgPool } from '../packages/store/src/pg-pool.ts'

type Row = Record<string, unknown>
type Q = (text: string, params?: unknown[]) => Promise<Row[]>

interface Args {
  source?: string
  target?: string
  sourceProvider: string
  commit: boolean
  verifyOnly: boolean
  rollback: boolean
  force: boolean
  tables?: string[]
  exportSeed?: string
  batch: number
  orgFallback: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = { sourceProvider: 'slack', commit: false, verifyOnly: false, rollback: false, force: false, batch: 200, orgFallback: 'org:default' }
  for (const raw of argv) {
    const eq = raw.indexOf('=')
    const flag = eq === -1 ? raw : raw.slice(0, eq)
    const value = eq === -1 ? undefined : raw.slice(eq + 1)
    switch (flag) {
      case '--source':
        if (value === undefined) throw new Error('--source needs a value')
        args.source = value
        break
      case '--target':
        if (value === undefined) throw new Error('--target needs a value')
        args.target = value
        break
      case '--source-provider':
        if (value === undefined) throw new Error('--source-provider needs a value')
        args.sourceProvider = value
        break
      case '--commit': args.commit = true; break
      case '--verify-only': args.verifyOnly = true; break
      case '--rollback': args.rollback = true; break
      case '--force': args.force = true; break
      case '--tables':
        if (value === undefined) throw new Error('--tables needs a value')
        args.tables = String(value).split(',').map((t) => t.trim()).filter(Boolean)
        break
      case '--export-seed':
        if (value === undefined) throw new Error('--export-seed needs a value')
        args.exportSeed = value
        break
      case '--batch':
        args.batch = Number(value) || args.batch
        break
      case '--org-fallback':
        if (value === undefined) throw new Error('--org-fallback needs a value')
        args.orgFallback = value
        break
      default: throw new Error(`unknown flag: ${flag}`)
    }
  }
  if (!args.rollback && !args.target) throw new Error('--target is required (or use --rollback)')
  if (!args.rollback && !args.source) throw new Error('--source is required')
  return args
}

interface StepResult {
  table: string
  verifyTable?: string | undefined
  mode: string
  src: number
  dst: number
  note?: string | undefined
}

// ---- plan (docs/migration.md Part A) -------------------------------------------

const TRUNCATE_ONLY = ['session_leases', 'instance_heartbeats']

// Queues drained before cutover (runbook hard precondition): the durable
// twin exists in qm-next (20.0) but no rows are expected to carry — qm's
// delivery row shape (destination/text) does not translate to the
// operation-carrier queue, and anything still queued must be delivered or
// dropped before the switch anyway.
const DRAINED = ['deliveries']

const ENTITY_COPIES = [
  'memory_revisions',
  'tasks',
  'task_events',
  'process_sessions',
  'acl_grants',
  'acl_grants_version',
  'admin_grants',
  'audit_log',
  'run_activity',
  'run_signals',
  'ambient_judgments',
  'ack_emoji_picks',
  'runs',
  'turn_metrics',
  'error_events',
  'credential_usage',
  'egress_events',
  'channel_policy',
  'channel_policy_history',
  'file_artifacts',
]

const BLOB_COPIES: Array<[string, string]> = [
  ['skill_bundles', 'skill_bundles'],
  ['skill_packs', 'skill_packs'],
  ['ambient_cursors', 'ambient_cursors'],
  ['monitors', 'monitors'],
  ['slack_installation', 'admin_slack_installation'],
  ['keychain_credentials', 'keychain_credentials'],
  ['keychain_grants', 'keychain_grants'],
  ['keychain_asks', 'keychain_asks'],
  ['secret_drops', 'secret_drops'],
  ['credential_liveness', 'credential_liveness'],
  ['model_credentials', 'model_credentials'],
  ['custom_model_providers', 'custom_model_providers'],
  ['device_flow_cutover', 'device_flow_cutover'],
  ['device_flow_cutover_resets', 'device_flow_cutover_resets'],
  ['mcp_servers', 'mcp_servers'],
  ['connector_status', 'connector_status'],
  ['connector_clients', 'connector_clients'],
  ['oauth_flows', 'oauth_flows'],
  ['consent_links', 'consent_links'],
  ['browser_sessions', 'browser_sessions'],
  ['insight_cursors', 'insight_cursors'],
]

const SEED_TABLES = [
  'approval_grants',
  'approval_grant_modes',
  'approved_harness_configs',
  'base_model_configs',
  'browse_max_steps_configs',
  'browse_model_configs',
  'auto_flagger_configs',
  'branding_configs',
  'command_policies',
  'deployment_identity',
  'egress_policies',
  'people_directory_urls',
  'channel_header_pin_flag',
  'external_slack_participants_flag',
  'individual_model_auth_flag',
  'interactive_fast_mode_flag',
  'org_ambient_flag',
  'unfulfilled_insights_flag',
  'turn_wall_clock_configs',
  'webui_model_configs',
  'web_ui_state',
  'soul_configs',
  'soul_history',
  'security_postures',
  'projects',
  'deployments',
  'deploy_git_repos',
  'aws_deploy_bodies',
  'aws_sandbox_bodies',
  'porter_deploy_bodies',
  'deployment_layer',
  'sandbox_routing',
  'webhooks',
  'environments',
  'environment_attachments',
]

// ---- small helpers --------------------------------------------------------------

async function tableExists(q: Q, table: string): Promise<boolean> {
  const rows = await q(`SELECT 1 AS one FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [table])
  return rows.length > 0
}

async function tableColumns(q: Q, table: string): Promise<string[]> {
  const rows = await q(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  )
  return rows.map((r) => String(r.column_name))
}

async function countRows(q: Q, table: string): Promise<number> {
  const rows = await q(`SELECT COUNT(*)::BIGINT AS n FROM "${table}"`)
  return Number(rows[0]?.n ?? 0)
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

interface Exec {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Row[] }>
}

async function insertRows(exec: Exec, table: string, cols: string[], rows: Row[], batch: number): Promise<number> {
  const colList = cols.map((c) => `"${c}"`).join(', ')
  let written = 0
  for (const part of chunk(rows, batch)) {
    if (part.length === 0) continue
    const values: unknown[] = []
    const tuples = part.map((row) => {
      const placeholders = cols.map((c) => {
        values.push(row[c] ?? null)
        return `$${values.length}`
      })
      return `(${placeholders.join(', ')})`
    })
    await exec.query(`INSERT INTO "${table}" (${colList}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`, values)
    written += part.length
  }
  return written
}

async function copyIntersected(src: PgPool, exec: Exec, table: string, batch: number): Promise<{ src: number; dst: number }> {
  const srcCols = new Set(await tableColumns(src.q, table))
  const dstCols = await tableColumns((t, p) => exec.query(t, p).then((r) => r.rows), table)
  const cols = dstCols.filter((c) => srcCols.has(c))
  if (cols.length === 0) throw new Error(`${table}: no column intersection between source and target`)
  const rows = await src.q(`SELECT * FROM "${table}"`)
  const projected = rows.map((row) => {
    const out: Row = {}
    for (const c of cols) out[c] = row[c]
    return out
  })
  const dst = await insertRows(exec, table, cols, projected, batch)
  return { src: rows.length, dst }
}

function asInt(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function jsonObj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

// ---- transforms -------------------------------------------------------------------

async function migrateSessionDomain(src: PgPool, exec: Exec, args: Args): Promise<StepResult[]> {
  const results: StepResult[] = []
  const sessions = await src.q(`SELECT * FROM sessions`)
  const participants = await src.q(`SELECT * FROM participants`)
  const bySession = new Map<string, Row[]>()
  for (const p of participants) {
    const list = bySession.get(String(p.session_id)) ?? []
    list.push(p)
    bySession.set(String(p.session_id), list)
  }
  const sessionCols = ['id', 'type', 'scope_id', 'thread_ref', 'created_at', 'title', 'channel_name', 'surface', 'last_activity', 'archived', 'pinned', 'color']
  const sessionRows = sessions.map((s) => {
    const all = bySession.get(String(s.id)) ?? []
    const live = all.filter((p) => p.valid_to === null || p.valid_to === undefined)
    const owner = (live.length > 0 ? live : all).slice().sort((a, b) => Number(a.valid_from ?? 0) - Number(b.valid_from ?? 0))[0]
    return {
      id: s.id,
      type: s.type,
      scope_id: s.scope_id,
      thread_ref: s.thread_ref,
      created_at: s.created_at,
      title: s.title ?? owner?.title ?? null,
      channel_name: s.channel_name ?? null,
      surface: s.surface ?? null,
      last_activity: s.last_activity ?? null,
      archived: owner?.archived === true,
      pinned: owner?.pinned === true,
      color: owner?.color ?? null,
    }
  })
  await insertRows(exec, 'sessions', sessionCols, sessionRows, args.batch)
  results.push({ table: 'sessions (+participant view-state fold)', verifyTable: 'sessions', mode: 'transform', src: sessions.length, dst: sessionRows.length })

  const entries = await src.q(`SELECT * FROM session_entries`)
  const entryCols = ['session_id', 'seq', 'parent_seq', 'type', 'payload', 'scope_label', 'created_at']
  const entryRows = entries.map((e) => {
    const out: Row = {}
    for (const c of entryCols) out[c] = e[c] ?? null
    return out
  })
  const entryDst = await insertRows(exec, 'session_entries', entryCols, entryRows, args.batch)
  results.push({ table: 'session_entries', verifyTable: 'session_entries', mode: 'copy', src: entries.length, dst: entryDst })

  const participantCols = ['session_id', 'principal_id', 'valid_from', 'valid_to', 'valid_from_seq', 'valid_to_seq']
  const participantRows = participants.map((p) => {
    const out: Row = {}
    for (const c of participantCols) out[c] = p[c] ?? null
    return out
  })
  const participantDst = await insertRows(exec, 'participants', participantCols, participantRows, args.batch)
  results.push({ table: 'participants (view-state columns folded into sessions)', verifyTable: 'participants', mode: 'transform', src: participants.length, dst: participantDst })

  const tape = await src.q(`SELECT * FROM session_tape`)
  const tapeCols = ['session_id', 'seq', 'kind', 'payload', 'scope_label', 'harness', 'meta', 'entry_seq', 'covers_entry_seq', 'created_at']
  const tapeRows = tape.map((t) => {
    const meta: Record<string, unknown> = {}
    if (t.bare_text !== null && t.bare_text !== undefined) meta.bareText = t.bare_text
    if (t.ts !== null && t.ts !== undefined) meta.ts = t.ts
    if (t.change_time !== null && t.change_time !== undefined) meta.changeTime = t.change_time
    if (t.hidden === true) meta.hidden = true
    if (t.overheard === true) meta.overheard = true
    if (t.author !== null && t.author !== undefined) meta.author = t.author
    return {
      session_id: t.session_id,
      seq: t.seq,
      kind: t.kind,
      payload: t.payload ?? null,
      scope_label: t.scope_label,
      harness: t.harness ?? null,
      meta: Object.keys(meta).length > 0 ? JSON.stringify(meta) : null,
      entry_seq: asInt(t.entry_seq),
      covers_entry_seq: asInt(t.covers_entry_seq),
      created_at: t.created_at,
    }
  })
  const tapeDst = await insertRows(exec, 'session_tape', tapeCols, tapeRows, args.batch)
  results.push({ table: 'session_tape (flat extras → TapeMeta json)', verifyTable: 'session_tape', mode: 'transform', src: tape.length, dst: tapeDst })

  const envelopes = new Map<string, string>()
  if (await tableExists(src.q, 'llm_prompt_envelopes')) {
    for (const e of await src.q(`SELECT hash, body FROM llm_prompt_envelopes`)) envelopes.set(String(e.hash), String(e.body))
  }
  const llm = await src.q(`SELECT * FROM session_llm_requests`)
  const llmCols = ['id', 'session_id', 'turn_seq', 'step', 'model', 'scope_label', 'created_at', 'request', 'prompt_hash', 'prompt_envelope', 'truncated', 'ttft_ms', 'duration_ms', 'step_gap_ms', 'tool_wall_ms', 'gap_phases', 'usage', 'transport']
  const llmRows = llm.map((r) => ({
    id: r.id,
    session_id: r.session_id,
    turn_seq: asInt(r.turn_seq),
    step: asInt(r.step) ?? 0,
    model: r.model,
    scope_label: r.scope_label,
    created_at: r.created_at,
    request: r.request ?? null,
    prompt_hash: r.prompt_hash ?? null,
    prompt_envelope: r.prompt_hash !== null && r.prompt_hash !== undefined ? envelopes.get(String(r.prompt_hash)) ?? null : null,
    truncated: r.truncated === true,
    ttft_ms: asInt(r.ttft_ms),
    duration_ms: asInt(r.duration_ms),
    step_gap_ms: asInt(r.step_gap_ms),
    tool_wall_ms: r.tool_wall_json ?? null,
    gap_phases: r.gap_phases_json ?? null,
    usage: r.usage_json ?? null,
    transport: r.transport_json ?? null,
  }))
  const llmDst = await insertRows(exec, 'llm_requests', llmCols, llmRows, args.batch)
  results.push({ table: 'llm_requests (+prompt-envelope fold)', verifyTable: 'llm_requests', mode: 'transform', src: llm.length, dst: llmDst })

  return results
}

async function migrateDirectory(src: PgPool, exec: Exec, args: Args): Promise<StepResult[]> {
  const results: StepResult[] = []
  const provider = args.sourceProvider
  const principalTypes = new Set(['internal', 'guest'])

  const members = await src.q(`SELECT * FROM directory_members`)
  const peopleCols = ['provider', 'provider_user_id', 'display_name', 'email', 'type', 'timezone']
  const peopleRows = members.map((m) => ({
    provider,
    provider_user_id: m.principal_id,
    display_name: m.display_name ?? null,
    email: null,
    type: principalTypes.has(String(m.type)) ? String(m.type) : 'internal',
    timezone: null,
  }))
  const peopleDst = await insertRows(exec, 'directory_people', peopleCols, peopleRows, args.batch)
  results.push({ table: 'directory_people (from directory_members)', verifyTable: 'directory_people', mode: 'transform', src: members.length, dst: peopleDst })

  const channels = await src.q(`SELECT * FROM directory_channels`)
  const groups = await src.q(`SELECT * FROM directory_groups`)
  const spaceCols = ['provider', 'space_id', 'name', 'kind', 'is_private', 'is_external']
  const spaceRows = [
    ...channels.map((c) => ({ provider, space_id: c.channel_id, name: c.name ?? null, kind: 'channel', is_private: c.is_private === true, is_external: c.is_external === true })),
    ...groups.map((g) => ({ provider, space_id: g.group_id, name: null, kind: 'group', is_private: false, is_external: false })),
  ]
  const spaceDst = await insertRows(exec, 'directory_spaces', spaceCols, spaceRows, args.batch)
  results.push({ table: 'directory_spaces (channels + groups)', verifyTable: 'directory_spaces', mode: 'transform', src: channels.length + groups.length, dst: spaceDst })

  const channelMembers = await src.q(`SELECT * FROM directory_channel_members`)
  const groupMembers = await src.q(`SELECT * FROM directory_group_members`)
  const memberCols = ['provider', 'space_id', 'provider_user_id']
  const memberRows = [
    ...channelMembers.map((m) => ({ provider, space_id: m.channel_id, provider_user_id: m.principal_id })),
    ...groupMembers.map((m) => ({ provider, space_id: m.group_id, provider_user_id: m.principal_id })),
  ]
  const memberDst = await insertRows(exec, 'directory_space_members', memberCols, memberRows, args.batch)
  results.push({ table: 'directory_space_members (channel + group members)', verifyTable: 'directory_space_members', mode: 'transform', src: channelMembers.length + groupMembers.length, dst: memberDst })

  const rosterIds = [
    ...channels.filter((c) => c.roster_known === true).map((c) => String(c.channel_id)),
    ...groups.filter((g) => g.roster_known === true).map((g) => String(g.group_id)),
  ]
  const rosterDst = await insertRows(exec, 'directory_rosters', ['provider', 'space_id'], rosterIds.map((spaceId) => ({ provider, space_id: spaceId })), args.batch)
  results.push({ table: 'directory_rosters (roster_known=TRUE spaces)', verifyTable: 'directory_rosters', mode: 'transform', src: rosterIds.length, dst: rosterDst })

  const syncRows: Row[] = []
  for (const row of await src.q(`SELECT * FROM directory_sync`)) {
    syncRows.push(
      { provider, section: 'people', synced_at: asInt(row.members_synced_at) ?? 0 },
      { provider, section: 'spaces', synced_at: Math.max(asInt(row.channels_synced_at) ?? 0, asInt(row.groups_synced_at) ?? 0) },
      { provider, section: 'spaceMembers', synced_at: row.channel_members_synced === true ? asInt(row.updated_at) ?? 0 : 0 },
    )
  }
  const syncDst = await insertRows(exec, 'directory_sync_state', ['provider', 'section', 'synced_at'], syncRows, args.batch)
  results.push({ table: 'directory_sync_state (watermarks → sections)', verifyTable: 'directory_sync_state', mode: 'transform', src: syncRows.length, dst: syncDst })
  return results
}

async function migrateCrons(src: PgPool, exec: Exec, args: Args): Promise<StepResult[]> {
  const results: StepResult[] = []
  const blobs = await src.q(`SELECT id, json FROM crons`)
  const cols = ['id', 'scope_id', 'owner_id', 'owner_type', 'created_by', 'title', 'action', 'message', 'schedule', 'destination', 'enabled', 'archived', 'created_at', 'next_fire_at', 'last_fired_at', 'last_attempt_at', 'recipient_consent']
  const rows = blobs.map((b) => {
    const j = jsonObj(b.json)
    return {
      id: b.id,
      scope_id: j.ownerScopeId !== undefined && j.ownerScopeId !== null ? String(j.ownerScopeId) : args.orgFallback,
      owner_id: j.owner !== undefined && j.owner !== null ? String(j.owner) : 'unknown',
      owner_type: 'internal',
      created_by: j.createdBy !== undefined && j.createdBy !== null ? String(j.createdBy) : 'unknown',
      title: j.title !== undefined && j.title !== null ? String(j.title) : null,
      action: j.action !== undefined && j.action !== null ? String(j.action) : null,
      message: j.message !== undefined && j.message !== null ? String(j.message) : null,
      schedule: JSON.stringify(jsonObj(j.schedule)),
      destination: j.destination !== undefined && j.destination !== null ? JSON.stringify(j.destination) : null,
      enabled: j.enabled !== false,
      archived: j.archived === true,
      created_at: asInt(j.createdAt) ?? 0,
      next_fire_at: asInt(j.nextFireAt),
      last_fired_at: asInt(j.lastFiredAt),
      last_attempt_at: asInt(j.lastAttemptAt),
      recipient_consent: j.recipientConsent !== undefined && j.recipientConsent !== null ? JSON.stringify(j.recipientConsent) : null,
    }
  })
  const dst = await insertRows(exec, 'crons', cols, rows, args.batch)
  results.push({ table: 'crons (DurableMap blob → columns)', verifyTable: 'crons', mode: 'transform', src: blobs.length, dst })

  const fires = await src.q(`SELECT * FROM cron_fire_log`)
  const fireRows = fires.map((f) => ({ cron_id: f.cron_id, fire_key: f.fire_key, fired_at: f.fired_at, json: JSON.stringify(f.json) }))
  const fireDst = await insertRows(exec, 'cron_fire_log', ['cron_id', 'fire_key', 'fired_at', 'json'], fireRows, args.batch)
  results.push({ table: 'cron_fire_log', verifyTable: 'cron_fire_log', mode: 'copy', src: fires.length, dst: fireDst, note: 'embedded Cron.fireLog blobs not carried' })
  return results
}

async function migrateSkills(src: PgPool, exec: Exec, args: Args): Promise<StepResult[]> {
  const blobs = await src.q(`SELECT id, json FROM skills`)
  const cols = ['id', 'scope_id', 'name', 'description', 'body', 'required_capabilities', 'status', 'created_by', 'version', 'created_at', 'updated_at', 'last_used_at', 'files', 'granted_capabilities', 'approvals', 'pack', 'signature']
  let skipped = 0
  const rows: Row[] = []
  for (const b of blobs) {
    const j = jsonObj(b.json)
    const manifest = jsonObj(j.manifest)
    const name = manifest.name !== undefined && manifest.name !== null ? String(manifest.name) : ''
    const description = manifest.description !== undefined && manifest.description !== null ? String(manifest.description) : ''
    const body = manifest.body !== undefined && manifest.body !== null ? String(manifest.body) : ''
    if (!name || !description || !body) {
      skipped += 1
      continue
    }
    rows.push({
      id: b.id,
      scope_id: j.scopeId !== undefined && j.scopeId !== null ? String(j.scopeId) : args.orgFallback,
      name,
      description,
      body,
      required_capabilities: JSON.stringify(Array.isArray(manifest.requiredCapabilities) ? manifest.requiredCapabilities : []),
      status: j.status !== undefined && j.status !== null ? String(j.status) : 'published',
      created_by: String(j.createdBy ?? 'unknown'),
      version: asInt(j.version) ?? 1,
      created_at: asInt(j.createdAt) ?? 0,
      updated_at: asInt(j.updatedAt) ?? 0,
      last_used_at: asInt(j.lastUsedAt),
      files: JSON.stringify(Array.isArray(manifest.files) ? manifest.files : []),
      granted_capabilities: JSON.stringify(Array.isArray(j.grantedCapabilities) ? j.grantedCapabilities : []),
      approvals: JSON.stringify(Array.isArray(j.approvals) ? j.approvals : []),
      pack: j.pack !== undefined && j.pack !== null ? JSON.stringify(j.pack) : null,
      signature: j.signature !== undefined && j.signature !== null ? String(j.signature) : null,
    })
  }
  const dst = await insertRows(exec, 'skills', cols, rows, args.batch)
  return [{
    table: 'skills (DurableMap blob → columns)',
    verifyTable: 'skills',
    mode: 'transform',
    src: blobs.length,
    dst,
    note: skipped > 0 ? `${skipped} blob row(s) skipped (incomplete manifest)` : undefined,
  }]
}

// ---- seed export / journal / rollback ---------------------------------------------

async function exportSeed(src: PgPool, path: string): Promise<number> {
  const fs = await import('node:fs')
  const seed: Record<string, unknown[]> = {}
  let count = 0
  for (const table of SEED_TABLES) {
    if (!(await tableExists(src.q, table))) continue
    const cols = await tableColumns(src.q, table)
    let rows: unknown[]
    if (cols.includes('id') && cols.includes('json')) {
      const blobRows = await src.q(`SELECT id, json FROM "${table}"`)
      rows = blobRows.map((r) => ({ id: String(r.id), json: r.json }))
    } else {
      rows = await src.q(`SELECT * FROM "${table}"`)
    }
    if (rows.length === 0) continue
    seed[table] = rows
    count += rows.length
  }
  fs.writeFileSync(path, JSON.stringify({ exportedAt: new Date().toISOString(), tables: seed }, null, 2))
  return count
}

async function rollbackLast(target: PgPool): Promise<void> {
  const client = await (await target.pool()).connect()
  try {
    await client.query('BEGIN')
    if (!(await tableExists((t, p) => client.query(t, p).then((r) => r.rows as Row[]), 'qm_migration_journal'))) {
      throw new Error('rollback: no journal table — nothing to roll back')
    }
    const runs = (await client.query(`SELECT run_id, MAX(at) AS at FROM qm_migration_journal GROUP BY run_id ORDER BY MAX(at) DESC LIMIT 1`)).rows as Row[]
    if (runs.length === 0) throw new Error('rollback: journal is empty — nothing to roll back')
    const runId = String(runs[0]!.run_id)
    const steps = (await client.query(`SELECT table_name FROM qm_migration_journal WHERE run_id = $1 ORDER BY step DESC`, [runId])).rows as Row[]
    for (const row of steps) {
      const table = String(row.table_name)
      if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
        console.log(`rollback: skipping non-table journal row '${table}'`)
        continue
      }
      await client.query(`DELETE FROM "${table}"`)
      console.log(`rollback: cleared ${table}`)
    }
    await client.query(`DELETE FROM qm_migration_journal WHERE run_id = $1`, [runId])
    await client.query('COMMIT')
    console.log(`rollback: run ${runId} cleared`)
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

// ---- main ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.rollback) {
    const target = createPgPool(args.target!, [])
    try {
      await rollbackLast(target)
    } finally {
      await target.close()
    }
    return
  }

  const source = createPgPool(args.source!, [])
  const target = createPgPool(args.target!, [])
  const results: StepResult[] = []
  const notes: string[] = []

  try {
    const approvalsNote = (await tableExists(source.q, 'approvals'))
      ? await (async () => {
          const pending = await countRows(source.q, 'approvals')
          return pending > 0 ? `${pending} pending qm approval record(s) — approve/deny before cutover (transient records are not carried)` : undefined
        })()
      : undefined
    if (approvalsNote) notes.push(approvalsNote)

    if (args.exportSeed) {
      const count = await exportSeed(source, args.exportSeed)
      console.log(`seed export: ${count} row(s) → ${args.exportSeed}`)
    }

    const client = await (await target.pool()).connect()
    try {
      await client.query('BEGIN')
      const exec: Exec = { query: async (text, params) => (await client.query(text, params)) as { rows: Row[] } }
      const execQ: Q = (text, params) => exec.query(text, params).then((r) => r.rows)
      const want = (table: string): boolean => !args.tables || args.tables.includes(table)

      if (args.verifyOnly) {
        for (const table of [...ENTITY_COPIES, ...TRUNCATE_ONLY, ...BLOB_COPIES.map(([, dst]) => dst), 'sessions', 'session_entries', 'participants', 'session_tape', 'llm_requests', 'directory_people', 'directory_spaces', 'directory_space_members', 'directory_rosters', 'directory_sync_state', 'crons', 'cron_fire_log', 'skills']) {
          if (!want(table)) continue
          if (!(await tableExists(target.q, table))) {
            notes.push(`target missing table: ${table} (PG-twin gap or schema not booted)`)
            continue
          }
          console.log(`verify: ${table} = ${await countRows(target.q, table)}`)
        }
        await client.query('ROLLBACK')
        printNotes(notes)
        return
      }

      for (const table of TRUNCATE_ONLY) {
        if (!want(table)) continue
        if (!(await tableExists(target.q, table))) {
          notes.push(`target missing table: ${table}`)
          continue
        }
        await exec.query(`DELETE FROM "${table}"`)
        results.push({ table, mode: 'truncate-only', src: 0, dst: 0, note: 'cleared for cutover' })
      }

      for (const table of DRAINED) {
        if (!want(table)) continue
        if (!(await tableExists(source.q, table))) continue
        const drained = await countRows(source.q, table)
        if (drained > 0) {
          notes.push(`source ${table} still has ${drained} row(s) — drain before cutover (runbook step 1); rows do not carry`)
        } else {
          results.push({ table, mode: 'drain-check', src: 0, dst: 0, note: 'drained' })
        }
      }

      for (const table of ENTITY_COPIES) {
        if (!want(table)) continue
        if (!(await tableExists(source.q, table))) continue
        if (!(await tableExists(target.q, table))) {
          notes.push(`target missing table: ${table} (PG-twin gap) — source rows (${await countRows(source.q, table)}) not migrated`)
          continue
        }
        const { src, dst } = await copyIntersected(source, exec, table, args.batch)
        results.push({ table, verifyTable: table, mode: 'copy', src, dst, note: src !== dst ? `${src - dst} duplicate/conflicting row(s) skipped` : undefined })
      }

      const transforms: Array<[string, () => Promise<StepResult[]>]> = [
        ['sessions', () => migrateSessionDomain(source, exec, args)],
        ['directory', () => migrateDirectory(source, exec, args)],
        ['crons', () => migrateCrons(source, exec, args)],
        ['skills', () => migrateSkills(source, exec, args)],
      ]
      for (const [domain, run] of transforms) {
        if (!want(domain)) continue
        results.push(...(await run()))
      }

      for (const [srcTable, dstTable] of BLOB_COPIES) {
        if (!want(dstTable)) continue
        if (!(await tableExists(source.q, srcTable))) continue
        if (!(await tableExists(target.q, dstTable))) {
          notes.push(`target missing table: ${dstTable} (PG-twin gap) — blob rows from ${srcTable} not migrated`)
          continue
        }
        const rows = await source.q(`SELECT id, json FROM "${srcTable}"`)
        const dst = await insertRows(exec, dstTable, ['id', 'json'], rows.map((r) => ({ id: r.id, json: JSON.stringify(r.json) })), args.batch)
        results.push({ table: `${srcTable} → ${dstTable}`, verifyTable: dstTable, mode: 'blob-copy', src: rows.length, dst })
        if (await tableExists(source.q, 'durable_map_versions')) {
          const versions = await source.q(`SELECT v FROM durable_map_versions WHERE tbl = $1`, [srcTable])
          if (versions[0] && (await tableExists(target.q, 'durable_map_versions'))) {
            await exec.query(`INSERT INTO durable_map_versions (tbl, v) VALUES ($1, $2) ON CONFLICT (tbl) DO NOTHING`, [dstTable, Number(versions[0].v) || 1])
          }
        }
      }

      const expected = new Map<string, number>()
      for (const r of results) {
        if (!r.verifyTable) continue
        expected.set(r.verifyTable, (expected.get(r.verifyTable) ?? 0) + r.dst)
      }
      let mismatches = 0
      for (const [table, want1] of expected) {
        const got = await countRows(execQ, table)
        if (got !== want1) {
          mismatches += 1
          console.error(`MISMATCH ${table}: expected ${want1}, target has ${got}`)
        }
      }

      console.log('mode        | table                                                       | src → dst')
      console.log('------------|-------------------------------------------------------------|----------')
      for (const r of results) {
        console.log(`${r.mode.padEnd(11)} | ${r.table.padEnd(59)} | ${r.src} → ${r.dst}${r.note ? `  [${r.note}]` : ''}`)
      }
      printNotes(notes)
      if (mismatches > 0) throw new Error(`${mismatches} row-count mismatch(es)`)

      if (args.commit) {
        await exec.query(`CREATE TABLE IF NOT EXISTS qm_migration_journal(
            run_id TEXT NOT NULL, step INT NOT NULL, table_name TEXT NOT NULL, mode TEXT NOT NULL,
            src BIGINT, dst BIGINT, at BIGINT NOT NULL)`)
        const runId = `m${Date.now()}`
        let j = 0
        for (const r of results) {
          await exec.query(`INSERT INTO qm_migration_journal (run_id, step, table_name, mode, src, dst, at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
            runId, j++, r.verifyTable ?? r.table, r.mode, r.src, r.dst, Date.now(),
          ])
        }
        await client.query('COMMIT')
        console.log(`committed as run ${runId} (undo: --rollback)`)
      } else {
        await client.query('ROLLBACK')
        console.log('dry run complete — target rolled back (use --commit to keep)')
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  } finally {
    await source.close()
    await target.close()
  }
}

function printNotes(notes: string[]): void {
  for (const note of notes) console.log(`note: ${note}`)
}

main().catch((error) => {
  console.error(`migrate-qm: ${errMessage(error)}`)
  process.exit(1)
})
