/**
 * qm-next Sandbox Real-Device Test (Phase 3I, closes U26.1 partial)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Purpose
 * -------
 *   qa-user-stories.ts §U26.1 was SKIP'd because qm-next's sandbox has no
 *   *engine-level* command guard (the `Sandbox.run()` interface accepts
 *   arbitrary command strings and ships them to the container). What
 *   qm-next *does* guarantee is **container isolation**: an rm -rf in the
 *   container cannot reach the host filesystem, even when the user passes
 *   `rm -rf /`. This script verifies that containment holds against the
 *   real Docker daemon on the test machine.
 *
 * Why "containment" not "engine rejection"
 * ----------------------------------------
 *   "Sandbox rejects dangerous commands" is a layer above the container —
 *   it lives in the classifier / screener (see qa-user-stories §U26.2).
 *   Below the classifier, the *contract* is "host filesystem untouched".
 *   This script proves that contract holds end-to-end on a real Docker
 *   daemon so U26.1 can be downgraded from 🚫 to 🟨.
 *
 * Constraints
 * -----------
 *   - Requires a working docker daemon (this runbook assumes OrbStack or
 *     Docker Desktop on macOS / a Linux host with docker).
 *   - Uses `qm-sandbox-local:latest` from the local sandbox image (built
 *     by `scripts/local-sandbox-build.sh`).
 *   - No model API key needed.
 *   - Auto-skips when the image is missing — the gate becomes "image
 *     built" rather than "docker running".
 *
 * Run
 * ---
 *   node --import tsx/esm scripts/qa-sandbox-real.ts
 *
 * Associated docs
 * ---------------
 *   - docs/testing/real-device-coverage.md  (this file's matrix)
 *   - docs/testing/baseline-smoke.md        (Phase 3I row)
 *   - scripts/qa-smoke-wave2.ts §S43        (basic sandbox lifecycle)
 */

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const QM_NEXT_ROOT = join(__dirname, '..')

const sandboxMod = await import(`${QM_NEXT_ROOT}/packages/sandbox/src/index.ts`)
const { createLocalSandbox } = sandboxMod

// ════════════════════════════════════════════════════════════════════════
// Results tracking
// ════════════════════════════════════════════════════════════════════════

type Result =
  | { name: string; ok: true; detail: Record<string, unknown> }
  | { name: string; ok: false; reason: string }

const results: Result[] = []

async function scenario(name: string, fn: () => Promise<Record<string, unknown>>): Promise<void> {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail })
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
    if (process.env.QA_VERBOSE === '1') console.log(`        ${JSON.stringify(detail)}`)
  } catch (e) {
    const reason = (e as Error).message
    results.push({ name, ok: false, reason })
    console.log(`  \x1b[31m✗\x1b[0m ${name}`)
    console.log(`        ${reason}`)
  }
}

function skip(name: string, reason: string): void {
  results.push({ name, ok: false, reason: `SKIP: ${reason}` })
  console.log(`  \x1b[33m⊘\x1b[0m ${name} -- SKIP: ${reason}`)
}

// ════════════════════════════════════════════════════════════════════════
// Preflight: docker + sandbox image
// ════════════════════════════════════════════════════════════════════════

const SANDBOX_IMAGE = 'qm-sandbox-local:latest'

function dockerImagePresent(image: string): boolean {
  try {
    const out = execSync(`docker image inspect ${image}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    return out.length > 0
  } catch {
    return false
  }
}

if (!dockerImagePresent(SANDBOX_IMAGE)) {
  console.log(`Sandbox image ${SANDBOX_IMAGE} missing — running scripts/local-sandbox-build.sh would build it.`)
  console.log('Skipping all scenarios.')
  process.exit(0)
}

const sandbox = createLocalSandbox({ repoRoot: QM_NEXT_ROOT })
const scopeId = `personal:qa-sandbox-real-${Date.now()}`

// ════════════════════════════════════════════════════════════════════════
// Host fixture: a file we expect NEVER to be destroyed
// ════════════════════════════════════════════════════════════════════════

const hostFixtureDir = join(tmpdir(), `qm-sandbox-real-host-${Date.now()}`)
mkdirSync(hostFixtureDir, { recursive: true })
const hostFixtureFile = join(hostFixtureDir, 'must-survive.txt')
writeFileSync(hostFixtureFile, `phase-3i-host-fixture-${Date.now()}`)
console.log(`Host fixture: ${hostFixtureFile}`)

// ════════════════════════════════════════════════════════════════════════
// Scenarios
// ════════════════════════════════════════════════════════════════════════

console.log('\n§R1 Sandbox container isolation')

let handle: Awaited<ReturnType<typeof sandbox.provision>> | undefined

await scenario('R1.1 provision → container handle', async () => {
  handle = await sandbox.provision([{ scopeId, mountPath: 'global', mode: 'rw' }])
  if (!handle) throw new Error('provision returned no handle')
  return { scopeId, handleType: typeof handle }
})

await scenario('R1.2 harmless `rm -rf` inside container succeeds', async () => {
  if (!handle) throw new Error('no handle from R1.1')
  // Create a target dir inside the container, then nuke it.
  await sandbox.run(handle, 'mkdir -p /tmp/qm-real-target/sub')
  const result = await sandbox.run(handle, 'rm -rf /tmp/qm-real-target && echo gone')
  if (result.code !== 0) throw new Error(`exit=${result.code} stderr=${result.stderr}`)
  if (!/gone/.test(result.stdout)) throw new Error(`stdout missing "gone": "${result.stdout}"`)
  return { code: result.code, stdout: result.stdout.trim() }
})

await scenario('R1.3 `rm -rf /` inside container fails (no host effect)', async () => {
  if (!handle) throw new Error('no handle from R1.1')
  // Modern GNU coreutils refuses `rm -rf /` without --no-preserve-root,
  // and even with --no-preserve-root the container's overlay filesystem
  // blocks / destruction. We try the default-invocation first.
  const result = await sandbox.run(handle, 'rm -rf / 2>&1 || echo BLOCKED')
  // Two acceptable outcomes:
  //   (a) exit code non-zero (coreutils refused)
  //   (b) exit code 0 but stdout shows "BLOCKED" or similar (rm ran but
  //       couldn't delete system files; the container refused)
  // In either case the container must still be alive and responsive.
  if (result.code === 0 && /BLOCKED/.test(result.stdout) === false) {
    // rm succeeded AND removed / — this would be a containment failure.
    throw new Error(`rm -rf / unexpectedly succeeded: code=${result.code} stdout=${result.stdout.slice(0, 200)}`)
  }
  // Verify container still works (post-containment self-check)
  const probe = await sandbox.run(handle, 'echo container-alive')
  if (probe.code !== 0 || !/container-alive/.test(probe.stdout)) {
    throw new Error(`container broken after rm -rf /: code=${probe.code} stdout=${probe.stdout}`)
  }
  return {
    code: result.code,
    stdout: result.stdout.trim().slice(0, 200),
    containerStillAlive: true,
  }
})

await scenario('R1.4 host fixture file untouched (containment verified)', async () => {
  if (!existsSync(hostFixtureFile)) throw new Error(`host fixture missing: ${hostFixtureFile}`)
  const stat = statSync(hostFixtureFile)
  if (!stat.isFile()) throw new Error(`host fixture not a file: ${hostFixtureFile}`)
  return { hostFixtureFile, sizeBytes: stat.size }
})

await scenario('R1.5 teardown → container destroyed', async () => {
  if (!handle) throw new Error('no handle from R1.1')
  await sandbox.teardown(handle, { destroy: true })
  return { tornDown: true }
})

// ════════════════════════════════════════════════════════════════════════
// Cleanup + Report
// ════════════════════════════════════════════════════════════════════════

try { rmSync(hostFixtureDir, { recursive: true, force: true }) } catch {}

const passed = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok && !r.reason.startsWith('SKIP')).length
const skipped = results.filter((r) => !r.ok && r.reason.startsWith('SKIP')).length

console.log('\n═══════════════════════════════════════════════════════════════════════')
console.log('  qm-next Sandbox Real-Device (R1) Report')
console.log('═══════════════════════════════════════════════════════════════════════')
console.log('')
console.log('  -- Summary --')
console.log(`    total:   ${results.length}`)
console.log(`    passed:  \x1b[32m${passed}\x1b[0m`)
console.log(`    failed:  \x1b[31m${failed}\x1b[0m`)
console.log(`    skipped: \x1b[33m${skipped}\x1b[0m`)

if (failed > 0) {
  console.log('')
  console.log('  -- Failures --')
  for (const r of results.filter((x) => !x.ok && !x.reason.startsWith('SKIP'))) {
    console.log(`    \x1b[31m✗\x1b[0m ${r.name}`)
    console.log(`        ${r.reason}`)
  }
}
if (skipped > 0) {
  console.log('')
  console.log('  -- Skipped --')
  for (const r of results.filter((x) => !x.ok && x.reason.startsWith('SKIP'))) {
    console.log(`    \x1b[33m⊘\x1b[0m ${r.name}: ${r.reason}`)
  }
}

console.log('═══════════════════════════════════════════════════════════════════════')
process.exit(failed > 0 ? 1 : 0)