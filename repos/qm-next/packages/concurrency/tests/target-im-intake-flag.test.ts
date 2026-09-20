/**
 * Phase 5 slice 5.4 — `target.im-intake` RolloutFlag registration and
 * read discipline (Phase 0 ground rule 4: flags are read only through
 * the registered RolloutFlag port).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRolloutFlagRegistry,
  registerTargetImIntakeFlag,
  resolveTargetImIntake,
  TARGET_IM_INTAKE_ENV,
  TARGET_IM_INTAKE_FLAG_KEY,
} from '@qm/concurrency'

test('flag registers through the port with a conservative default', () => {
  const registry = createRolloutFlagRegistry({ env: {} })
  const flag = registerTargetImIntakeFlag(registry)
  assert.equal(flag.key, TARGET_IM_INTAKE_FLAG_KEY)
  assert.equal(flag.read(), false, 'legacy path stays authoritative by default')
  assert.equal(flag.meta().envOverride, TARGET_IM_INTAKE_ENV)
  assert.ok(flag.meta().removalTask, 'removal task recorded for the Phase 7 checklist')
  assert.equal(flag.meta().introducedIn, 'phase-5-slice-5.4')
})

test('env override flips the flag through the port only', () => {
  const registry = createRolloutFlagRegistry({ env: { [TARGET_IM_INTAKE_ENV]: '1' } })
  registerTargetImIntakeFlag(registry)
  assert.equal(resolveTargetImIntake(registry), true)
  const off = createRolloutFlagRegistry({ env: { [TARGET_IM_INTAKE_ENV]: 'false' } })
  registerTargetImIntakeFlag(off)
  assert.equal(resolveTargetImIntake(off), false, 'only 1/true flip the flag')
})

test('duplicate registration throws; unregistered flag resolves false', () => {
  const registry = createRolloutFlagRegistry({ env: {} })
  registerTargetImIntakeFlag(registry)
  assert.throws(() => registerTargetImIntakeFlag(registry))
  const fresh = createRolloutFlagRegistry({ env: {} })
  assert.equal(resolveTargetImIntake(fresh), false, 'conservative default when unregistered')
})
