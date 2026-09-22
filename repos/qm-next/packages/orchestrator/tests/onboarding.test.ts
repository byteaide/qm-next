/**
 * Segment ⑮ onboarding tests: marker grammar (detect/set round-trip,
 * version scoping), the rendered block's byte-level golden text, and the
 * turn-side resolution ladder (DM gate, skill gate, fail-open memory).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  detectOnboardingStatus,
  onboardingBlockFor,
  PROACTIVE_OPENER_PROMPT,
  renderPendingOnboardingPrompt,
  setOnboardingStatus,
} from '../src/onboarding.ts'

test('detect: absent marker is not_started', () => {
  assert.equal(detectOnboardingStatus(''), 'not_started')
  assert.equal(detectOnboardingStatus('- Some other note\n- Onboarding: done v1'), 'not_started')
})

test('detect: completion markers in all grammatical variants', () => {
  const variants = [
    '- Onboarding: completed v2 on 2026-09-22.',
    '* Onboarding: completed v2 on 2026-09-22.',
    '(2026-09-22) Onboarding: completed v2 on 2026-09-22.',
    '- ONBOARDING: COMPLETED v2 on 2026-09-22.',
    '- Onboarding: completed v2.x on 2026-09-22.',
  ]
  for (const line of variants) assert.equal(detectOnboardingStatus(`note\n${line}\n`), 'completed', line)
})

test('detect: dismissed and pending outrank nothing, completed outranks all', () => {
  const memory = ['- Onboarding: pending v2 since 2026-09-20.', '- Onboarding: dismissed v2 on 2026-09-21.'].join('\n')
  assert.equal(detectOnboardingStatus(memory), 'dismissed')
  assert.equal(detectOnboardingStatus(`${memory}\n- Onboarding: completed v2 on 2026-09-22.`), 'completed')
})

test('detect: version mismatch does not satisfy the current version', () => {
  assert.equal(detectOnboardingStatus('- Onboarding: completed v1 on 2026-01-01.'), 'not_started')
  assert.equal(detectOnboardingStatus('- Onboarding: completed v2 on 2026-01-01.', 'v3'), 'not_started')
})

test('set: appends, replaces idempotently, and not_started strips', () => {
  const started = setOnboardingStatus('fact one\n\n\nfact two   ', 'pending', '2026-09-22')
  assert.equal(started, 'fact one\n\nfact two\n- Onboarding: pending v2 since 2026-09-22.\n')

  const completed = setOnboardingStatus(started, 'completed', '2026-09-23')
  assert.equal(completed, 'fact one\n\nfact two\n- Onboarding: completed v2 on 2026-09-23.\n')

  const cleared = setOnboardingStatus(completed, 'not_started', '2026-09-24')
  assert.equal(cleared, 'fact one\n\nfact two\n')

  assert.equal(setOnboardingStatus('', 'not_started', '2026-09-24'), '')
})

test('render: golden text for pending and not_started; empty when resolved', () => {
  assert.equal(renderPendingOnboardingPrompt('completed'), '')
  assert.equal(renderPendingOnboardingPrompt('dismissed'), '')
  assert.equal(
    renderPendingOnboardingPrompt('pending'),
    [
      '## Pending Onboarding',
      'Memory says onboarding is pending for v2.',
      '',
      'Onboarding is a high-priority setup task; already knowing who they are is no reason to skip it.',
      '',
      'Before ordinary work in this personal DM, read `skills/onboarding/SKILL.md` and follow its complete ordered flow. Keep each turn light, but do not confuse a greeting or existing profile data with completion.',
      '',
      "Use the `memory` tool as the source of truth. On completion or an explicit stop, preserve the notebook and add `- Onboarding: completed v2 on YYYY-MM-DD.` so onboarding does not recur.",
    ].join('\n'),
  )
  const block = renderPendingOnboardingPrompt('not_started')
  assert.ok(block.startsWith('## Pending Onboarding'))
  assert.ok(block.includes('Memory has no onboarding completion marker for v2.'))
})

test('opener prompt: stable non-empty text', () => {
  assert.ok(PROACTIVE_OPENER_PROMPT.includes("hasn't typed anything yet"))
})

test('onboardingBlockFor: renders only for gated DMs with pending status', async () => {
  const skills = {
    resolve: async () => ({ skill: { name: 'onboarding' }, shadowed: [] }),
  }
  const memory = {
    get: async () => 'unrelated notes',
  }

  const block = await onboardingBlockFor({ memory, skills }, { kind: 'dm' }, 'org:test')
  assert.ok(block?.startsWith('## Pending Onboarding'))

  assert.equal(await onboardingBlockFor({ memory, skills }, { kind: 'channel' }, 'org:test'), undefined)
  assert.equal(await onboardingBlockFor({ memory, skills }, { kind: 'group' }, 'org:test'), undefined)

  const completedMemory = { get: async () => '- Onboarding: completed v2 on 2026-09-22.' }
  assert.equal(await onboardingBlockFor({ memory: completedMemory, skills }, { kind: 'dm' }, 'org:test'), undefined)

  const noSkill = { resolve: async () => ({ skill: null, shadowed: [] }) }
  assert.equal(await onboardingBlockFor({ memory, skills: noSkill }, { kind: 'dm' }, 'org:test'), undefined)
})

test('onboardingBlockFor: fail-open on store errors', async () => {
  const throwingSkills = {
    resolve: async () => {
      throw new Error('store down')
    },
  }
  assert.equal(await onboardingBlockFor({ memory: { get: async () => '' }, skills: throwingSkills }, { kind: 'dm' }, 'org:test'), undefined)

  const throwingMemory = {
    get: async () => {
      throw new Error('memory down')
    },
  }
  const block = await onboardingBlockFor({ memory: throwingMemory, skills: { resolve: async () => ({ skill: { name: 'onboarding' }, shadowed: [] }) } }, { kind: 'dm' }, 'org:test')
  assert.ok(block?.startsWith('## Pending Onboarding'), 'unreadable notebook reads as empty — block still renders')
})
