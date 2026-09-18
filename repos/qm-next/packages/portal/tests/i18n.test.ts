/**
 * Portal i18n vocabulary integrity (i18n plan §4.4/P4 anti-drift): the zh
 * table carries exactly the en key set, locale resolution follows
 * cookie → Accept-Language → en, `{param}` interpolation works, and rendered
 * pages carry the matching <html lang>. Plain node, no server needed.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { localeFromAcceptLanguage, portalEn, portalText, portalZh, resolvePortalLocale } from '../src/i18n.ts'
import { nonAdminDeniedHtml, signInErrorHtml } from '../src/portal-routes.ts'

test('portal zh vocabulary carries exactly the en key set', () => {
  assert.deepEqual(Object.keys(portalZh).sort(), Object.keys(portalEn).sort())
  assert.ok(Object.keys(portalEn).length >= 20, 'portal vocabulary should stay complete, not shrink')
})

test('portal locale resolution: cookie beats Accept-Language beats en', () => {
  assert.equal(resolvePortalLocale('qm.locale=zh', 'en-US,en;q=0.9'), 'zh')
  assert.equal(resolvePortalLocale('qm.locale=en', 'zh-CN,zh;q=0.9'), 'en')
  assert.equal(resolvePortalLocale(undefined, 'zh-CN,zh;q=0.9'), 'zh')
  assert.equal(resolvePortalLocale('other=cookie', 'zh;q=0.5,en;q=0.9'), 'en')
  assert.equal(resolvePortalLocale('qm.locale=bogus', undefined), 'en')
  assert.equal(resolvePortalLocale(undefined, undefined), 'en')
  assert.equal(resolvePortalLocale('qm.locale=zh', undefined), 'zh')
})

test('Accept-Language parsing: q-values ranked, non-matching tags skipped', () => {
  assert.equal(localeFromAcceptLanguage('fr-FR,fr;q=0.9,zh-CN;q=0.8'), 'zh')
  assert.equal(localeFromAcceptLanguage('zh;q=0.1,en;q=0.2'), 'en')
  assert.equal(localeFromAcceptLanguage('zh_TW'), 'zh')
  assert.equal(localeFromAcceptLanguage('de-DE,de;q=0.9'), 'en')
  assert.equal(localeFromAcceptLanguage(''), 'en')
})

test('portalText interpolates {params} in both locales', () => {
  assert.equal(portalText('en', 'idpReturned', { detail: 'access_denied' }), 'identity provider returned: access_denied')
  assert.equal(portalText('zh', 'idpReturned', { detail: 'access_denied' }), '身份提供方返回：access_denied')
  assert.equal(portalText('en', 'details'), 'Details')
  assert.equal(portalText('zh', 'details'), '详细信息')
})

test('rendered pages carry the matching <html lang> and localized copy', () => {
  const enPage = signInErrorHtml('en', 'invalid login state')
  assert.match(enPage, /<html lang="en">/)
  assert.match(enPage, /Sign-in failed/)
  const zhPage = signInErrorHtml('zh', '登录状态无效')
  assert.match(zhPage, /<html lang="zh-CN">/)
  assert.match(zhPage, /无法完成登录/)
  assert.match(zhPage, /详细信息/)
  assert.match(zhPage, /重新登录/)
  const zhDenied = nonAdminDeniedHtml('zh', { sub: 'dev@example.com', org: 'org' })
  assert.match(zhDenied, /<html lang="zh-CN">/)
  assert.match(zhDenied, /登录身份 <b>dev@example\.com<\/b>/)
  assert.ok(!zhDenied.includes('<script>'))
})
