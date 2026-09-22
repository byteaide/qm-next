import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compileSafeRegex, evaluateCommandPolicy, parseCommandPolicy } from '../src/policy.ts'
import { defaultDenylistPolicy } from '../src/default-policy.ts'

test('sandbox policy: default denylist catches catastrophic primitives (case-insensitively)', () => {
  const policy = defaultDenylistPolicy()
  assert.equal(evaluateCommandPolicy('rm -rf /etc', policy).decision, 'deny')
  assert.equal(evaluateCommandPolicy('RM -RF /ETC', policy).decision, 'deny')
  assert.equal(evaluateCommandPolicy('Mkfs.ext4 /dev/sda1', policy).decision, 'deny')
  assert.equal(evaluateCommandPolicy(':(){ :|:& };:', policy).decision, 'deny')
  assert.equal(evaluateCommandPolicy('drop table users', policy).decision, 'deny')
  assert.equal(evaluateCommandPolicy('chown -R root:root /etc', policy).decision, 'deny')
})

test('sandbox policy: root-level path boundary avoids false positives on nested cleanup', () => {
  const policy = defaultDenylistPolicy()
  assert.equal(evaluateCommandPolicy('rm -rf /tmp/foo', policy).decision, 'allow')
  assert.equal(evaluateCommandPolicy('rm -rf build', policy).decision, 'allow')
})

test('sandbox policy: first match wins and carries ruleId + reason', () => {
  const verdict = evaluateCommandPolicy('mkfs /dev/sda', defaultDenylistPolicy())
  assert.equal(verdict.decision, 'deny')
  assert.match(verdict.ruleId ?? '', /^\\bmkfs/)
  assert.match(verdict.reason ?? '', /filesystem creation/)
})

test('sandbox policy: mode defaults — denylist open, allowlist closed', () => {
  const empty = { mode: 'denylist' as const, rules: [] }
  assert.equal(evaluateCommandPolicy('ls', empty).decision, 'allow')
  const closed = { mode: 'allowlist' as const, rules: [] }
  assert.equal(evaluateCommandPolicy('ls', closed).decision, 'deny')
})

test('compileSafeRegex: rejects ReDoS and unsafe constructs (qm parity)', () => {
  assert.throws(() => compileSafeRegex('(a+)+$'), /nested or ambiguous repetition/)
  assert.throws(() => compileSafeRegex('a(?=b)'), /backreferences and lookarounds/)
  assert.throws(() => compileSafeRegex('a\\1'), /backreferences and lookarounds/)
  assert.throws(() => compileSafeRegex('a'.repeat(257)), /pattern must be 1-256/)
  assert.throws(() => compileSafeRegex(''), /pattern must be 1-256/)
  assert.ok(compileSafeRegex('^safe[a-z]{1,3}$', 'i') instanceof RegExp)
})

test('parseCommandPolicy: qm-shaped validation contract', () => {
  assert.deepEqual(parseCommandPolicy('nope'), { error: 'command policy must be an object' })
  assert.deepEqual(parseCommandPolicy([]), { error: 'command policy must be an object' })
  assert.deepEqual(parseCommandPolicy({ mode: 'magic', rules: [] }), { error: 'mode must be "denylist" or "allowlist"' })
  assert.deepEqual(parseCommandPolicy({ mode: 'denylist' }), { error: 'rules must be an array' })
  assert.deepEqual(parseCommandPolicy({ mode: 'denylist', rules: ['x'] }), { error: 'rules[0] must be an object' })
  assert.deepEqual(parseCommandPolicy({ mode: 'denylist', rules: [{ decision: 'deny' }] }), {
    error: 'rules[0].pattern must be a non-empty string',
  })
  const badRegex = parseCommandPolicy({ mode: 'denylist', rules: [{ pattern: '(x+x+)+y', decision: 'deny' }] })
  assert.ok('error' in badRegex)
  assert.match(badRegex.error, /rules\[0\]\.pattern is not a valid regex/)
  assert.deepEqual(parseCommandPolicy({ mode: 'denylist', rules: [{ pattern: 'x', decision: 'maybe' }] }), {
    error: 'rules[0].decision must be "allow", "deny", or "require_approval"',
  })
  assert.deepEqual(parseCommandPolicy({ mode: 'denylist', rules: [{ pattern: 'x', decision: 'deny', reason: 1 }] }), {
    error: 'rules[0].reason must be a string',
  })
  const ok = parseCommandPolicy({
    mode: 'allowlist',
    rules: [{ pattern: '^git\\s+push$', decision: 'allow', reason: 'push allowed' }],
  })
  assert.ok(!('error' in ok))
  assert.equal(ok.policy.rules[0]?.reason, 'push allowed')
})
