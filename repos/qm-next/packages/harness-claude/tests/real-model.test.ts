/**
 * Real-model smoke (skip-until-key, deviation #36): exercises the real
 * claude engine's oneShot against the live Anthropic provider. Skips unless
 * ANTHROPIC_API_KEY is present. The mock parity cases live in
 * harness-claude.test.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClaudeHarness } from '@qm/harness-claude'

const KEY = process.env.ANTHROPIC_API_KEY

test(
  'claude real-model oneShot',
  { skip: KEY ? false : 'set ANTHROPIC_API_KEY to run the real-model smoke (deviation #36)', timeout: 120_000 },
  async () => {
    const harness = createClaudeHarness({ env: { ANTHROPIC_API_KEY: KEY! } })
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
