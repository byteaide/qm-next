/**
 * Frame composer tests (M-Soul-2, ADR-0018): the composer reproduces the qm
 * golden fixtures byte-for-byte (imLabel = provider display name), mode
 * selection follows qm's turn-origin ladder, and post-boundary blocks stay
 * outside the stable prefix.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TurnResolution } from '@qm/types'
import { composeFrame, deriveSurfaceTools, renderGatewayBlock, selectFrameMode } from '@qm/orchestrator'
import { renderSecurityPolicyPrompt, resolveSecurityPolicy } from '@qm/security'
import { orgSoul, readGolden, renderSharedCore, soulPrompt } from './soul-fixtures.ts'

const ACTOR = { id: 'ada@acme.com', type: 'internal' as const, displayName: 'Ada' }

const COMBOS = [
  { mode: 'autonomous', im: true },
  { mode: 'autonomous', im: false },
  { mode: 'conversation', im: true },
  { mode: 'conversation', im: false },
  { mode: 'fallback', im: true },
  { mode: 'fallback', im: false },
] as const

function composerInput(combo: (typeof COMBOS)[number], withSoul: boolean) {
  const surface = combo.im ? 'im' : 'web'
  const conversation = { kind: 'dm' as const }
  const origin = combo.mode === 'fallback' ? { kind: 'automation' as const } : { kind: 'human' as const }
  return {
    origin,
    surface,
    conversation,
    actor: ACTOR,
    ...(combo.mode === 'autonomous' ? { surfaceTools: true } : {}),
    soul: soulPrompt(withSoul),
    resolution: {
      securityPrompt: renderSecurityPolicyPrompt(resolveSecurityPolicy('auto')),
      branding: { botName: 'QM', orgName: 'Acme Inc' },
    } satisfies Pick<TurnResolution, 'securityPrompt' | 'branding'>,
    imLabel: 'Slack',
  }
}

for (const combo of COMBOS) {
  for (const withSoul of [true, false]) {
    const name = `${combo.mode}-${withSoul ? 'soul' : 'nosoul'}-${combo.im ? 'im' : 'web'}`
    test(`composer golden parity: ${name}`, () => {
      const composed = composeFrame(composerInput(combo, withSoul))
      assert.equal(composed.mode, combo.mode)
      assert.equal(composed.systemPrompt, readGolden(`${name}.md`))
      assert.equal(composed.stableSystemBytes, composed.systemPrompt.length)
    })
  }
}

test('composer golden parity: the composed prefix joins the shared core from the live template', () => {
  const composed = composeFrame(composerInput(COMBOS[0], false))
  assert.ok(composed.systemPrompt.includes(renderSharedCore()))
})

test('selectFrameMode: ambient and automation-with-destination are autonomous, plain automation falls back', () => {
  const dm = { kind: 'dm' as const }
  assert.equal(selectFrameMode({ origin: { kind: 'ambient' }, surface: 'im', conversation: dm }), 'autonomous')
  assert.equal(
    selectFrameMode({ origin: { kind: 'automation', destination: { type: 'im', target: 'chan' } }, surface: 'im', conversation: dm }),
    'autonomous',
  )
  assert.equal(selectFrameMode({ origin: { kind: 'automation' }, surface: 'im', conversation: dm }), 'fallback')
  assert.equal(selectFrameMode({ origin: { kind: 'human' }, surface: 'im', conversation: dm }), 'conversation')
  assert.equal(selectFrameMode({ origin: { kind: 'human' }, surface: 'web', conversation: dm }), 'conversation')
  assert.equal(selectFrameMode({ origin: { kind: 'human' }, surface: 'im', conversation: { kind: 'channel' } }), 'fallback')
  assert.equal(selectFrameMode({ origin: { kind: 'direct' }, surface: 'im', conversation: { kind: 'channel' } }), 'fallback')
})

test('deriveSurfaceTools: ambient yes, automation with destination yes, plain automation and humans no', () => {
  assert.equal(deriveSurfaceTools({ kind: 'ambient' }), true)
  assert.equal(deriveSurfaceTools({ kind: 'automation', destination: { type: 'im', target: 'chan' } }), true)
  assert.equal(deriveSurfaceTools({ kind: 'automation' }), false)
  assert.equal(deriveSurfaceTools({ kind: 'human' }), false)
  assert.equal(deriveSurfaceTools({ kind: 'direct' }), false)
})

test('composer: proactiveOpener appends the qm open-the-conversation line', () => {
  const base = composerInput({ mode: 'conversation', im: true }, false)
  const composed = composeFrame({ ...base, proactiveOpener: true })
  assert.ok(composed.systemPrompt.includes('\nNo one has written yet; open the conversation yourself per the onboarding note below.'))
})

test('composer: botHandle markup is stripped before it reaches the shared core', () => {
  const composed = composeFrame({
    origin: { kind: 'direct' },
    surface: 'im',
    conversation: { kind: 'dm' },
    actor: { id: 'a@b', type: 'internal' },
    soul: '',
    resolution: { branding: { botName: 'QM', orgName: 'Acme' } },
    imLabel: 'Slack',
    gatewayContext: { botHandle: '@{evil}handle' },
  })
  assert.ok(composed.systemPrompt.includes('(@evilhandle in Slack)'))
  assert.ok(!composed.systemPrompt.includes('{{'))
})

test('composer: soul lands inside the boundary; memory block stays outside it', () => {
  const composed = composeFrame({
    ...composerInput({ mode: 'conversation', im: true }, true),
    soul: soulPrompt(true),
  })
  assert.ok(composed.stableSystemBytes > orgSoul.length)
  assert.ok(composed.systemPrompt.slice(0, composed.stableSystemBytes).includes(orgSoul))
})

test('gateway block: renders location and identifiers, neutralized cron warning on web', () => {
  const block = renderGatewayBlock('im', { location: '#eng', details: { thread: 't1' } }, 'Slack')
  assert.match(block, /## Where you are\nYou are talking with the user over im, in #eng\./)
  assert.match(block, /- thread: t1/)
  const web = renderGatewayBlock('web', {}, 'Slack')
  assert.match(web, /create the cron with a real platform destination: use `recipient` for a Slack DM/)
  assert.equal(renderGatewayBlock('im', undefined, 'Slack'), '## Where you are\nYou are talking with the user over im.')
  assert.equal(renderGatewayBlock(undefined, undefined, 'Slack'), '')
})
