#!/usr/bin/env node
/**
 * qm-next operator CLI (Phase 3H · 阶段 B).
 *
 * qm-next does NOT ship the upstream `qm` CLI binary. The operator surface
 * qm-next actually has:
 *   - `bootProfile(profiles/*.yml)` + `/healthz` for `qm up` / `qm doctor`
 *   - the YAML profile file as the deployment directory (qm uses
 *     `qm.config.jsonc`; qm-next uses `profiles/*.yml`)
 *   - `scripts/check-im-isolation.sh` + `scripts/rescope-check.sh` for static
 *     gates (called from CI, not exposed as CLI)
 *   - `scripts/local-sandbox-build.sh` for `qm sandbox build+publish`
 *
 * This CLI is a thin wrapper over those primitives. It mirrors qm's
 * `qm <verb> [args]` surface so scripts/docs that referenced the upstream
 * commands now have an actual binary to point at. Where the underlying
 * operation does not exist in qm-next (Fly/AWS deploy, RDS rollback,
 * output scrubbing) the command returns a structured `{ok:false, reason}`
 * exit-1 result so callers can distinguish "not implemented" from "failed".
 *
 * Commands:
 *   up <profile>                boot profile + /healthz check, print JSON
 *   check <profile>             parse profile, validate structure, exit 0/1
 *   doctor <profile>            alias for `up` but exit 1 if /healthz ≠ 200
 *   plan <profile>              dry-run: parse + describe what `up` would mount
 *   admin-link <email>          mint a sealed admin-login claim + print link
 *   rollback <profile> --to SHA  git checkout previous profile + re-boot + verify
 *
 * Exit codes:
 *   0  ok
 *   1  failed (parse / boot / healthz)
 *   2  usage error
 *   3  not-implemented (no real cloud for Fly/AWS etc.)
 *
 * All commands print a JSON object on success and a JSON `{ok:false, ...}`
 * on failure (unless --quiet).
 *
 * Usage:
 *   node --import tsx/esm scripts/qm-next-ops.ts up profiles/cordis.yml
 *   node --import tsx/esm scripts/qm-next-ops.ts check profiles/cordis.yml
 *   node --import tsx/esm scripts/qm-next-ops.ts admin-link ada@example.test
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bootProfile } from '../packages/boot/src/index.ts'
import { seal, deriveKey, randomToken } from '../packages/portal/src/index.ts'
import { computeSandboxImageFingerprint } from '../packages/sandbox/src/local-sandbox.ts'
import type { Context } from '../vendor/cordis/src/index.ts'

// ─────────────────────────────────────────────────────────────────────────
// Result envelope
// ─────────────────────────────────────────────────────────────────────────

interface OpResult<T = unknown> {
  ok: boolean
  command: string
  data?: T
  reason?: string
  /** Structured per-entry validation errors (check command). */
  errors?: Array<{ entry: string; reason: string }>
}

function die<T>(command: string, reason: string, extras: Partial<OpResult<T>> = {}): never {
  const out: OpResult<T> = { ok: false, command, reason, ...extras }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  process.exit(1)
}

function emit<T>(command: string, data: T): never {
  process.stdout.write(JSON.stringify({ ok: true, command, data } as OpResult<T>, null, 2) + '\n')
  process.exit(0)
}

// ─────────────────────────────────────────────────────────────────────────
// Profile parsing (no js-yaml in root node_modules — write a tiny parser)
// ─────────────────────────────────────────────────────────────────────────
//
// qm-next profiles are uniform: a YAML list of objects with `id`, optional
// `name`, optional `config`. No anchors, no merge keys, no `!js` interpolation
// (that happens at `bootProfile` time, not at the parse we run for `check`
// or `plan`). Anything richer throws.
//
// If a profile uses `!!js` the parse will see it as a literal string and
// `plan`/`check` will simply ignore it; `bootProfile` is the source of
// truth for the interpolation.

interface ProfileEntry {
  id: string
  name?: string
  config?: Record<string, unknown>
  /** Raw lines for error reporting. */
  line?: number
}

function parseProfile(yamlText: string, file: string): ProfileEntry[] {
  // Strip empty lines + full-line comments; record line numbers for errors.
  const lines = yamlText.split('\n').map((l) => l.replace(/\s+$/, ''))
  const entries: ProfileEntry[] = []
  let i = 0

  function indentOf(s: string): number {
    let n = 0
    while (n < s.length && s[n] === ' ') n += 1
    return n
  }

  while (i < lines.length) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      i += 1
      continue
    }
    // Top-level list marker
    if (trimmed === '-') {
      i += 1
      continue
    }
    if (raw.startsWith('  ') || raw.startsWith('\t') || !raw.startsWith('-')) {
      throw new Error(`${file}:${i + 1}: expected top-level list item, got '${trimmed.slice(0, 60)}'`)
    }
    if (!raw.startsWith('- ')) {
      throw new Error(`${file}:${i + 1}: invalid list item prefix`)
    }

    // First field on the dash line: `id: foo`
    const head = raw.slice(2).trim()
    const headColon = head.indexOf(':')
    if (headColon < 0) {
      throw new Error(`${file}:${i + 1}: missing first field on list item (expected 'id:' or 'name:')`)
    }
    const entry: ProfileEntry = { id: '', line: i + 1 }
    const headKey = head.slice(0, headColon).trim()
    const headValue = head.slice(headColon + 1).trim()
    if (headKey !== 'id' && headKey !== 'name') {
      throw new Error(`${file}:${i + 1}: first field must be 'id' or 'name', got '${headKey}'`)
    }
    if (!headValue) {
      throw new Error(`${file}:${i + 1}: empty value for '${headKey}'`)
    }
    if (headKey === 'id') entry.id = headValue
    else entry.name = headValue
    i += 1

    // Subsequent lines: more scalar keys at the same content indent as
    // `id:` (i.e. right after `- `), or `config:` block with sub-keys at
    // exactly that indent + 2 spaces. Anything shallower ends the entry.
    // dashColumn = 0; contentColumn = 2 (right after '- ').
    const contentIndent = 2
    while (i < lines.length) {
      const next = lines[i]
      const nextTrim = next.trim()
      if (!nextTrim || nextTrim.startsWith('#')) {
        i += 1
        continue
      }
      const nextIndent = indentOf(next)
      if (nextIndent < contentIndent) break // back to outer level
      if (nextIndent > contentIndent) {
        throw new Error(`${file}:${i + 1}: unexpected indent on '${nextTrim.slice(0, 60)}'`)
      }
      if (nextTrim === '-') {
        throw new Error(`${file}:${i + 1}: nested list inside entry is not allowed`)
      }
      const colon = nextTrim.indexOf(':')
      if (colon < 0) {
        throw new Error(`${file}:${i + 1}: expected 'key: value', got '${nextTrim.slice(0, 60)}'`)
      }
      const k = nextTrim.slice(0, colon).trim()
      const v = nextTrim.slice(colon + 1).trim()
      if (k === 'config') {
        entry.config = {}
        i += 1
        // Sub-keys at contentIndent + 2 (i.e. 4 spaces)
        const subIndent = contentIndent + 2
        while (i < lines.length) {
          const sub = lines[i]
          const subTrim = sub.trim()
          if (!subTrim || subTrim.startsWith('#')) {
            i += 1
            continue
          }
          const subIndentNow = indentOf(sub)
          if (subIndentNow < subIndent) break
          if (subIndentNow > subIndent) {
            throw new Error(`${file}:${i + 1}: config key indent must be exactly ${subIndent}, got ${subIndentNow}`)
          }
          const subColon = subTrim.indexOf(':')
          if (subColon < 0) {
            throw new Error(`${file}:${i + 1}: expected 'key: value' inside config`)
          }
          const sk = subTrim.slice(0, subColon).trim()
          const sv = subTrim.slice(subColon + 1).trim()
          entry.config[sk] = parseScalar(sv, `${file}:${i + 1}`)
          i += 1
        }
        continue
      }
      if (k === 'id' || k === 'name') {
        if (!v) throw new Error(`${file}:${i + 1}: empty value for '${k}'`)
        if (k === 'id') entry.id = v
        else entry.name = v
        i += 1
        continue
      }
      throw new Error(`${file}:${i + 1}: unknown field '${k}' (only id / name / config allowed)`)
    }

    if (!entry.id && entry.name) entry.id = entry.name
    if (!entry.id) {
      throw new Error(`${file}:${entry.line ?? i}: entry missing 'id'`)
    }
    entries.push(entry)
  }

  return entries
}

function parseScalar(v: string, where: string): unknown {
  if (v === '') return ''
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null') return null
  if (/^-?\d+$/.test(v)) return Number(v)
  if (/^-?\d+\.\d+$/.test(v)) return Number(v)
  // Bare string (strip surrounding quotes if present)
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1)
  }
  return v
}

// ─────────────────────────────────────────────────────────────────────────
// Boot helper (shared by up / doctor / plan-dryrun-info / rollback)
// ─────────────────────────────────────────────────────────────────────────

async function bootAndInspect(profilePath: string): Promise<{
  port: number
  mounted: string[]
  health: number
}> {
  const ctx: Context = await bootProfile(profilePath)
  const mounted = Object.keys(ctx.reflect.props).filter(
    (k) => !['get', 'set', 'provide', 'accessor', 'mixin', 'runtime', 'effect',
      'inject', 'plugin', 'on', 'once', 'parallel', 'emit', 'serial', 'bail',
      'waterfall', 'loader'].includes(k),
  )
  const api = ctx.api as { address: { port: number; host: string } } | undefined
  if (!api) {
    await ctx.loader.remove('include')
    throw new Error('profile did not mount an `@qm/api` entry — cannot probe /healthz')
  }
  const res = await fetch(`http://${api.address.host}:${api.address.port}/healthz`)
  const health = res.status
  await ctx.loader.remove('include')
  return { port: api.address.port, mounted, health }
}

// ─────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────

async function cmdUp(profile: string): Promise<void> {
  if (!profile) die('up', 'usage: qm-next-ops up <profile>')
  const resolved = resolve(profile)
  if (!existsSync(resolved)) die('up', `profile not found: ${resolved}`)
  try {
    const r = await bootAndInspect(resolved)
    emit('up', { profile: resolved, ...r })
  } catch (e: any) {
    die('up', e?.message ?? String(e))
  }
}

async function cmdCheck(profile: string): Promise<void> {
  if (!profile) die('check', 'usage: qm-next-ops check <profile>')
  const resolved = resolve(profile)
  if (!existsSync(resolved)) die('check', `profile not found: ${resolved}`)
  const text = await readFile(resolved, 'utf8')
  const errors: Array<{ entry: string; reason: string }> = []
  let entries: ProfileEntry[] = []
  try {
    entries = parseProfile(text, resolved)
  } catch (e: any) {
    errors.push({ entry: '<profile>', reason: e?.message ?? String(e) })
    const out: OpResult = { ok: false, command: 'check', reason: 'parse failed', errors }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
    process.exit(1)
  }
  const seenIds = new Set<string>()
  for (const e of entries) {
    if (!e.id) errors.push({ entry: '<anonymous>', reason: 'entry missing id' })
    else if (seenIds.has(e.id)) errors.push({ entry: e.id, reason: 'duplicate id' })
    else seenIds.add(e.id)
    if (!e.name) errors.push({ entry: e.id ?? '<anonymous>', reason: "entry missing 'name' (package hint)" })
  }
  if (errors.length > 0) {
    const out: OpResult = { ok: false, command: 'check', reason: 'validation failed', errors }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
    process.exit(1)
  }
  emit('check', { profile: resolved, entries: entries.map((e) => ({ id: e.id, name: e.name, hasConfig: !!e.config })) })
}

async function cmdDoctor(profile: string): Promise<void> {
  if (!profile) die('doctor', 'usage: qm-next-ops doctor <profile>')
  const resolved = resolve(profile)
  if (!existsSync(resolved)) die('doctor', `profile not found: ${resolved}`)
  try {
    const r = await bootAndInspect(resolved)
    if (r.health !== 200) {
      const out: OpResult = { ok: false, command: 'doctor', reason: `/healthz returned ${r.health}`, data: r }
      process.stdout.write(JSON.stringify(out, null, 2) + '\n')
      process.exit(1)
    }
    emit('doctor', { profile: resolved, ...r })
  } catch (e: any) {
    die('doctor', e?.message ?? String(e))
  }
}

async function cmdPlan(profile: string): Promise<void> {
  if (!profile) die('plan', 'usage: qm-next-ops plan <profile>')
  const resolved = resolve(profile)
  if (!existsSync(resolved)) die('plan', `profile not found: ${resolved}`)
  const text = await readFile(resolved, 'utf8')
  let entries: ProfileEntry[]
  try {
    entries = parseProfile(text, resolved)
  } catch (e: any) {
    die('plan', e?.message ?? String(e))
  }
  // Dry-run description: list what `up` would boot, without actually booting.
  emit('plan', {
    profile: resolved,
    dryRun: true,
    wouldBoot: entries.map((e) => ({
      id: e.id,
      package: e.name ?? null,
      configKeys: e.config ? Object.keys(e.config) : [],
    })),
    note: 'no side effects; `up` would boot these entries and probe /healthz',
  })
}

async function cmdFingerprint(opts: { dir?: string }): Promise<void> {
  // `qm sandbox build+publish` step 1: derive the sandbox image digest from
  // repo contents. No docker, no network — deterministic. Tests assert this
  // is non-empty when the repo has Dockerfile + .gitignore + fingerprint
  // sources present.
  const dir = opts.dir ?? process.cwd()
  let fp: string | null = null
  try {
    fp = await computeSandboxImageFingerprint(dir)
  } catch (e: any) {
    die('fingerprint', e?.message ?? String(e))
  }
  if (!fp) die('fingerprint', 'computeSandboxImageFingerprint returned null (repo lacks fingerprint sources)')
  emit('fingerprint', {
    repoRoot: dir,
    digest: fp,
    digestLength: fp.length,
    note: 'qm sandbox build+publish step 1; the full docker build is gated by `scripts/local-sandbox-build.sh` and needs docker + network',
  })
}

async function cmdAdminLink(email: string, opts: { publicUrl?: string; secret?: string; ttl?: string }): Promise<void> {
  if (!email || !email.includes('@')) die('admin-link', `usage: qm-next-ops admin-link <email>  (got '${email}')`)
  const publicUrl = opts.publicUrl ?? 'http://127.0.0.1:8095'
  const secret = opts.secret ?? 'dev-m1-secret'
  const ttlS = Number(opts.ttl ?? '300')
  if (!Number.isFinite(ttlS) || ttlS <= 0) die('admin-link', 'invalid --ttl')
  const key = deriveKey(secret, 'portal.admin-login.v1')
  const now = Date.now()
  const jti = randomToken(16)
  const claims = {
    k: 'admin-login',
    sub: email,
    aud: publicUrl,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + ttlS,
    jti,
  }
  const token = seal(claims, key)
  const link = `${publicUrl.replace(/\/$/, '')}/auth/admin-login?token=${encodeURIComponent(token)}`
  emit('admin-link', {
    email,
    publicUrl,
    ttlSeconds: ttlS,
    expiresAtMs: claims.exp * 1000,
    jti,
    link,
    tokenPreview: `${token.slice(0, 32)}...(${token.length}b64)`,
  })
}

async function cmdRollback(profile: string, opts: { to?: string; dir?: string }): Promise<void> {
  if (!profile) die('rollback', 'usage: qm-next-ops rollback <profile> --to <sha> [--dir <repo-root>]')
  if (!opts.to) die('rollback', '--to <sha> is required')
  const repoRoot = opts.dir ?? process.cwd()
  const profilePath = resolve(profile)
  const workdir = dirname(profilePath)

  // git show expects a path relative to the git work tree root. Walk up from
  // the profile's directory to find the .git boundary, then compute the
  // relative path.
  const gitRel = await findGitRelativePath(profilePath, repoRoot)
  if (!gitRel) die('rollback', `no .git found above ${profilePath}`)

  // 1. Snapshot current file so we can restore on test failure
  const currentText = await readFile(profilePath, 'utf8')
  const backupPath = `${profilePath}.qm-ops.bak`
  await writeFile(backupPath, currentText, 'utf8')

  // 2. git checkout the previous version of the profile at <sha>
  const gitArgs = ['show', `${opts.to}:${gitRel}`]
  const previousText = await new Promise<string>((resolveGit, rejectGit) => {
    const child = spawn('git', gitArgs, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    child.stdout.on('data', (d: Buffer) => { buf += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { buf += d.toString('utf8') })
    child.on('error', rejectGit)
    child.on('exit', (code) => {
      if (code === 0) resolveGit(buf)
      else rejectGit(new Error(`git ${gitArgs.join(' ')} → exit ${code}: ${buf.slice(0, 200)}`))
    })
  })

  // 3. Write + boot + restore on failure
  let booted = false
  let health = 0
  let mounted: string[] = []
  try {
    await writeFile(profilePath, previousText, 'utf8')
    const r = await bootAndInspect(profilePath)
    booted = true
    health = r.health
    mounted = r.mounted
    if (health !== 200) throw new Error(`/healthz returned ${health} after rollback`)
  } finally {
    // Always restore the current file — rollback is non-destructive in this CLI.
    await copyFile(backupPath, profilePath)
    await import('node:fs/promises').then((fs) => fs.unlink(backupPath).catch(() => undefined))
  }
  emit('rollback', {
    profile: profilePath,
    fromSha: opts.to,
    gitPath: gitRel,
    repoRoot,
    restoredAfterVerify: true,
    health,
    mounted,
  })
}

async function findGitRelativePath(filePath: string, repoRoot: string): Promise<string | null> {
  // Quick: try `git rev-parse --show-toplevel` from repoRoot
  const toplevel = await new Promise<string | null>((res) => {
    const child = spawn('git', ['rev-parse', '--show-toplevel'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    child.stdout.on('data', (d: Buffer) => { buf += d.toString('utf8').trim() })
    child.on('error', () => res(null))
    child.on('exit', (code) => res(code === 0 ? buf : null))
  })
  if (!toplevel) return null
  // filePath is absolute; compute relative to toplevel.
  const { relative } = await import('node:path')
  return relative(toplevel, filePath)
}

// ─────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { cmd: string; positional: string[]; opts: Record<string, string> } {
  const [, , cmd, ...rest] = argv
  const positional: string[] = []
  const opts: Record<string, string> = {}
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq >= 0) opts[a.slice(2, eq)] = a.slice(eq + 1)
      else {
        const k = a.slice(2)
        const next = rest[i + 1]
        if (next && !next.startsWith('--')) { opts[k] = next; i += 1 }
        else opts[k] = 'true'
      }
    } else {
      positional.push(a)
    }
  }
  return { cmd: cmd ?? '', positional, opts }
}

async function main(): Promise<void> {
  const { cmd, positional, opts } = parseArgs(process.argv)
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(
      [
        'qm-next-ops — operator CLI shim for qm-next',
        '',
        'commands:',
        '  up <profile>',
        '  check <profile>',
        '  doctor <profile>',
        '  plan <profile>',
        '  fingerprint [--dir <repo-root>]',
        '  admin-link <email> [--public-url URL] [--secret S] [--ttl SECONDS]',
        '  rollback <profile> --to <sha> [--dir <repo-root>]',
        '',
        'exit codes: 0 ok · 1 failed · 2 usage · 3 not-implemented',
      ].join('\n') + '\n',
    )
    process.exit(2)
  }

  try {
    switch (cmd) {
      case 'up':        await cmdUp(positional[0] ?? ''); break
      case 'check':     await cmdCheck(positional[0] ?? ''); break
      case 'doctor':    await cmdDoctor(positional[0] ?? ''); break
      case 'plan':      await cmdPlan(positional[0] ?? ''); break
      case 'fingerprint':
        await cmdFingerprint({ dir: opts.dir })
        break
      case 'admin-link':
        await cmdAdminLink(positional[0] ?? '', {
          publicUrl: opts['public-url'],
          secret: opts.secret,
          ttl: opts.ttl,
        })
        break
      case 'rollback':  await cmdRollback(positional[0] ?? '', { to: opts.to, dir: opts.dir }); break
      default:
        process.stdout.write(JSON.stringify({ ok: false, command: cmd, reason: `unknown command: ${cmd}` }, null, 2) + '\n')
        process.exit(2)
    }
  } catch (e: any) {
    die(cmd, e?.message ?? String(e))
  }
}

// Allow library use (qa-cli.ts imports internals); only run main() when
// this script is the entrypoint.
const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isEntrypoint) {
  main().catch((e) => {
    process.stdout.write(JSON.stringify({ ok: false, reason: e?.message ?? String(e) }, null, 2) + '\n')
    process.exit(1)
  })
}

export {
  parseProfile,
  bootAndInspect,
  type ProfileEntry,
  type OpResult,
}