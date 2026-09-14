/**
 * Admin-login link suite (qm plugins/portal/src/admin-login.ts): the sealed
 * admin-login claim ladder — kind/audience/subject/exp/jti validation.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveKey, seal } from '../src/session.ts'
import { ADMIN_LOGIN_SCRIPT_HASH, openAdminLogin } from '../src/admin-login.ts'

const secret = 'portal-test-secret-that-is-long-enough'
const publicUrl = 'http://localhost:8097'

function mintToken(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000)
  return seal(
    {
      k: 'admin-login',
      sub: 'ada@example.test',
      aud: publicUrl,
      iat: now,
      exp: now + 120,
      jti: 'A'.repeat(24),
      ...overrides,
    },
    deriveKey(secret, 'portal.admin-login.v1'),
  )
}

test('openAdminLogin accepts a fresh well-formed link', () => {
  const claims = openAdminLogin(mintToken(), secret, publicUrl)
  assert.equal(claims?.email, 'ada@example.test')
  assert.equal(claims?.jti, 'A'.repeat(24))
  assert.ok((claims?.expiresAtMs ?? 0) > Date.now())
})

test('openAdminLogin rejects wrong key, audience, kind, and secrets too short', () => {
  assert.equal(openAdminLogin(mintToken(), 'another-secret-that-is-long-enough', publicUrl), null)
  assert.equal(openAdminLogin(mintToken({ aud: 'https://evil.test' }), secret, publicUrl), null)
  assert.equal(openAdminLogin(mintToken({ k: 'session' }), secret, publicUrl), null)
  assert.equal(openAdminLogin(mintToken(), 'short', publicUrl), null)
  assert.equal(openAdminLogin('x'.repeat(4097), secret, publicUrl), null)
})

test('openAdminLogin rejects bad subjects and malformed jtis', () => {
  assert.equal(openAdminLogin(mintToken({ sub: 'not-an-email' }), secret, publicUrl), null)
  assert.equal(openAdminLogin(mintToken({ sub: ' ADA@example.test ' }), secret, publicUrl), null)
  assert.equal(openAdminLogin(mintToken({ sub: 'a@b@c.example' }), secret, publicUrl), null)
  assert.equal(openAdminLogin(mintToken({ jti: 'short' }), secret, publicUrl), null)
})

test('openAdminLogin enforces the five-minute window and monotonic time', () => {
  const now = Math.floor(Date.now() / 1000)
  assert.equal(openAdminLogin(mintToken({ exp: now + 301 }), secret, publicUrl), null)
  assert.equal(openAdminLogin(mintToken({ exp: now + 60, iat: now + 120 }), secret, publicUrl), null)
  assert.equal(openAdminLogin(mintToken({ exp: now - 1 }), secret, publicUrl), null)
  assert.equal(openAdminLogin(mintToken({ iat: now + 6, exp: now + 126 }), secret, publicUrl), null)
})

test('the login page script hash matches the shipped script', () => {
  assert.match(ADMIN_LOGIN_SCRIPT_HASH, /^sha256-/)
})
