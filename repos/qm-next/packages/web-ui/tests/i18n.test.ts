/**
 * i18n vocabulary integrity: ui.zh carries exactly the ui.en key set, t()
 * resolves both locales (unknown keys pass through), and the error-channel
 * vocabulary is locale-aware with raw-text fallback. Runs under plain node
 * (no DOM): i18n/index.ts guards its document/navigator access.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { currentLocale, setLocale, t } from '../app/src/i18n/index'
import { errorZh, hasZhError, localizeTurnError, localizedError } from '../app/src/i18n/errors'
import { uiEn } from '../app/src/i18n/ui.en'
import { uiZh } from '../app/src/i18n/ui.zh'

// Source-level string literals carry TS escapes (\"); evaluate them the way
// the runtime would so keys compare against parsed vocabulary entries.
function unescapeLiteral(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw
  }
}

test('ui.zh carries exactly the ui.en key set', () => {
  assert.deepEqual(Object.keys(uiZh).sort(), Object.keys(uiEn).sort())
})

test('every t("...") literal used in app/src is registered in ui.en.ts', () => {
  // Anti-drift: a template key that misses the vocabulary silently renders
  // English in zh — walk the sources and demand registration for each literal.
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'src')
  const used = new Set<string>()
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        if (name !== 'i18n') walk(p)
        continue
      }
      if (!name.endsWith('.ts')) continue
      const text = readFileSync(p, 'utf8')
      for (const m of text.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)) {
        if (m[1]) used.add(unescapeLiteral(m[1]))
      }
      for (const m of text.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) {
        if (m[1]) used.add(unescapeLiteral(m[1]))
      }
    }
  }
  walk(srcDir)
  const missing = [...used].filter((key) => !Object.hasOwn(uiEn, key)).sort()
  assert.deepEqual(missing, [], 't() literals missing from ui.en.ts')
})

test('error vocab keys are machine codes, not UI strings', () => {
  for (const code of Object.keys(errorZh)) assert.match(code, /^[a-z][a-z0-9_]*$/)
})

test('t() resolves en to the key and zh through the table', () => {
  setLocale('en')
  assert.equal(currentLocale(), 'en')
  assert.equal(t('New chat'), 'New chat')
  assert.equal(t('Not a real key'), 'Not a real key')
  assert.equal(t('Hello {name}', { name: 'QM' }), 'Hello QM')
  setLocale('zh')
  assert.equal(currentLocale(), 'zh')
  assert.equal(t('New chat'), '新聊天')
  assert.equal(t('Not a real key'), 'Not a real key')
  setLocale('en')
})

test('error codes localize in zh and fall back to raw in en', () => {
  setLocale('en')
  assert.equal(localizedError('not_found'), undefined)
  setLocale('zh')
  assert.equal(localizedError('not_found'), '资源不存在')
  assert.equal(localizedError('deploy_failed'), '部署失败')
  assert.equal(localizedError('no_such_code'), undefined)
  setLocale('en')
  assert.equal(hasZhError('not_found'), true)
  assert.equal(hasZhError('no_such_code'), false)
})

test('turn errors: harness templates and known provider types localize, others pass through', () => {
  setLocale('en')
  assert.equal(localizeTurnError('Pi agent stopped with an error'), 'Pi agent stopped with an error')
  setLocale('zh')
  assert.equal(localizeTurnError('Pi agent stopped with an error'), '助手运行出错,已停止。')
  assert.equal(
    localizeTurnError('Message wasn’t sent. Check your connection and try again.'),
    '消息未发出,请检查网络连接后重试。',
  )
  assert.equal(
    localizeTurnError('Model provider API error (rate_limit_error): slow down'),
    '触发模型服务限流,请稍后重试:slow down',
  )
  assert.equal(
    localizeTurnError('Model provider API error (insufficient_quota): billing'),
    '模型额度不足:billing',
  )
  assert.equal(
    localizeTurnError('Model provider API error (totally_new_type): ???'),
    'Model provider API error (totally_new_type): ???',
  )
  assert.equal(localizeTurnError('some other failure'), 'some other failure')
  assert.equal(localizeTurnError(''), '')
  setLocale('en')
})
