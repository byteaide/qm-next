/**
 * Phase 3 — Security Screen Adapter tests.
 *
 * Covers plan §3.2 Security Screen port across the off / shadow / enforce
 * modes × {allow, deny, unavailable} matrix. ADR-0004: Shadow records
 * without blocking; Enforce rejects; Off skips. ADR-0007: orchestrator
 * owns stage order; the adapter is the algorithm boundary.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Principal } from '@qm/types'
import {
  createMemoryShadowRecordStore,
  createSecurityScreenAdapter,
  SecurityScreenAdapterError,
  type SecurityScreener,
} from '@qm/security'

const actor: Principal = { id: 'person:ada', type: 'internal' }

const baseInput = {
  surface: 'web',
  actor,
}

function allowScreener(): SecurityScreener {
  return {
    provider: 'mock',
    shadow: false,
    async classify() {
      return {
        verdict: { decision: 'allow' },
        score: 0,
        threshold: 0.5,
      }
    },
  }
}

function denyScreener(ruleId = 'prompt-injection.v1'): SecurityScreener {
  return {
    provider: 'mock',
    shadow: false,
    async classify() {
      return {
        verdict: { decision: 'deny', ruleId, reason: 'rule fired' },
        score: 1,
        threshold: 0.5,
      }
    },
  }
}

function unavailableScreener(): SecurityScreener {
  return {
    provider: 'mock',
    shadow: false,
    async classify() {
      return {
        verdict: { decision: 'auto', unscreened: true, reason: 'proxy 502' },
        score: 0,
        threshold: 0.5,
      }
    },
  }
}

function throwingScreener(): SecurityScreener {
  return {
    provider: 'mock',
    shadow: false,
    async classify() {
      throw new Error('screener crashed')
    },
  }
}

test('screen-adapter: off mode skips screener and returns allow', async () => {
  const adapter = createSecurityScreenAdapter({ mode: 'off', screener: allowScreener() })
  const outcome = await adapter.screen(baseInput)
  assert.equal(outcome.mode, 'off')
  assert.equal(outcome.decision, 'allow')
})

test('screen-adapter: shadow mode records allow without blocking', async () => {
  const store = createMemoryShadowRecordStore()
  const adapter = createSecurityScreenAdapter({
    mode: 'shadow',
    screener: allowScreener(),
    shadowStore: store,
    buildExcerpt: () => 'hello world',
  })
  const outcome = await adapter.screen(baseInput)
  assert.equal(outcome.mode, 'shadow')
  assert.equal(outcome.decision, 'allow')
  const records = await store.list()
  assert.equal(records.length, 1)
  assert.equal(records[0]?.decision, 'allow')
})

test('screen-adapter: shadow mode records deny without blocking', async () => {
  const store = createMemoryShadowRecordStore()
  const adapter = createSecurityScreenAdapter({
    mode: 'shadow',
    screener: denyScreener(),
    shadowStore: store,
  })
  const outcome = await adapter.screen(baseInput)
  // Plan §3.2: Shadow NEVER blocks. Decision is allow even if screener denied.
  assert.equal(outcome.decision, 'deny')
  // The waterfall reads `decision` to set `screen` outcome; the actual
  // rejection is gated by mode='enforce'. Shadow allows the Turn.
  const records = await store.list()
  assert.equal(records.length, 1)
  assert.equal(records[0]?.decision, 'deny')
  assert.equal(records[0]?.ruleId, 'prompt-injection.v1')
})

test('screen-adapter: shadow mode records unavailable and allows the Turn', async () => {
  const store = createMemoryShadowRecordStore()
  const adapter = createSecurityScreenAdapter({
    mode: 'shadow',
    screener: unavailableScreener(),
    shadowStore: store,
  })
  const outcome = await adapter.screen(baseInput)
  assert.equal(outcome.decision, 'unavailable')
  // Plan §3.2: Shadow Mode screen failure records screen_unavailable and
  // allows the Turn. The waterfall's screen stage does NOT reject on
  // unavailable for shadow mode.
  const records = await store.list()
  assert.equal(records.length, 1)
  assert.equal(records[0]?.decision, 'unavailable')
})

test('screen-adapter: shadow mode catches screener exceptions and records unavailable', async () => {
  const store = createMemoryShadowRecordStore()
  const adapter = createSecurityScreenAdapter({
    mode: 'shadow',
    screener: throwingScreener(),
    shadowStore: store,
  })
  const outcome = await adapter.screen(baseInput)
  assert.equal(outcome.decision, 'unavailable')
  assert.match(outcome.reason ?? '', /crashed/)
  const records = await store.list()
  assert.equal(records[0]?.decision, 'unavailable')
})

test('screen-adapter: shadow mode without store throws', () => {
  assert.throws(
    () =>
      createSecurityScreenAdapter({
        mode: 'shadow',
        screener: allowScreener(),
      }),
    SecurityScreenAdapterError,
  )
})

test('screen-adapter: enforce mode without cutoverDeclared throws', () => {
  assert.throws(
    () =>
      createSecurityScreenAdapter({
        mode: 'enforce',
        screener: allowScreener(),
        cutoverDeclared: false,
      }),
    SecurityScreenAdapterError,
  )
  assert.throws(
    () =>
      createSecurityScreenAdapter({
        mode: 'enforce',
        screener: allowScreener(),
      }),
    SecurityScreenAdapterError,
  )
})

test('screen-adapter: enforce mode with cutoverDeclared allows allow', async () => {
  const adapter = createSecurityScreenAdapter({
    mode: 'enforce',
    screener: allowScreener(),
    cutoverDeclared: true,
  })
  const outcome = await adapter.screen(baseInput)
  assert.equal(outcome.decision, 'allow')
})

test('screen-adapter: enforce mode propagates deny verdict (waterfall rejects)', async () => {
  const adapter = createSecurityScreenAdapter({
    mode: 'enforce',
    screener: denyScreener('leak.v1'),
    cutoverDeclared: true,
  })
  const outcome = await adapter.screen(baseInput)
  assert.equal(outcome.decision, 'deny')
  assert.equal(outcome.ruleId, 'leak.v1')
})

test('screen-adapter: enforce mode fails closed when screener is unavailable', async () => {
  const adapter = createSecurityScreenAdapter({
    mode: 'enforce',
    screener: unavailableScreener(),
    cutoverDeclared: true,
  })
  const outcome = await adapter.screen(baseInput)
  assert.equal(outcome.decision, 'unavailable')
  // The waterfall in @qm/admission/waterfall.ts sees decision != 'allow'
  // for enforce mode and turns this into an Admission Record rejection.
})

test('screen-adapter: enforce mode fails closed when screener throws', async () => {
  const adapter = createSecurityScreenAdapter({
    mode: 'enforce',
    screener: throwingScreener(),
    cutoverDeclared: true,
  })
  const outcome = await adapter.screen(baseInput)
  assert.equal(outcome.decision, 'unavailable')
})

test('screen-adapter: redacts secrets in shadow record excerpts', async () => {
  const store = createMemoryShadowRecordStore()
  const adapter = createSecurityScreenAdapter({
    mode: 'shadow',
    screener: denyScreener(),
    shadowStore: store,
    buildExcerpt: () => 'API key is sk-ant-abcdefghijklmnop1234',
  })
  await adapter.screen(baseInput)
  const records = await store.list()
  const excerpt = records[0]?.redactedExcerpt ?? ''
  assert.ok(!excerpt.includes('sk-ant-abcdefghijklmnop1234'))
  assert.ok(excerpt.includes('[redacted-credential]'))
})

test('screen-adapter: shadow mode never records raw payload', async () => {
  const store = createMemoryShadowRecordStore()
  const adapter = createSecurityScreenAdapter({
    mode: 'shadow',
    screener: allowScreener(),
    shadowStore: store,
    buildExcerpt: () => 'Bearer sk-or-abcdefghijklmnop1234',
  })
  await adapter.screen(baseInput)
  const records = await store.list()
  const excerpt = records[0]?.redactedExcerpt ?? ''
  assert.ok(!excerpt.includes('sk-or-abcdefghijklmnop1234'))
})