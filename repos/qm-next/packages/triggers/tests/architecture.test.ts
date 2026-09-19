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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..', '..')

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
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const offenders: string[] = []
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      const content = fs.readFileSync(full, 'utf8')
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

test('architecture: TriggersService no longer writes api.cronsRuntime', () => {
  const src = readFileSync(join(ROOT, 'packages/triggers/src/service.ts'), 'utf8')
  assert.doesNotMatch(src, /api\.cronsRuntime\s*=/)
})

test('architecture: @qm/api no longer imports createMemoryLeaderLease from @qm/triggers', () => {
  const src = readFileSync(join(ROOT, 'packages/api/src/service.ts'), 'utf8')
  // The leader lease is in @qm/concurrency (Phase 4 §4.6).
  assert.doesNotMatch(src, /createMemoryLeaderLease.*from\s+['"]@qm\/triggers['"]/)
})

test('architecture: leader-lease primitive lives in @qm/concurrency', () => {
  const fs = require('node:fs') as typeof import('node:fs')
  const exists = fs.existsSync(join(ROOT, 'packages/concurrency/src/leader-lease.ts'))
  assert.ok(exists, 'packages/concurrency/src/leader-lease.ts must exist (Phase 4 §4.6)')
})

test('architecture: @qm/triggers re-exports createMemoryLeaderLease from @qm/concurrency for backward compat', () => {
  const src = readFileSync(join(ROOT, 'packages/triggers/src/lease.ts'), 'utf8')
  assert.match(src, /export\s*\{[^}]*createMemoryLeaderLease[^}]*\}\s*from\s+['"]@qm\/concurrency['"]/)
})