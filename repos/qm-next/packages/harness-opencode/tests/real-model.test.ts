/**
 * Real-model smoke (skip-until-key, deviation #36): exercises the real
 * opencode engine's oneShot against the live OpenAI provider. Skips unless
 * OPENAI_API_KEY is present. The mock parity cases live in
 * harness-opencode.test.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenCodeHarness } from '@qm/harness-opencode'

const KEY = process.env.OPENAI_API_KEY

test(
  'opencode real-model oneShot',
  { skip: KEY ? false : 'set OPENAI_API_KEY to run the real-model smoke (deviation #36)', timeout: 120_000 },
  async () => {
    const harness = createOpenCodeHarness({ openaiApiKey: KEY! })
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
