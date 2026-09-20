/**
 * Phase 4 — Triggers architecture boundary tests.
 *
 * Covers plan §Phase 4 Boundary tests:
 *   - `packages/triggers` does not depend on `@qm/api`.
 *   - `packages/api` does not import Trigger implementation for runtime
 *     dispatch (the leader lease is the only such import).
 *   - No runtime code assigns `api.cronsRuntime`.
 *   - Architecture gate rejects the former cycle.
 *
 * ADR-0003 invariant: the cycle is broken.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// tests/ -> triggers/ -> packages/ -> repo root
const ROOT = join(import.meta.dirname, '..', '..', '..')

test('architecture: packages/triggers/package.json does not declare @qm/api dependency', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/triggers/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  assert.equal(deps['@qm/api'], undefined, '@qm/api must NOT be a deps of @qm/triggers (ADR-0003)')
})

test('architecture: no source file under packages/triggers imports @qm/api', () => {
  // Walk packages/triggers/src and assert no file contains `from '@qm/api'`.
  // The architecture gate (`pnpm test:architecture`) enforces the same rule
  // by inspecting dependency direction; this is the inline companion.
  const offenders: string[] = []
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      const content = readFileSync(full, 'utf8')
      if (/from\s+['"]@qm\/api['"]/.test(content)) {
        offenders.push(full)
      }
    }
  }
  walk(join(ROOT, 'packages/triggers/src'))
  assert.deepEqual(offenders, [], `Triggers must not import @qm/api; offenders: ${offenders.join(', ')}`)
})

test('architecture: TriggersService inject uses trigger-runtime, not api', () => {
  const src = readFileSync(join(ROOT, 'packages/triggers/src/service.ts'), 'utf8')
  assert.match(src, /inject\s*=\s*\[[^\]]*['"]trigger-runtime['"]/)
  assert.doesNotMatch(src, /inject\s*=\s*\[[^\]]*['"]api['"]/)
})

test('architecture: the api.cronsRuntime compatibility field is removed (Phase 7 / KV-002)', () => {
  // Phase 7 cutover: NO runtime code may declare, write, or read the
  // `api.cronsRuntime` compatibility field. Cron schedule storage lives
  // behind the Trigger boundary; consumers read the Cordis service
  // registry lazily (ADR-0003, plan §4.6).
  const offenders: string[] = []
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      const content = readFileSync(full, 'utf8')
      if (/cronsRuntime/.test(content)) offenders.push(full)
    }
  }
  walk(join(ROOT, 'packages/api/src'))
  walk(join(ROOT, 'packages/triggers/src'))
  assert.deepEqual(offenders, [], `api.cronsRuntime compatibility field must be gone; offenders: ${offenders.join(', ')}`)
})

test('architecture: @qm/api no longer imports createMemoryLeaderLease from @qm/triggers', () => {
  const src = readFileSync(join(ROOT, 'packages/api/src/service.ts'), 'utf8')
  // The leader lease is in @qm/concurrency (Phase 4 §4.6).
  assert.doesNotMatch(src, /createMemoryLeaderLease.*from\s+['"]@qm\/triggers['"]/)
})

test('architecture: leader-lease primitive lives in @qm/concurrency', () => {
  const exists = existsSync(join(ROOT, 'packages/concurrency/src/leader-lease.ts'))
  assert.ok(exists, 'packages/concurrency/src/leader-lease.ts must exist (Phase 4 §4.6)')
})

test('architecture: @qm/triggers re-exports createMemoryLeaderLease from @qm/concurrency for backward compat', () => {
  const src = readFileSync(join(ROOT, 'packages/triggers/src/lease.ts'), 'utf8')
  assert.match(src, /export\s*\{[^}]*createMemoryLeaderLease[^}]*\}\s*from\s+['"]@qm\/concurrency['"]/)
})