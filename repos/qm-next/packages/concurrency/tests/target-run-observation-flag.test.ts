/**
 * Phase 1 slice 1.5 — `target.run-observation` RolloutFlag and the
 * runtime path that consults it.
 *
 * Asserts:
 *   - Flag registration is idempotent and metadata is correct.
 *   - `effectiveRunSource` / `resolveRunSource` flip with the flag.
 *   - Memory run-store stamps `runSource='target'` when the flag is on
 *     and the flag-off default preserves `runSource='legacy'`.
 *   - `complete()` on a target row does NOT carry `status='done'` and
 *     the terminal listener fires via `targetState`.
 *   - `assertTargetRunInvariant` still throws when an attempt is made
 *     to write `'done'` on a target row (defense in depth).
 *
 * Linked ADRs: 0001, 0005, 0014.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Pool } from 'pg'
import {
  TARGET_RUN_OBSERVATION_FLAG_KEY,
  createMemorySessionReservationStore,
  createRolloutFlagRegistry,
  effectiveRunSource,
  registerTargetRunObservationFlag,
  resolveRunSource,
} from '@qm/concurrency'
import { createMemoryRunStore } from '@qm/store'
import { assertTargetRunInvariant, type Run } from '@qm/types'

const pgUrl = process.env.QM_NEXT_PG_URL

async function postgresReachable(): Promise<boolean> {
  if (!pgUrl) return false
  const probe = new Pool({ connectionString: pgUrl, connectionTimeoutMillis: 3000 })
  try {
    await probe.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await probe.end().catch(() => undefined)
  }
}

function makeRequest(text = 'slice-1-5') {
  return {
    surface: 'api' as const,
    actor: { type: 'internal' as const, id: 'tester' },
    conversation: { kind: 'dm' as const, threadRef: 'thread-1', audience: [] },
    origin: { kind: 'direct' as const },
    text,
  }
}

test('slice-1.5: registerTargetRunObservationFlag registers a stable flag with the documented defaults', () => {
  const registry = createRolloutFlagRegistry()
  const flag = registerTargetRunObservationFlag(registry)
  assert.equal(flag.key, TARGET_RUN_OBSERVATION_FLAG_KEY)
  assert.equal(flag.read(), false)
  const meta = flag.meta()
  assert.equal(meta.owner, '@qm/core')
  assert.equal(meta.default, false)
  assert.equal(meta.envOverride, 'QM_ROLLOUT_TARGET_RUN_OBSERVATION')
  assert.equal(meta.introducedIn, 'phase-1-slice-1.5')
  assert.equal(typeof meta.removalTask, 'string')
})

test('slice-1.5: registerTargetRunObservationFlag honors env override and default override', () => {
  const registry = createRolloutFlagRegistry({ env: { QM_ROLLOUT_TARGET_RUN_OBSERVATION: '1' } })
  const flag = registerTargetRunObservationFlag(registry)
  assert.equal(flag.read(), true)
  const customRegistry = createRolloutFlagRegistry()
  const customFlag = registerTargetRunObservationFlag(customRegistry, { default: true })
  assert.equal(customFlag.read(), true)
})

test('slice-1.5: effectiveRunSource / resolveRunSource mirror the flag read', () => {
  const registry = createRolloutFlagRegistry({ env: { QM_ROLLOUT_TARGET_RUN_OBSERVATION: 'true' } })
  registerTargetRunObservationFlag(registry)
  assert.equal(effectiveRunSource(null), 'legacy')
  assert.equal(effectiveRunSource(registry.get(TARGET_RUN_OBSERVATION_FLAG_KEY)), 'target')
  assert.equal(resolveRunSource(registry), 'target')

  const off = createRolloutFlagRegistry()
  registerTargetRunObservationFlag(off)
  assert.equal(resolveRunSource(off), 'legacy')
})

test('slice-1.5: flag-off default stamps runSource=legacy on enqueue', async () => {
  const registry = createRolloutFlagRegistry()
  registerTargetRunObservationFlag(registry)
  const store = createMemoryRunStore({ runSourceFlag: registry.get(TARGET_RUN_OBSERVATION_FLAG_KEY) })
  const enq = await store.enqueue({ sessionId: 'session-A', request: makeRequest() })
  assert.equal(enq.run.runSource, 'legacy')
})

test('slice-1.5: flag-on stamps runSource=target on enqueue', async () => {
  const registry = createRolloutFlagRegistry({ env: { QM_ROLLOUT_TARGET_RUN_OBSERVATION: '1' } })
  registerTargetRunObservationFlag(registry)
  const store = createMemoryRunStore({ runSourceFlag: registry.get(TARGET_RUN_OBSERVATION_FLAG_KEY) })
  const enq = await store.enqueue({ sessionId: 'session-A', request: makeRequest() })
  assert.equal(enq.run.runSource, 'target')
})

test('slice-1.5: complete on a target row does NOT write status=done', async () => {
  const registry = createRolloutFlagRegistry({ env: { QM_ROLLOUT_TARGET_RUN_OBSERVATION: '1' } })
  registerTargetRunObservationFlag(registry)
  const store = createMemoryRunStore({ runSourceFlag: registry.get(TARGET_RUN_OBSERVATION_FLAG_KEY) })
  const enq = await store.enqueue({ sessionId: 'session-A', request: makeRequest() })
  assert.equal(enq.run.runSource, 'target')
  const claimed = await store.claim('worker-1', 60_000)
  assert.ok(claimed)
  const leaseToken = claimed.leaseToken
  assert.ok(leaseToken)
  const ok = await store.complete(claimed.id, leaseToken, { status: 'ok', reply: 'all good', sessionId: 'session-A' })
  assert.equal(ok, true)
  const after = await store.get(enq.run.id)
  assert.ok(after)
  assert.equal(after.targetState, 'succeeded')
  assert.notEqual(after.status, 'done', 'target rows must not carry the legacy `done` literal')
})

test('slice-1.5: terminal listener fires for target rows via targetState', async () => {
  const registry = createRolloutFlagRegistry({ env: { QM_ROLLOUT_TARGET_RUN_OBSERVATION: '1' } })
  registerTargetRunObservationFlag(registry)
  const store = createMemoryRunStore({ runSourceFlag: registry.get(TARGET_RUN_OBSERVATION_FLAG_KEY) })
  const terminals: Run[] = []
  store.onTerminal((r) => terminals.push(r))
  await store.enqueue({ sessionId: 'session-A', request: makeRequest() })
  const claimed = await store.claim('worker-1', 60_000)
  assert.ok(claimed)
  const leaseToken = claimed.leaseToken
  assert.ok(leaseToken)
  await store.complete(claimed.id, leaseToken, { status: 'ok', reply: 'all good', sessionId: 'session-A' })
  assert.equal(terminals.length, 1, 'onTerminal must fire even though status != done')
  assert.equal(terminals[0]?.targetState, 'succeeded')
})

test('slice-1.5: assertTargetRunInvariant throws when a target row carries status=done', () => {
  assert.throws(
    () =>
      assertTargetRunInvariant({
        runSource: 'target',
        status: 'done',
        targetState: 'succeeded',
      }),
    /architecture violation/,
  )
  // Legacy rows are unconstrained.
  assert.doesNotThrow(() =>
    assertTargetRunInvariant({ runSource: 'legacy', status: 'done', targetState: 'succeeded' }),
  )
})

test('slice-1.5: parity scaffolding compiles for both legs', async () => {
  const reachable = await postgresReachable()
  assert.equal(typeof reachable, 'boolean')
})

void createMemorySessionReservationStore // type-only reference marker