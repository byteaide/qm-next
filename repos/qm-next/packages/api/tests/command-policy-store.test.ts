import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryCommandPolicyStore } from '../src/services/command-policy-store.ts'
import { parseCommandPolicy } from '@qm/sandbox'

test('command-policy store: set/get/delete round-trip and isolate scopes', async () => {
  const store = createMemoryCommandPolicyStore()
  const parsed = parseCommandPolicy({
    mode: 'denylist',
    rules: [{ pattern: '\\brm\\s+-rf\\b', decision: 'require_approval', reason: 'recursive delete' }],
  })
  assert.ok(!('error' in parsed))

  assert.equal(await store.get('channel:a'), null)
  const record = await store.set('channel:a', parsed.policy, { setBy: 'person:ada' })
  assert.equal(record.scopeId, 'channel:a')
  assert.equal(record.setBy, 'person:ada')
  assert.ok(record.updatedAt > 0)

  const got = await store.get('channel:a')
  assert.equal(got?.policy.rules[0]?.reason, 'recursive delete')
  assert.equal(await store.get('channel:b'), null, 'scopes are isolated')

  assert.equal(await store.delete('channel:a'), true)
  assert.equal(await store.delete('channel:a'), false, 'second delete reports nothing deleted')
  assert.equal(await store.get('channel:a'), null)
  await store.close()
})

test('command-policy store: set replaces and setBy is optional', async () => {
  const store = createMemoryCommandPolicyStore()
  const first = parseCommandPolicy({ mode: 'denylist', rules: [{ pattern: 'a', decision: 'deny' }] })
  const second = parseCommandPolicy({ mode: 'allowlist', rules: [{ pattern: '^ls', decision: 'allow' }] })
  assert.ok(!('error' in first) && !('error' in second))

  await store.set('org:x', first.policy, { setBy: 'person:one' })
  const replaced = await store.set('org:x', second.policy)
  assert.equal(replaced.policy.mode, 'allowlist')
  assert.equal(replaced.setBy, undefined, 'a set without setBy clears the previous attribution')
  await store.close()
})
