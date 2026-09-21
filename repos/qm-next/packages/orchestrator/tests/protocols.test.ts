/**
 * Protocol-template stack tests (M-Soul-1, ADR-0018): the fail-loud renderer
 * contract and per-template snapshot parity against the qm golden fixtures
 * (byte parity holds because the neutralized templates render with
 * `imLabel` = the provider display name).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPromptVars, loadProtocolFile, type PromptVars } from '@qm/orchestrator'
import { renderSecurityPolicyPrompt, resolveSecurityPolicy } from '@qm/security'
import {
  botName,
  frameVars,
  joinSegments,
  orgSoul,
  readGolden,
  renderModeFrame,
  renderSharedCore,
  soulPrompt,
} from './soul-fixtures.ts'

test('applyPromptVars: substitutes string variables', () => {
  assert.equal(applyPromptVars('You are {{name}} of {{org}}.', { name: 'QM', org: 'Acme' }), 'You are QM of Acme.')
})

test('applyPromptVars: conditional keeps body only when the variable is truthy', () => {
  const md = 'a{{#if flag}} yes{{/if}}b{{#if off}} no{{/if}}c'
  assert.equal(applyPromptVars(md, { flag: true, off: false }), 'a yesbc')
  assert.equal(applyPromptVars(md, {}), 'abc')
})

test('applyPromptVars: leaves unknown variables untouched for the fail-loud check', () => {
  assert.throws(
    () => applyPromptVars('hello {{missing}}', {}),
    /unresolved template token near "\{\{missing\}\}"/,
  )
})

test('applyPromptVars: renders boolean false without throwing', () => {
  assert.equal(applyPromptVars('x{{#if ready}}!{{/if}}', { ready: false }), 'x')
})

test('loadProtocolFile: all four protocol templates exist and are non-empty', () => {
  for (const name of ['shared-core', 'mode-autonomous', 'mode-conversation', 'mode-fallback']) {
    assert.ok(loadProtocolFile(name).length > 100, `${name}.md should be non-trivial`)
  }
})

const COMBOS = [
  ['autonomous', true],
  ['autonomous', false],
  ['conversation', true],
  ['conversation', false],
  ['fallback', true],
  ['fallback', false],
] as const

for (const [mode, im] of COMBOS) {
  for (const withSoul of [true, false]) {
    const name = `${mode}-${withSoul ? 'soul' : 'nosoul'}-${im ? 'im' : 'web'}`
    test(`golden snapshot: ${name}`, () => {
      const modeFrame = renderModeFrame(mode, im)
      const sharedCore = renderSharedCore()
      const securityPrompt = renderSecurityPolicyPrompt(resolveSecurityPolicy('auto'))
      const composed = joinSegments(modeFrame, soulPrompt(withSoul), sharedCore, securityPrompt)
      assert.equal(composed, readGolden(`${name}.md`))
      assert.ok(readGolden(`${name}.md`).includes(modeFrame), 'mode frame segment present')
      if (withSoul) assert.ok(readGolden(`${name}.md`).includes(orgSoul), 'soul segment present')
      assert.ok(readGolden(`${name}.md`).includes(sharedCore), 'shared core segment present')
    })
  }
}

test('golden snapshot: conversation frame renders user identity and surface label', () => {
  const frame = renderModeFrame('conversation', true)
  assert.ok(frame.includes(`${botName}, in a live, private 1:1 with Ada (ada@acme.com) over Slack.`))
  const webFrame = renderModeFrame('conversation', false)
  assert.ok(webFrame.includes(`over the ${botName} web app.`))
  assert.ok(webFrame.includes('- Replies render as markdown.'))
})

test('frame vars: fallback frame carries no surface vocabulary', () => {
  const vars: PromptVars = frameVars('fallback', true)
  assert.deepEqual(vars, {})
})
