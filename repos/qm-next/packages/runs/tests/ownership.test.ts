/**
 * Background ownership contract suite (M-Soul-3 C, 2026-09-26).
 *
 * Asserts the type-discipline lane for ADR-0020:
 *
 * 1. `isTransferToken` accepts structurally-valid token shapes and
 *    rejects malformed / primitive / null inputs.
 * 2. `isOwnershipLease` accepts structurally-valid lease shapes and
 *    rejects malformed / primitive / null inputs.
 * 3. `tryHandoverOwnership` throws `OWNERSHIP_NOT_IMPLEMENTED` (loud,
 *    fail-closed) — a no-op return would let callers believe a handover
 *    succeeded and start a background-work claim under the new
 *    deployment. The pinned reason string is observable for P5 21.0
 *    regression detection.
 * 4. `acceptHandover` throws the same pinned reason.
 * 5. The existing `createEcsTaskProtection` path is unaffected
 *    (additive re-export only — no behavior change).
 *
 * Source-of-truth: `docs/adr/0020-background-ownership-types.md`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Ownership, OwnershipLease, TransferToken } from '@qm/types'
import {
  acceptHandover,
  isOwnershipLease,
  isTransferToken,
  OWNERSHIP_NOT_IMPLEMENTED,
  tryHandoverOwnership,
} from '../src/ownership.ts'
import { createEcsTaskProtection } from '../src/task-protection.ts'

function makeOwnership(): Ownership {
  return {
    deploymentId: 'core:release-a',
    generation: 3,
    acceptedAt: 1_700_000_003_000,
    members: [
      {
        instanceId: 'inst-1',
        deploymentId: 'core:release-a',
        taskArn: 'arn:aws:ecs:us-east-1:000000000000:task/core-a/00000000000000000000000000000001',
        state: 'admitted',
        generation: 3,
        acknowledgedAt: 1_700_000_003_000,
      },
    ],
  }
}

function makeTransferToken(): TransferToken {
  return {
    token: 'opaque-sealed-credential-string',
    acceptedDeploymentId: 'core:release-b',
    sourceDeploymentId: 'core:release-a',
    expiresAt: 1_700_000_009_000,
    nonce: '6a8e3b2c-1d4f-4e9a-8c0b-2f5d7e9a1c3b',
  }
}

function makeOwnershipLease(): OwnershipLease {
  return {
    instanceId: 'inst-1',
    ownership: makeOwnership(),
    claimKind: 'run',
    claimId: 'run-42',
    claimToken: 'sealed-claim-credential-string',
    expiresAt: 1_700_000_009_000,
  }
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

test('isTransferToken accepts a structurally-valid token', () => {
  assert.equal(isTransferToken(makeTransferToken()), true)
})

test('isTransferToken rejects primitives, null, and arrays', () => {
  assert.equal(isTransferToken(null), false)
  assert.equal(isTransferToken(undefined), false)
  assert.equal(isTransferToken(''), false)
  assert.equal(isTransferToken(42), false)
  assert.equal(isTransferToken(true), false)
  assert.equal(isTransferToken([]), false)
  assert.equal(isTransferToken('not-an-object'), false)
})

test('isTransferToken rejects tokens with empty or wrong-typed fields', () => {
  const t = makeTransferToken()
  assert.equal(isTransferToken({ ...t, token: '' }), false)
  assert.equal(isTransferToken({ ...t, token: 42 as unknown as string }), false)
  assert.equal(isTransferToken({ ...t, acceptedDeploymentId: '' }), false)
  assert.equal(isTransferToken({ ...t, sourceDeploymentId: undefined as unknown as string }), false)
  assert.equal(isTransferToken({ ...t, expiresAt: 0 }), false)
  assert.equal(isTransferToken({ ...t, expiresAt: -1 }), false)
  assert.equal(isTransferToken({ ...t, expiresAt: NaN }), false)
  assert.equal(isTransferToken({ ...t, nonce: '' }), false)
})

test('isTransferToken rejects objects missing required keys', () => {
  const t = makeTransferToken()
  const { token: _t, ...withoutToken } = t
  assert.equal(isTransferToken(withoutToken), false)
  const { nonce: _n, ...withoutNonce } = t
  assert.equal(isTransferToken(withoutNonce), false)
})

test('isOwnershipLease accepts a structurally-valid lease', () => {
  assert.equal(isOwnershipLease(makeOwnershipLease()), true)
})

test('isOwnershipLease rejects primitives, null, and arrays', () => {
  assert.equal(isOwnershipLease(null), false)
  assert.equal(isOwnershipLease(undefined), false)
  assert.equal(isOwnershipLease(42), false)
  assert.equal(isOwnershipLease([]), false)
})

test('isOwnershipLease rejects unknown claimKind values', () => {
  const l = makeOwnershipLease()
  assert.equal(isOwnershipLease({ ...l, claimKind: 'unknown' }), false)
  assert.equal(isOwnershipLease({ ...l, claimKind: '' }), false)
  assert.equal(isOwnershipLease({ ...l, claimKind: 7 as unknown as string }), false)
})

test('isOwnershipLease rejects leases with malformed ownership field', () => {
  const l = makeOwnershipLease()
  assert.equal(isOwnershipLease({ ...l, ownership: null }), false)
  assert.equal(isOwnershipLease({ ...l, ownership: 'string' }), false)
  assert.equal(isOwnershipLease({ ...l, ownership: [] }), false)
})

test('isOwnershipLease rejects leases with empty or wrong-typed fields', () => {
  const l = makeOwnershipLease()
  assert.equal(isOwnershipLease({ ...l, instanceId: '' }), false)
  assert.equal(isOwnershipLease({ ...l, claimId: '' }), false)
  assert.equal(isOwnershipLease({ ...l, claimToken: '' }), false)
  assert.equal(isOwnershipLease({ ...l, expiresAt: 0 }), false)
})

// ---------------------------------------------------------------------------
// Stub functions
// ---------------------------------------------------------------------------

test('tryHandoverOwnership throws the pinned OWNERSHIP_NOT_IMPLEMENTED reason', () => {
  assert.throws(
    () => tryHandoverOwnership(makeOwnershipLease(), makeTransferToken()),
    (err: unknown) => err instanceof Error && err.message === OWNERSHIP_NOT_IMPLEMENTED,
  )
})

test('acceptHandover throws the pinned OWNERSHIP_NOT_IMPLEMENTED reason', () => {
  assert.throws(
    () => acceptHandover(makeTransferToken()),
    (err: unknown) => err instanceof Error && err.message === OWNERSHIP_NOT_IMPLEMENTED,
  )
})

test('stub reason string is stable for P5 21.0 regression detection', () => {
  // Pinned literal — any change here is a deliberate operator signal.
  assert.equal(OWNERSHIP_NOT_IMPLEMENTED, 'background ownership not yet implemented (P5 21.0 deferral)')
})

test('tryHandoverOwnership stub is loud — no silent no-op return', () => {
  // Catches any future regression that turns the stub into `return undefined`.
  let threw = false
  try {
    tryHandoverOwnership(makeOwnershipLease(), makeTransferToken())
  } catch {
    threw = true
  }
  assert.equal(threw, true, 'tryHandoverOwnership must throw until P5 21.0 lands')
})

test('acceptHandover stub is loud — no silent no-op return', () => {
  let threw = false
  try {
    acceptHandover(makeTransferToken())
  } catch {
    threw = true
  }
  assert.equal(threw, true, 'acceptHandover must throw until P5 21.0 lands')
})

// ---------------------------------------------------------------------------
// Composition-root re-exports (task-protection.ts)
// ---------------------------------------------------------------------------

test('task-protection.ts re-exports the ownership stubs at the same surface', async () => {
  // Re-import under the task-protection surface to assert the composition
  // root has a single entry-point for both ECS-protection and ownership
  // stubs (per ADR-0020 §"Where the types live").
  const taskProtection = await import('../src/task-protection.ts')
  assert.equal(typeof taskProtection.tryHandoverOwnership, 'function')
  assert.equal(typeof taskProtection.acceptHandover, 'function')
  assert.equal(taskProtection.OWNERSHIP_NOT_IMPLEMENTED, OWNERSHIP_NOT_IMPLEMENTED)
})

test('createEcsTaskProtection is unchanged — additive re-export only', () => {
  // Catching a regression where the ownership stubs accidentally wired
  // into the ECS PUT path.
  const protection = createEcsTaskProtection('http://invalid.example.invalid')
  assert.equal(typeof protection.set, 'function')
  // The .set call must NOT throw `OWNERSHIP_NOT_IMPLEMENTED` — that path
  // is the ECS PUT, separate from the background-ownership protocol.
  assert.doesNotReject(protection.set(false))
})