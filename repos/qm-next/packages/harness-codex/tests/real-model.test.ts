/**
 * Real-model smoke (skip-until-key, deviation #36): exercises the real
 * codex engine's oneShot against the live OpenAI provider. Skips unless
 * OPENAI_API_KEY is present (the key is handed to the codex child process
 * env). The mock parity cases live in harness-codex.test.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCodexHarness } from '@qm/harness-codex'

const KEY = process.env.OPENAI_API_KEY

test(
  'codex real-model oneShot',
  { skip: KEY ? false : 'set OPENAI_API_KEY to run the real-model smoke (deviation #36)', timeout: 120_000 },
  async () => {
    const harness = createCodexHarness({ env: { OPENAI_API_KEY: KEY! } })
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
