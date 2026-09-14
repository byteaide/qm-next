/**
 * Real-model smoke (skip-until-key, deviation #36): exercises the real pi
 * engine's oneShot against the live provider. Skips unless an Anthropic key
 * is present; set QM_TEST_PI_MODEL_ID to target a custom-provider model.
 * The mock parity cases live in harness-pi.test.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPiHarness } from '@qm/harness-pi'

const KEY = process.env.ANTHROPIC_API_KEY
const MODEL_ID = process.env.QM_TEST_PI_MODEL_ID

test(
  'pi real-model oneShot',
  { skip: KEY ? false : 'set ANTHROPIC_API_KEY to run the real-model smoke (deviation #36)', timeout: 120_000 },
  async () => {
    const harness = createPiHarness({
      apiKey: KEY!,
      ...(MODEL_ID ? { modelId: MODEL_ID } : {}),
    })
    try {
      const out = await harness.models.oneShot!(
        'You are a connectivity probe. Reply with the exact word only.',
        'Reply with exactly: pong',
      )
      assert.ok(out && out.toLowerCase().includes('pong'), `unexpected reply: ${out}`)
    } finally {
      await harness.turns.close?.()
    }
  },
)
