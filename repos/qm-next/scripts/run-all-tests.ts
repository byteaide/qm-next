/**
 * qm-next · test runner orchestrator (Phase 3K)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Purpose
 * -------
 *   Runs every qa-*.ts script in this repo in a fixed order, captures
 *   pass/fail/skip counts from each script's terminal summary, and
 *   prints an aggregated report + a single exit code (0 if no failures,
 *   1 if any suite failed).
 *
 *   This is what `pnpm test:all` invokes; it's also the entry point a CI
 *   job or pre-push hook calls. Each individual qa-*.ts script remains
 *   runnable in isolation (their exit codes are preserved).
 *
 * Suites (run order)
 * ------------------
 *   1. qa-cli               (11 cases · ~10s · spawns qm-next-ops · no docker)
 *   2. qa-user-stories      (31 cases · ~25s · mock harness · no docker)
 *   3. qa-sandbox-policy    (29 cases · ~25s · 24 unit + 5 docker · skips if image missing)
 *   4. qa-sandbox-real      (5 cases · ~30s · real docker · skips if image missing)
 *   5. qa-smoke-wave2       (21 cases · ~45s · docker pg + sandbox · skips individual cases)
 *   6. qa-smoke             (235 cases · ~5min · SENSENOVA_API_KEY — skipped if unset)
 *
 *   Order goes from cheapest + most isolated to most expensive + most
 *   infra-dependent. Failures in cheap suites surface first; a broken
 *   docker image doesn't waste the model-API budget on qa-smoke.
 *
 * Skip / fail semantics
 * ---------------------
 *   - `qa-smoke` is SKIP if `SENSENOVA_API_KEY` is unset (the script
 *     hard-exits otherwise; we pre-check and treat unset as SKIP).
 *   - All other suites self-skip on docker unavailability / image
 *     absence — we trust their internal `skip()` helpers.
 *   - Any suite that exits non-zero counts as a *failure*; we capture
 *     last 100 lines of stdout for the report.
 *
 * Usage
 * -----
 *   node --import tsx/esm scripts/run-all-tests.ts
 *   # or
 *   pnpm test:all
 *
 * Environment variables
 * ---------------------------------------
 *   SENSENOVA_API_KEY   if set, runs qa-smoke.ts; if unset, SKIP qa-smoke
 *   QA_SKIP_DOCKER=1    if set, treat all docker-dependent suites as SKIP
 *                        (useful for headless CI without docker)
 *   QA_VERBOSE=1        forward to child scripts
 *
 * Exit codes
 * ----------
 *   0  every suite passed (or all suites were SKIP)
 *   1  at least one suite had ≥1 FAIL
 *   2  orchestrator pre-flight failed (e.g. node version mismatch)
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const QM_NEXT_ROOT = join(__dirname, '..')

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const

interface SuiteSpec {
  name: string
  script: string
  needs?: string[][]
  reason?: string
  /** Skip the suite if this returns a non-empty skip reason. */
  skipIf?: () => string | null
}

const SUITES: ReadonlyArray<SuiteSpec> = [
  {
    name: 'qa-cli',
    script: 'qa-cli.ts',
    reason: 'operator CLI surface (Phase 3H · 11 cases)',
  },
  {
    name: 'qa-user-stories',
    script: 'qa-user-stories.ts',
    reason: 'business-flow coverage (Phase 3G/I/J · 31 cases · mock harness)',
  },
  {
    name: 'qa-sandbox-policy',
    script: 'qa-sandbox-policy.ts',
    reason: 'sandbox command-policy engine guard (Phase 3J · 29 cases)',
  },
  {
    name: 'qa-sandbox-real',
    script: 'qa-sandbox-real.ts',
    reason: 'real-docker container isolation (Phase 3I · 5 cases)',
  },
  {
    name: 'qa-smoke-wave2',
    script: 'qa-smoke-wave2.ts',
    reason: 'PG twin + sandbox Docker + Deployments (Phase 3E · 21 cases)',
  },
  {
    name: 'qa-smoke',
    script: 'qa-smoke.ts',
    reason: 'route-level smoke (Phase 3F · 235 cases · SENSENOVA_API_KEY)',
    skipIf: () => {
      const key = process.env.SENSENOVA_API_KEY?.trim()
      return key ? null : 'SENSENOVA_API_KEY is not set'
    },
  },
]

interface SuiteResult {
  name: string
  status: 'pass' | 'fail' | 'skip' | 'error'
  total: number | null
  passed: number | null
  failed: number | null
  skipped: number | null
  durationMs: number
  exitCode: number | null
  skipReason?: string
  stdoutTail: string
  stderrTail: string
  errorMsg?: string
}

const TAIL_LINES = 60

async function runSuite(spec: SuiteSpec): Promise<SuiteResult> {
  const skipReason = spec.skipIf?.() ?? null
  const start = Date.now()

  if (skipReason) {
    console.log(`${COLORS.yellow}⊘${COLORS.reset} ${COLORS.bold}${spec.name}${COLORS.reset} — SKIP (${skipReason})`)
    return {
      name: spec.name,
      status: 'skip',
      total: null,
      passed: null,
      failed: null,
      skipped: null,
      durationMs: 0,
      exitCode: null,
      skipReason,
      stdoutTail: '',
      stderrTail: '',
    }
  }

  console.log(`${COLORS.cyan}▶${COLORS.reset} ${COLORS.bold}${spec.name}${COLORS.reset} ${COLORS.dim}— ${spec.reason ?? ''}${COLORS.reset}`)

  return new Promise((resolve) => {
    const child = spawn('node', ['--import', 'tsx/esm', join(QM_NEXT_ROOT, 'scripts', spec.script)], {
      cwd: QM_NEXT_ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (err) => {
      resolve({
        name: spec.name,
        status: 'error',
        total: null,
        passed: null,
        failed: null,
        skipped: null,
        durationMs: Date.now() - start,
        exitCode: null,
        stdoutTail: '',
        stderrTail: '',
        errorMsg: err.message,
      })
    })

    child.on('close', (code) => {
      const durationMs = Date.now() - start
      const lines = stdout.split('\n')
      const tail = lines.slice(-TAIL_LINES).join('\n')
      const stderrTail = stderr.split('\n').slice(-30).join('\n')

      // Strip ANSI escape codes before regex-matching summary lines.
      // Each script prints e.g. `passed:  [32m11[0m` — the digit is wrapped
      // in color codes that confuse the regex if we don't strip them.
      const stripped = stdout.replace(/\x1b\[[0-9;]*m/g, '')

      const get = (label: string): number | null => {
        const re = new RegExp(`${label}:\\s+(\\d+)`)
        const match = stripped.match(re)
        return match ? Number(match[1]) : null
      }

      const passed = get('passed')
      const failed = get('failed')
      const skipped = get('skipped')
      const total = get('total')

      // Treat exit code 1 as fail, anything else with parsed numbers as pass.
      const status: SuiteResult['status'] = code === 0 ? 'pass' : 'fail'

      resolve({
        name: spec.name,
        status,
        total,
        passed,
        failed,
        skipped,
        durationMs,
        exitCode: code,
        stdoutTail: tail,
        stderrTail,
      })
    })
  })
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  const sec = ms / 1_000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const min = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${min}m${s}s`
}

async function main(): Promise<void> {
  const wallStart = Date.now()

  console.log('')
  console.log(`${COLORS.bold}qm-next · test:all${COLORS.reset}`)
  console.log(`${COLORS.dim}Suites: ${SUITES.length} · SENSENOVA_API_KEY: ${process.env.SENSENOVA_API_KEY ? 'set' : 'unset'} · Docker: ${process.env.QA_SKIP_DOCKER === '1' ? 'forced skip' : 'auto-detect'}${COLORS.reset}`)
  console.log('')

  const results: SuiteResult[] = []
  for (const spec of SUITES) {
    results.push(await runSuite(spec))
  }

  const totalWall = Date.now() - wallStart

  // Aggregate
  const sumCount = (key: 'total' | 'passed' | 'failed' | 'skipped'): number =>
    results.reduce((acc, r) => acc + (r[key] ?? 0), 0)

  const totalCases = sumCount('total')
  const totalPassed = sumCount('passed')
  const totalFailed = sumCount('failed')
  const totalSkipped = sumCount('skipped')
  const suitesFailed = results.filter((r) => r.status === 'fail' || r.status === 'error').length
  const suitesSkipped = results.filter((r) => r.status === 'skip').length
  const suitesPassed = results.filter((r) => r.status === 'pass').length

  // ─── Aggregated Report ────────────────────────────────────────────────
  console.log('')
  console.log('═══════════════════════════════════════════════════════════════════════')
  console.log(`  ${COLORS.bold}qm-next · aggregated test report${COLORS.reset}`)
  console.log('═══════════════════════════════════════════════════════════════════════')
  console.log('')
  console.log('  Per-suite breakdown:')
  for (const r of results) {
    const icon = r.status === 'pass' ? `${COLORS.green}✓${COLORS.reset}`
      : r.status === 'fail' ? `${COLORS.red}✗${COLORS.reset}`
      : r.status === 'skip' ? `${COLORS.yellow}⊘${COLORS.reset}`
      : `${COLORS.red}!${COLORS.reset}`
    const stats = r.total !== null
      ? `${r.passed}/${r.total} (fail=${r.failed ?? 0} skip=${r.skipped ?? 0})`
      : r.skipReason ? `${COLORS.dim}skip: ${r.skipReason}${COLORS.reset}`
      : `${COLORS.red}error: ${r.errorMsg ?? 'unknown'}${COLORS.reset}`
    const dur = formatDuration(r.durationMs)
    console.log(`    ${icon} ${r.name.padEnd(20)} ${stats.padEnd(40)} ${COLORS.dim}${dur}${COLORS.reset}`)
  }

  console.log('')
  console.log('  -- Aggregate --')
  console.log(`    suites:   ${SUITES.length}  ${COLORS.green}(${suitesPassed} pass)${COLORS.reset} ${suitesFailed > 0 ? COLORS.red : COLORS.dim}(${suitesFailed} fail)${COLORS.reset} ${suitesSkipped > 0 ? COLORS.yellow : COLORS.dim}(${suitesSkipped} skip)${COLORS.reset}`)
  console.log(`    cases:    total=${totalCases}  ${COLORS.green}passed=${totalPassed}${COLORS.reset}  ${totalFailed > 0 ? COLORS.red : COLORS.dim}failed=${totalFailed}${COLORS.reset}  ${totalSkipped > 0 ? COLORS.yellow : COLORS.dim}skipped=${totalSkipped}${COLORS.reset}`)
  console.log(`    duration: ${formatDuration(totalWall)}`)

  if (totalFailed > 0) {
    console.log('')
    console.log('  -- Failures (last 30 lines per suite) --')
    for (const r of results.filter((x) => x.status === 'fail' || x.status === 'error')) {
      console.log('')
      console.log(`    ${COLORS.red}${r.name}${COLORS.reset} (exit=${r.exitCode})`)
      if (r.errorMsg) console.log(`      error: ${r.errorMsg}`)
      if (r.stderrTail.trim()) console.log(`      stderr tail:\n${r.stderrTail.split('\n').map((l) => '        ' + l).join('\n')}`)
      if (r.stdoutTail.trim()) console.log(`      stdout tail:\n${r.stdoutTail.split('\n').map((l) => '        ' + l).join('\n')}`)
    }
  }

  console.log('')
  console.log('═══════════════════════════════════════════════════════════════════════')
  process.exit(suitesFailed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('orchestrator crashed:', err)
  process.exit(2)
})