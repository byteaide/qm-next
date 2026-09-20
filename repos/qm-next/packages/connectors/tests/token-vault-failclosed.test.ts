/**
 * Fail-closed construction gate for the connector token vault
 * (ADR-0017): no key material, no vault — mirrors the missing
 * production policy startup failure (plan §2.2).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryMap } from '@qm/store'
import { createConnectorTokenVault, deriveConnectorTokenKeks, type SealedConnectorToken } from '../src/index.ts'

test('token-vault: empty KEK chain refuses construction', () => {
  assert.throws(
    () => createConnectorTokenVault({ backing: createMemoryMap<SealedConnectorToken>(), keks: [] }),
    /fail-closed, ADR-0017/,
  )
})

test('token-vault: a chain built from any material constructs; the chain guard stays the gate', () => {
  const keks = deriveConnectorTokenKeks(['master-material'])
  assert.doesNotThrow(() => createConnectorTokenVault({ backing: createMemoryMap<SealedConnectorToken>(), keks }))
  // The empty-chain guard is the invariant under test: composition must
  // derive KEKs from boot-verified material (api boot refuses missing
  // signing secrets before it ever derives), and the vault re-checks.
  assert.throws(
    () => createConnectorTokenVault({ backing: createMemoryMap<SealedConnectorToken>(), keks: [] }),
    /requires key material/,
  )
})
