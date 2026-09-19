/**
 * qm-next Sandbox Command-Policy Test (Phase 3J, closes §U26.1 fully)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Purpose
 * -------
 *   Verifies the Phase 3J command-policy guard: every `Sandbox.run` call
 *   is filtered against a `CommandPolicy` (default-denylist or custom)
 *   before the docker exec call. On a policy match, `run` returns a
 *   `{code: 1, stderr: '[policy denied: ...]'}`, OR throws `CommandDenied`
 *   when `opts.throwOnPolicy` is set. The dangerous shell / SQL primitives
 *   the screener flags (§U26.2) plus the catastrophic host-level patterns
 *   (`rm -rf /`, fork bombs, mkfs, etc.) are caught here as a second line
 *   of defence.
 *
 * Three layers
 * ------------
 *   L1 unit: `evaluateCommandPolicy` against the built-in default denylist.
 *            No docker, no network.
 *   L2 unit: `evaluateCommandPolicy` against a custom allowlist — proves
 *            default-deny behaviour matches the spec.
 *   L3 integration: `createLocalSandbox({policy: 'default-denylist'})` +
 *            real docker. `rm -rf /` must return code 1 + `[policy denied]`
 *            WITHOUT reaching the container. Also confirms a benign
 *            command (`echo hello`) still passes through.
 *
 * Run
 * ---
 *   node --import tsx/esm scripts/qa-sandbox-policy.ts
 *
 * Associated docs
 * ---------------
 *   - docs/testing/real-device-coverage.md  (Phase 3J §U26.1 closure)
 *   - packages/sandbox/src/policy.ts         (evaluator)
 *   - packages/sandbox/src/default-policy.ts (built-in patterns)
 *   - packages/sandbox/src/local-sandbox.ts  (gate in `run`)
 */

import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const QM_NEXT_ROOT = join(__dirname, '..')

const typesMod = await import(`${QM_NEXT_ROOT}/packages/types/src/index.ts`)
const { CommandDenied, NeedsApproval } = typesMod

const sandboxMod = await import(`${QM_NEXT_ROOT}/packages/sandbox/src/index.ts`)
const {
  createLocalSandbox,
  evaluateCommandPolicy,
  defaultDenylistPolicy,
  DEFAULT_DENYLIST_PATTERNS,
} = sandboxMod

// ════════════════════════════════════════════════════════════════════════
// Results tracking
// ════════════════════════════════════════════════════════════════════════

type Result =
  | { name: string; ok: true; detail: Record<string, unknown> }
  | { name: string; ok: false; reason: string }

const results: Result[] = []

async function scenario(name: string, fn: () => Promise<Record<string, unknown>> | Record<string, unknown>): Promise<void> {
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
// L1 unit tests: built-in denylist
// ════════════════════════════════════════════════════════════════════════

console.log('\n§P1 Default denylist — every pattern must trigger deny')

const policy = defaultDenylistPolicy()
const POSITIVE: ReadonlyArray<{ name: string; cmd: string }> = [
  { name: 'rm -rf /', cmd: 'rm -rf /' },
  { name: 'rm -rf --no-preserve-root /', cmd: 'rm -rf --no-preserve-root /' },
  { name: 'rm -rf /etc', cmd: 'rm -rf /etc' },
  { name: 'rm -fr /var', cmd: 'rm -fr /var' },
  { name: 'mkfs.ext4 /dev/sda1', cmd: 'mkfs.ext4 /dev/sda1' },
  { name: 'dd if=/dev/sda of=/dev/null', cmd: 'dd if=/dev/sda of=/dev/null' },
  { name: 'dd of=/dev/nvme0n1', cmd: 'dd of=/dev/nvme0n1' },
  { name: 'fork bomb', cmd: ':(){ :|:& };:' },
  { name: 'dd if=/dev/zero of=/big', cmd: 'dd if=/dev/zero of=/big' },
  { name: 'chown -R root /', cmd: 'chown -R root /' },
  { name: 'chmod -R 777 /', cmd: 'chmod -R 777 /' },
  { name: 'DROP TABLE users', cmd: 'DROP TABLE users;' },
  { name: 'DROP DATABASE foo', cmd: 'DROP DATABASE foo;' },
  { name: 'TRUNCATE TABLE foo', cmd: 'TRUNCATE TABLE foo;' },
]
for (const t of POSITIVE) {
  await scenario(`P1.${t.name} → deny`, () => {
    const v = evaluateCommandPolicy(t.cmd, policy)
    if (v.decision !== 'deny') throw new Error(`expected deny, got ${v.decision} matched=${v.matched}`)
    if (!v.reason) throw new Error(`reason missing`)
    return { cmd: t.cmd, decision: v.decision, reason: v.reason }
  })
}

console.log('\n§P2 Default denylist — benign commands must pass')

const NEGATIVE: ReadonlyArray<{ name: string; cmd: string }> = [
  { name: 'echo hello', cmd: 'echo hello' },
  { name: 'ls -la /tmp', cmd: 'ls -la /tmp' },
  { name: 'rm -rf /tmp/foo (target dir, not /)', cmd: 'rm -rf /tmp/foo' },
  { name: 'rm -rf ./build', cmd: 'rm -rf ./build' },
  { name: 'git log --oneline', cmd: 'git log --oneline' },
  { name: 'cat README.md', cmd: 'cat README.md' },
]
for (const t of NEGATIVE) {
  await scenario(`P2.${t.name} → allow`, () => {
    const v = evaluateCommandPolicy(t.cmd, policy)
    if (v.decision !== 'allow') throw new Error(`expected allow, got ${v.decision} matched=${v.matched}`)
    return { cmd: t.cmd, decision: v.decision }
  })
}

// ════════════════════════════════════════════════════════════════════════
// L2 unit tests: allowlist mode (default-deny semantics)
// ════════════════════════════════════════════════════════════════════════

console.log('\n§P3 Allowlist mode — unmatched → deny (closed by default)')

const allowlist = {
  mode: 'allowlist' as const,
  rules: [
    { pattern: '^echo\\s', decision: 'allow' as const, reason: 'echo allowed' },
    { pattern: '^rm\\s+.*\\s+/dev/', decision: 'deny' as const, reason: 'rm on /dev forbidden' },
  ],
}

await scenario('P3.1 allowlist: matched allow → allow', () => {
  const v = evaluateCommandPolicy('echo hello world', allowlist)
  if (v.decision !== 'allow') throw new Error(`expected allow, got ${v.decision}`)
  return { decision: v.decision, matched: v.matched }
})
await scenario('P3.2 allowlist: matched deny → deny', () => {
  const v = evaluateCommandPolicy('rm /dev/null foo', allowlist)
  if (v.decision !== 'deny') throw new Error(`expected deny, got ${v.decision}`)
  return { decision: v.decision, matched: v.matched }
})
await scenario('P3.3 allowlist: unmatched → deny (default-deny)', () => {
  const v = evaluateCommandPolicy('cat /etc/passwd', allowlist)
  if (v.decision !== 'deny') throw new Error(`expected deny, got ${v.decision}`)
  return { decision: v.decision, matched: v.matched }
})

// ════════════════════════════════════════════════════════════════════════
// L2 unit tests: require_approval decision
// ════════════════════════════════════════════════════════════════════════

console.log('\n§P4 require_approval decision — flows through evaluator')

await scenario('P4.1 require_approval pattern → require_approval', () => {
  const pol = {
    mode: 'denylist' as const,
    rules: [{ pattern: '^sudo\\s', decision: 'require_approval' as const, reason: 'sudo needs human OK' }],
  }
  const v = evaluateCommandPolicy('sudo apt-get install', pol)
  if (v.decision !== 'require_approval') throw new Error(`expected require_approval, got ${v.decision}`)
  return { decision: v.decision, reason: v.reason }
})

// ════════════════════════════════════════════════════════════════════════
// L3 integration: real docker + Sandbox.run gate
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
  skip('P5.1 docker: `rm -rf /` → code 1 + [policy denied] stderr', `sandbox image ${SANDBOX_IMAGE} missing`)
  skip('P5.2 docker: `echo hello` → code 0 (allowed)', `sandbox image ${SANDBOX_IMAGE} missing`)
  skip('P5.3 docker: throwOnPolicy=true → throws CommandDenied', `sandbox image ${SANDBOX_IMAGE} missing`)
} else {
  console.log('\n§P5 Real-docker integration — Sandbox.run gate')

  const sandbox = createLocalSandbox({ repoRoot: QM_NEXT_ROOT, policy: 'default-denylist' })
  const scopeId = `personal:qa-policy-real-${Date.now()}`

  let handle: Awaited<ReturnType<typeof sandbox.provision>> | undefined

  await scenario('P5.1 docker: `rm -rf /` → code 1 + [policy denied] stderr', async () => {
    handle = await sandbox.provision([{ scopeId, mountPath: 'global', mode: 'rw' }])
    if (!handle) throw new Error('provision returned no handle')
    const result = await sandbox.run(handle, 'rm -rf /')
    if (result.code !== 1) throw new Error(`expected code=1, got ${result.code}`)
    if (!/\[policy denied/.test(result.stderr)) throw new Error(`expected stderr to contain [policy denied, got: ${result.stderr}`)
    if (!/catastrophic/.test(result.stderr)) throw new Error(`expected reason to mention catastrophic, got: ${result.stderr}`)
    return { code: result.code, stderr: result.stderr.slice(0, 200) }
  })

  await scenario('P5.2 docker: `echo hello` → code 0 (allowed)', async () => {
    if (!handle) throw new Error('no handle from P5.1')
    const result = await sandbox.run(handle, 'echo hello')
    if (result.code !== 0) throw new Error(`expected code=0, got ${result.code} stderr=${result.stderr}`)
    if (!/hello/.test(result.stdout)) throw new Error(`expected stdout to contain hello, got: ${result.stdout}`)
    return { code: result.code, stdout: result.stdout.trim() }
  })

  await scenario('P5.3 docker: throwOnPolicy=true → throws CommandDenied', async () => {
    if (!handle) throw new Error('no handle from P5.1')
    let thrown: unknown = null
    try {
      await sandbox.run(handle, 'rm -rf /', { throwOnPolicy: true })
    } catch (e) {
      thrown = e
    }
    if (!thrown) throw new Error('expected CommandDenied to be thrown')
    if (!(thrown instanceof CommandDenied)) throw new Error(`expected CommandDenied, got ${(thrown as Error).name}`)
    return { thrownName: thrown.name, message: thrown.message }
  })

  await scenario('P5.4 docker: throwOnPolicy=true → throws NeedsApproval for require_approval', async () => {
    if (!handle) throw new Error('no handle from P5.1')
    // Custom sandbox with a require_approval rule for `touch /etc/*` (config files)
    const approvalPolicy = {
      mode: 'denylist' as const,
      rules: [{ pattern: '^touch\\s+/etc/', decision: 'require_approval' as const, reason: 'touch on /etc needs human OK' }],
    }
    const sb2 = createLocalSandbox({ repoRoot: QM_NEXT_ROOT, policy: approvalPolicy })
    const h2 = await sb2.provision([{ scopeId: scopeId + '-2', mountPath: 'global', mode: 'rw' }])
    let thrown: unknown = null
    try {
      await sb2.run(h2, 'touch /etc/some-config', { throwOnPolicy: true })
    } catch (e) {
      thrown = e
    }
    if (!thrown) throw new Error('expected NeedsApproval to be thrown')
    if (!(thrown instanceof NeedsApproval)) throw new Error(`expected NeedsApproval, got ${(thrown as Error).name}`)
    await sb2.teardown(h2, { destroy: true })
    return { thrownName: thrown.name, message: thrown.message }
  })

  await scenario('P5.5 docker: teardown', async () => {
    if (!handle) throw new Error('no handle from P5.1')
    await sandbox.teardown(handle, { destroy: true })
    return { tornDown: true }
  })
}

// ════════════════════════════════════════════════════════════════════════
// Report
// ════════════════════════════════════════════════════════════════════════

const passed = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok && !r.reason.startsWith('SKIP')).length
const skipped = results.filter((r) => !r.ok && r.reason.startsWith('SKIP')).length

console.log('\n═══════════════════════════════════════════════════════════════════════')
console.log('  qm-next Sandbox Command-Policy Report')
console.log('═══════════════════════════════════════════════════════════════════════')
console.log(`  Patterns in default denylist: ${DEFAULT_DENYLIST_PATTERNS.length}`)
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