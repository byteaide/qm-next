/**
 * Security posture tests (parity 16.0): posture parsing, policy
 * resolution, org-floor vs scope composition, verdict parsing,
 * payload assembly (data-bearing surfaces + overheard +
 * externalPromptData, dedupe + truncation), and the rendered policy
 * prompt.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  composeSecurityPosture,
  parseSecurityPosture,
  parseSecurityScreenVerdict,
  renderSecurityPolicyPrompt,
  resolveSecurityPolicy,
  securityScreenPayload,
  securityScreenSystemPrompt,
  unscreenedNotice,
} from '../src/index.ts'

test('security-posture: parseSecurityPosture accepts the three postures case-insensitively', () => {
  assert.equal(parseSecurityPosture('dangerous'), 'dangerous')
  assert.equal(parseSecurityPosture('AUTO'), 'auto')
  assert.equal(parseSecurityPosture('  strict'), 'strict')
  assert.equal(parseSecurityPosture('default'), null)
  assert.equal(parseSecurityPosture(42), null)
  assert.equal(parseSecurityPosture(undefined), null)
})

test('security-posture: resolveSecurityPolicy maps each posture to its policy', () => {
  assert.deepEqual(resolveSecurityPolicy('dangerous'), { inboundScreening: 'off', toolApprovals: 'none' })
  assert.deepEqual(resolveSecurityPolicy('auto'), { inboundScreening: 'external', toolApprovals: 'none' })
  assert.deepEqual(resolveSecurityPolicy('strict'), { inboundScreening: 'off', toolApprovals: 'all' })
})

test('security-posture: composeSecurityPosture picks the higher rank', () => {
  assert.equal(composeSecurityPosture('auto', 'strict'), 'strict')
  assert.equal(composeSecurityPosture('strict', 'auto'), 'strict')
  assert.equal(composeSecurityPosture('auto'), 'auto')
  assert.equal(composeSecurityPosture('strict', null), 'strict')
})

test('security-posture: renderSecurityPolicyPrompt names each posture', () => {
  const dangerous = renderSecurityPolicyPrompt(resolveSecurityPolicy('dangerous'))
  assert.match(dangerous, /Dangerous/)
  const auto = renderSecurityPolicyPrompt(resolveSecurityPolicy('auto'))
  assert.match(auto, /Auto/)
  const strict = renderSecurityPolicyPrompt(resolveSecurityPolicy('strict'))
  assert.match(strict, /Strict/)
})

test('security-posture: securityScreenSystemPrompt composes the rubric and output contract', () => {
  const prompt = securityScreenSystemPrompt('RUBRIC_HERE')
  assert.match(prompt, /RUBRIC_HERE/)
  assert.match(prompt, /Return JSON only/)
})

test('security-posture: unscreenedNotice labels the kind and the gap', () => {
  const notice = unscreenedNotice('tool response')
  assert.match(notice, /\[NOT security-screened/)
  assert.match(notice, /tool response/)
})

test('security-posture: parseSecurityScreenVerdict accepts auto and strict with reason', () => {
  assert.deepEqual(parseSecurityScreenVerdict('{"decision":"auto"}'), { decision: 'auto' })
  assert.deepEqual(parseSecurityScreenVerdict('  {"decision":"strict","reason":"jailbreak"} '), {
    decision: 'strict',
    reason: 'jailbreak',
  })
  assert.deepEqual(parseSecurityScreenVerdict('{"decision":"dangerous","reason":"x"}'), {
    decision: 'auto',
    unscreened: true,
    reason: 'invalid security screen verdict',
  })
  assert.deepEqual(parseSecurityScreenVerdict('garbage'), {
    decision: 'auto',
    unscreened: true,
    reason: 'invalid security screen verdict',
  })
  assert.equal(parseSecurityScreenVerdict(''), undefined)
})

test('security-posture: securityScreenPayload returns null when there is no data-bearing input', () => {
  assert.equal(securityScreenPayload({ text: 'hello' }), null)
  assert.equal(securityScreenPayload({ text: 'hi', surface: 'message' }), null)
})

test('security-posture: securityScreenPayload captures data-bearing surfaces and dedupes overheard text', () => {
  const p = securityScreenPayload({
    text: 'agent turn',
    surface: 'monitor',
    triggered: true,
    securityScreenData: 'build finished with errors',
    overheard: [
      { role: 'user', name: 'bob', text: 'did it crash?' },
      { role: 'assistant', name: 'agent', text: 'no' },
      { role: 'user', name: 'bob', text: 'did it crash?' }, // dup
    ],
    externalPromptData: [{ source: 'webhook', content: 'noisy page' }],
  })
  assert.ok(p)
  const decoded = JSON.parse(p.content) as Array<{ source: string; content: string }>
  const sources = decoded.map((d) => d.source)
  assert.deepEqual(sources.sort(), ['monitor', 'overheard:bob', 'webhook'])
})

test('security-posture: securityScreenPayload truncates giant inputs around a marker', () => {
  const huge = 'a'.repeat(20_000)
  const p = securityScreenPayload({
    text: 'x',
    surface: 'webhook',
    triggered: true,
    externalPromptData: [{ source: 'tool_result:cron', content: huge }],
  })
  assert.ok(p)
  assert.equal(p.truncated, true)
  assert.match(p.content, /\[security screen input truncated\]/)
  assert.ok(p.content.length <= 16_000 + 100)
})