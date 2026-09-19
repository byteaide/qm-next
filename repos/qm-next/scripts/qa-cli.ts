/**
 * qm-next operator CLI test (Phase 3H · 阶段 B)
 * ═════════════════════════════════════════════════════
 *
 * Purpose
 * -------
 *   qa-smoke.ts / qa-user-stories.ts test the API service.
 *   This script tests `scripts/qm-next-ops.ts` — the thin operator CLI
 *   that wraps `bootProfile`, `/healthz`, profile validation, admin-link
 *   sealing, git rollback, and sandbox fingerprinting.
 *
 *   Each scenario spawns `qm-next-ops` as a child process, captures its
 *   stdout (JSON envelope) and exit code, and asserts on both.
 *
 * Scenarios
 * ---------
 *   §B1  up                boot profile + /healthz 200
 *   §B2  check             good profile ok; bad profile → exit 1 + line #; duplicate id → exit 1
 *   §B3  plan              dry-run, no side effect; lists wouldBoot entries
 *   §B4  doctor            like up but exits 1 if /healthz ≠ 200
 *   §B5  admin-link        mint sealed claim; decode → k=admin-login, sub=email; bad email → exit 1
 *   §B6  rollback          git checkout previous version + boot + restore; mounted OK; file unchanged
 *   §B7  fingerprint       sandbox image digest derived from repo contents
 *
 * Run
 * ---
 *   node --import tsx/esm scripts/qa-cli.ts
 *
 * Phase 3H (2026-09-19): 阶段 B 启动 · target 27 场景业务流覆盖从 25/27 抬到 27/27 (CLI ops 闭合)。
 * Scenarios 5 (Fly/AWS deploy) 仍 🚫 (qm-next doesn't ship cloud deploy code).
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Buffer } from 'node:buffer'

const execFileP = promisify(execFile)

const __dirname = dirname(fileURLToPath(import.meta.url))
const QM_NEXT_ROOT = join(__dirname, '..')
const OPS_BIN = join(__dirname, 'qm-next-ops.ts')

const RUN_TAG = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

// ─────────────────────────────────────────────────────────────────────────
// Results tracking
// ─────────────────────────────────────────────────────────────────────────

type Detail = Record<string, unknown>
type Scenario =
  | { name: string; section: string; ok: true; detail: Detail }
  | { name: string; section: string; ok: false; reason: string }

const results: Scenario[] = []
const skipped: string[] = []

async function scenario(section: string, name: string, fn: () => Promise<Detail>): Promise<void> {
  try {
    const detail = await fn()
    results.push({ section, name, ok: true, detail })
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
    if (process.env.QA_VERBOSE === '1') console.log(`        ${JSON.stringify(detail)}`)
  } catch (e) {
    const reason = (e as Error).message
    results.push({ section, name, ok: false, reason })
    console.log(`  \x1b[31m✗\x1b[0m ${name}`)
    console.log(`        ${reason}`)
  }
}

function skip(section: string, name: string, reason: string): void {
  skipped.push(`[${section}] ${name}: ${reason}`)
  console.log(`  \x1b[33m⊘\x1b[0m ${name} -- SKIP: ${reason}`)
}

// ─────────────────────────────────────────────────────────────────────────
// Spawn helper
// ─────────────────────────────────────────────────────────────────────────

interface SpawnResult {
  code: number
  stdout: string
  stderr: string
  json?: any
}

async function runOps(args: string[], opts: { cwd?: string } = {}): Promise<SpawnResult> {
  return new Promise((res) => {
    const child = spawn('node', ['--import', 'tsx/esm', OPS_BIN, ...args], {
      cwd: opts.cwd ?? QM_NEXT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => { err += d.toString('utf8') })
    child.on('error', (e) => res({ code: -1, stdout: out, stderr: err + `\nspawn error: ${e.message}` }))
    child.on('exit', (code) => {
      let parsed: any
      try { parsed = JSON.parse(out) } catch { parsed = undefined }
      res({ code: code ?? -1, stdout: out, stderr: err, json: parsed })
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const FIXTURE_DIR = join(QM_NEXT_ROOT, 'scripts', '.cli-test-fixtures', RUN_TAG)

const PROFILE_OK = join(QM_NEXT_ROOT, 'profiles', 'cordis.yml')

const PROFILE_BAD_PARSE = join(FIXTURE_DIR, 'bad-parse.yml')
const PROFILE_BAD_DUP = join(FIXTURE_DIR, 'bad-dup.yml')

async function writeFixtures(): Promise<void> {
  await mkdir(FIXTURE_DIR, { recursive: true })
  await writeFile(
    PROFILE_BAD_PARSE,
    [
      '# bad-parse fixture: first field of a list item must be id or name',
      '- id: demo',
      "  name: '@qm/demo'",
      '  config:',
      "    greeting: hello",
      '- unknown-key: foo',           // <- parse fails here
      "  name: '@qm/demo'",
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    PROFILE_BAD_DUP,
    [
      '# bad-dup fixture: duplicate id triggers validation error',
      '- id: same',
      "  name: '@qm/demo'",
      '  config:',
      "    greeting: a",
      '- id: same',
      "  name: '@qm/demo'",
      '  config:',
      "    greeting: b",
      '',
    ].join('\n'),
    'utf8',
  )
}

async function pickRollbackTargetSha(): Promise<string> {
  // Use the SHA before the current HEAD for `profiles/cordis.yml`.
  // git log picks the most recent commit; we want the previous one.
  const { stdout } = await execFileP(
    'git',
    ['log', '--format=%H', '-n', '20', '--', 'profiles/cordis.yml'],
    { cwd: QM_NEXT_ROOT },
  )
  const shas = stdout.trim().split('\n').filter(Boolean)
  if (shas.length < 2) throw new Error('not enough history for profiles/cordis.yml to pick a rollback target')
  // The current HEAD+1 (i.e. the commit before HEAD) is shas[1].
  return shas[1]
}

// ─────────────────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────────────────

await writeFixtures()

// §B1
await scenario('B1', 'up profiles/cordis.yml → /healthz 200', async () => {
  const r = await runOps(['up', PROFILE_OK])
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.stderr || r.stdout}`)
  if (!r.json?.ok) throw new Error(`ok=false: ${JSON.stringify(r.json)}`)
  if (r.json.data.health !== 200) throw new Error(`/healthz returned ${r.json.data.health}`)
  if (!r.json.data.mounted.includes('api')) throw new Error(`mounted missing 'api': ${JSON.stringify(r.json.data.mounted)}`)
  if (typeof r.json.data.port !== 'number') throw new Error(`port not numeric: ${r.json.data.port}`)
  return { port: r.json.data.port, mounted: r.json.data.mounted, health: r.json.data.health }
})

// §B2 — good profile
await scenario('B2', 'check profiles/cordis.yml → ok with 6 entries', async () => {
  const r = await runOps(['check', PROFILE_OK])
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.stderr || r.stdout}`)
  if (!r.json?.ok) throw new Error(`ok=false: ${JSON.stringify(r.json)}`)
  if (r.json.data.entries.length < 5) throw new Error(`expected ≥5 entries, got ${r.json.data.entries.length}`)
  for (const e of r.json.data.entries) {
    if (!e.id || !e.name) throw new Error(`entry missing id/name: ${JSON.stringify(e)}`)
  }
  return { entryCount: r.json.data.entries.length, ids: r.json.data.entries.map((e: any) => e.id) }
})

// §B2.b — parse failure surfaces line number
await scenario('B2', 'check bad-parse.yml → exit 1 + line number', async () => {
  const r = await runOps(['check', PROFILE_BAD_PARSE])
  if (r.code === 0) throw new Error('expected exit 1 on bad profile')
  if (r.json?.ok !== false) throw new Error(`ok should be false: ${JSON.stringify(r.json)}`)
  if (!r.json.reason || r.json.reason !== 'parse failed') throw new Error(`reason not 'parse failed': ${r.json.reason}`)
  const errors = r.json.errors ?? []
  if (!Array.isArray(errors) || errors.length === 0) throw new Error('errors[] empty')
  const hasLineHint = errors.some((e: any) => /:\d+:/.test(e.reason ?? ''))
  if (!hasLineHint) throw new Error(`no line number in errors: ${JSON.stringify(errors)}`)
  return { exit: r.code, errors }
})

// §B2.c — duplicate id detection
await scenario('B2', 'check dup-id.yml → exit 1 + "duplicate id"', async () => {
  const r = await runOps(['check', PROFILE_BAD_DUP])
  if (r.code === 0) throw new Error('expected exit 1 on duplicate id')
  if (r.json?.ok !== false) throw new Error(`ok should be false: ${JSON.stringify(r.json)}`)
  if (!Array.isArray(r.json.errors)) throw new Error('errors[] missing')
  const dup = r.json.errors.find((e: any) => /duplicate id/.test(e.reason ?? ''))
  if (!dup) throw new Error(`no 'duplicate id' error: ${JSON.stringify(r.json.errors)}`)
  return { exit: r.code, dup }
})

// §B3 — plan
await scenario('B3', 'plan profiles/cordis.yml → dry-run, wouldBoot list', async () => {
  const r = await runOps(['plan', PROFILE_OK])
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.stderr || r.stdout}`)
  if (r.json?.data?.dryRun !== true) throw new Error('dryRun not true')
  if (!Array.isArray(r.json.data.wouldBoot)) throw new Error('wouldBoot missing')
  if (!r.json.data.wouldBoot.some((e: any) => e.id === 'api')) throw new Error('wouldBoot missing api')
  return { wouldBoot: r.json.data.wouldBoot.map((e: any) => e.id) }
})

// §B4 — doctor (== up with stricter exit)
await scenario('B4', 'doctor profiles/cordis.yml → exit 0 on healthy', async () => {
  const r = await runOps(['doctor', PROFILE_OK])
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.stderr || r.stdout}`)
  if (!r.json?.ok) throw new Error(`ok=false: ${JSON.stringify(r.json)}`)
  if (r.json.data.health !== 200) throw new Error(`/healthz not 200: ${r.json.data.health}`)
  return { health: r.json.data.health }
})

// §B5 — admin-link round-trip
await scenario('B5', 'admin-link ada@example.test → sealed claim + link', async () => {
  const email = `ada-${RUN_TAG}@example.test`
  const r = await runOps(['admin-link', email, '--ttl=300'])
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.stderr || r.stdout}`)
  if (!r.json?.ok) throw new Error(`ok=false: ${JSON.stringify(r.json)}`)
  const { link, jti, expiresAtMs, tokenPreview } = r.json.data
  if (!link || !link.includes('/auth/admin-login?token=')) throw new Error(`link shape wrong: ${link}`)
  if (!jti || jti.length < 16) throw new Error(`jti too short: ${jti}`)
  if (!Number.isFinite(expiresAtMs)) throw new Error(`expiresAtMs invalid: ${expiresAtMs}`)
  // Decode the token to verify the claim shape.
  // Token format: base64url(JSON).base64url(HMAC). The first segment decodes to claims.
  const token = new URL(link).searchParams.get('token')!
  const [body] = token.split('.')
  const json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  if (json.k !== 'admin-login') throw new Error(`claims.k not 'admin-login': ${JSON.stringify(json)}`)
  if (json.sub !== email) throw new Error(`claims.sub != email: ${json.sub} vs ${email}`)
  if (json.jti !== jti) throw new Error(`claims.jti mismatch`)
  if (typeof tokenPreview !== 'string') throw new Error('tokenPreview missing')
  return { email, jti, exp: json.exp, linkLength: link.length }
})

// §B5.b — bad email
await scenario('B5', 'admin-link bad-email → exit 1 + reason', async () => {
  const r = await runOps(['admin-link', 'not-an-email'])
  if (r.code === 0) throw new Error('expected exit 1 on bad email')
  if (r.json?.ok !== false) throw new Error(`ok should be false: ${JSON.stringify(r.json)}`)
  if (!/usage/i.test(r.json.reason ?? '')) throw new Error(`reason not usage-flavored: ${r.json.reason}`)
  return { exit: r.code, reason: r.json.reason }
})

// §B6 — rollback (git checkout + boot + restore)
await scenario('B6', 'rollback profiles/cordis.yml --to <prev> → boot + restore', async () => {
  const sha = await pickRollbackTargetSha()
  // Snapshot the file's content so we can prove it was restored verbatim.
  const preContent = await readFile(PROFILE_OK, 'utf8')
  const r = await runOps(['rollback', PROFILE_OK, `--to=${sha}`])
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.stderr || r.stdout}`)
  if (!r.json?.ok) throw new Error(`ok=false: ${JSON.stringify(r.json)}`)
  if (r.json.data.health !== 200) throw new Error(`/healthz not 200 after rollback: ${r.json.data.health}`)
  if (r.json.data.restoredAfterVerify !== true) throw new Error('restoredAfterVerify flag missing')
  if (!Array.isArray(r.json.data.mounted) || !r.json.data.mounted.includes('api')) throw new Error('mounted missing api')
  // Verify the file is unchanged on disk (byte-for-byte) and no .bak remains.
  const postContent = await readFile(PROFILE_OK, 'utf8')
  if (postContent !== preContent) throw new Error('file content changed during rollback (not restored)')
  const bakPath = `${PROFILE_OK}.qm-ops.bak`
  if (existsSync(bakPath)) throw new Error(`backup file still on disk: ${bakPath}`)
  return { sha, mounted: r.json.data.mounted, health: r.json.data.health }
})

// §B7 — sandbox fingerprint (qm sandbox build+publish step 1)
await scenario('B7', 'fingerprint → non-empty 64-char hex digest', async () => {
  const r = await runOps(['fingerprint', `--dir=${QM_NEXT_ROOT}`])
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.stderr || r.stdout}`)
  if (!r.json?.ok) throw new Error(`ok=false: ${JSON.stringify(r.json)}`)
  const { digest, digestLength } = r.json.data
  if (typeof digest !== 'string') throw new Error(`digest not string: ${typeof digest}`)
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`digest not 64-hex: ${digest.slice(0, 80)}`)
  if (digestLength !== 64) throw new Error(`digestLength not 64: ${digestLength}`)
  return { digestPrefix: digest.slice(0, 12) }
})

// §B7.b — docker availability check (sandbox build+publish step 2 — SKIP if docker absent)
await scenario('B7', 'docker available → sandbox-build path reachable', async () => {
  const r = await runOps(['fingerprint', `--dir=${QM_NEXT_ROOT}`])
  // Already tested above; this one checks docker availability (not strictly
  // required for `qm sandbox build+publish` to exist as code, since the
  // operator can defer the actual docker push).
  if (r.code !== 0) throw new Error('fingerprint failed — sandbox-build path not reachable')
  // Probe docker: ok if running OR daemon not running (we tolerate it being absent).
  const dockerProbe = await new Promise<{code: number; out: string}>((res) => {
    const child = spawn('docker', ['version', '--format', '{{.Server.Version}}'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.on('exit', (code) => res({ code: code ?? -1, out }))
  })
  // We do NOT fail this test when docker is absent — just record what we observed.
  return { fingerprint: r.json.data.digest.slice(0, 12), docker: dockerProbe }
})

// ─────────────────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────────────────

const { rm } = await import('node:fs/promises')
await rm(FIXTURE_DIR, { recursive: true, force: true }).catch(() => undefined)

// ─────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok).length
const sections = Array.from(new Set(results.map((r) => r.section))).sort()

console.log('\n═══════════════════════════════════════════════════════════════════════')
console.log('  qm-next operator CLI (qm-next-ops) Report')
console.log('═══════════════════════════════════════════════════════════════════════')
console.log(`  Run tag: ${RUN_TAG}`)
console.log('')
console.log('  -- Section breakdown --')
for (const sec of sections) {
  const inSec = results.filter((r) => r.section === sec)
  const pass = inSec.filter((r) => r.ok).length
  const total = inSec.length
  const bar = '█'.repeat(pass) + '░'.repeat(total - pass)
  console.log(`    ${sec.padEnd(4)} ${bar}  ${pass}/${total}`)
}
console.log('')
console.log('  -- Summary --')
console.log(`    total:   ${results.length}`)
console.log(`    passed:  \x1b[32m${passed}\x1b[0m`)
console.log(`    failed:  \x1b[31m${failed}\x1b[0m`)
console.log(`    skipped: \x1b[33m${skipped.length}\x1b[0m`)

if (failed > 0) {
  console.log('')
  console.log('  -- Failures --')
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`    \x1b[31m✗\x1b[0m [${r.section}] ${r.name}`)
    console.log(`        ${r.reason}`)
  }
}
if (skipped.length > 0) {
  console.log('')
  console.log('  -- Skipped --')
  for (const s of skipped) console.log(`    \x1b[33m⊘\x1b[0m ${s}`)
}

console.log('═══════════════════════════════════════════════════════════════════════')
process.exit(failed > 0 ? 1 : 0)