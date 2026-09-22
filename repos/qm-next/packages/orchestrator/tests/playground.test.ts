import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizePlaygroundTitle, validatePlaygroundHtml } from '../src/playground.ts'

test('playground title: collapses whitespace, defaults, caps at 80 chars with ellipsis', () => {
  assert.equal(normalizePlaygroundTitle('  hello   world \n'), 'hello world')
  assert.equal(normalizePlaygroundTitle('   '), 'Playground')
  assert.equal(normalizePlaygroundTitle(''), 'Playground')
  const long = 'a'.repeat(100)
  const capped = normalizePlaygroundTitle(long)
  assert.equal(capped.length, 80)
  assert.ok(capped.endsWith('…'))
  assert.equal(capped.slice(0, 79), 'a'.repeat(79))
})

test('playground html: rejects empty and oversized documents (qm byte parity)', () => {
  assert.throws(() => validatePlaygroundHtml('   '), /playground HTML is empty/)
  const big = 'x'.repeat(512_001)
  assert.throws(() => validatePlaygroundHtml(big), /keep it under 512000/)
  validatePlaygroundHtml('<p>hi</p>')
  validatePlaygroundHtml('x'.repeat(512_000))
})
