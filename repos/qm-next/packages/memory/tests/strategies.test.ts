/**
 * Strategy-mode suite (parity 15.0): per-turn capture with cc copy,
 * consolidation math and CAS maintenance, agent-only prompts, and the
 * scratch-promote two-tier memory — all over the in-process ScopeMemory
 * and a scripted one-shot model.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScopeId } from '@qm/types'
import { createMemoryScopeMemory } from '../src/memory-store.ts'
import { createMemoryScratchLogStore, type ScratchLogStore } from '../src/scratch-log.ts'
import {
  applyConsolidationActions,
  bulletsBelowMarker,
  ccTargetFor,
  createAgentOnlyStrategy,
  createBurstBuffer,
  createConsolidator,
  createConsolidatingMemory,
  createMemoryStrategy,
  isAutonomousBurst,
  parseConsolidationActions,
  parseFacts,
  type MemoryModel,
} from '../src/index.ts'

function scriptedModel(responses: Array<string | Error>): MemoryModel & { calls: Array<{ system: string; prompt: string }> } {
  const calls: Array<{ system: string; prompt: string }> = []
  const queue = [...responses]
  return {
    calls,
    async oneShot(system: string, prompt: string) {
      calls.push({ system, prompt })
      const next = queue.shift()
      if (next instanceof Error) throw next
      return next
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('parseFacts accepts bullet lists and refuses NONE', () => {
  assert.deepEqual(parseFacts('NONE'), [])
  assert.deepEqual(parseFacts('none\n'), [])
  assert.deepEqual(parseFacts('- alpha\n- (2026-01-02) beta'), ['alpha', '(2026-01-02) beta'])
  assert.deepEqual(parseFacts(''), [])
})

test('ccTargetFor routes channel/group chatter to the speaker and nothing else', () => {
  assert.equal(ccTargetFor('channel:feishu:oc_1' as ScopeId, 'person:ada'), 'personal:person:ada')
  assert.equal(ccTargetFor('group:feishu:oc_2' as ScopeId, 'person:ada'), 'personal:person:ada')
  assert.equal(ccTargetFor('org:acme' as ScopeId, 'person:ada'), null)
  assert.equal(ccTargetFor('channel:feishu:oc_1' as ScopeId, undefined), null)
  assert.equal(ccTargetFor('channel:feishu:oc_1' as ScopeId, 'system:cron'), null)
  assert.equal(ccTargetFor('personal:person:ada' as ScopeId, 'person:ada'), null)
})

test('per-turn: turn ends become extraction bursts, non-autonomous facts cc to the speaker', async () => {
  const memory = createMemoryScopeMemory()
  const model = scriptedModel(['- Prefers terse replies'])
  const { strategy } = createMemoryStrategy('per-turn', { model, memory })
  assert.ok(strategy.onTurnEnd)

  await strategy.onTurnEnd({
    scopeId: 'channel:feishu:oc_1' as ScopeId,
    input: 'keep it short please',
    reply: 'ok',
    actorId: 'person:ada',
    conversationScopeId: 'channel:feishu:oc_1' as ScopeId,
    conversationLabel: '#eng',
  })

  const org = await memory.query('channel:feishu:oc_1' as ScopeId, 'terse')
  assert.equal(org.length, 1)
  const personal = await memory.query('personal:person:ada' as ScopeId, 'terse')
  assert.equal(personal.length, 1)
  assert.match(personal[0]!, /\(said in #eng\)/)
  assert.equal(model.calls[0]!.system.includes('PROVENANCE'), true)
})

test('per-turn: autonomous bursts get the addendum and skip the cc copy', async () => {
  const memory = createMemoryScopeMemory()
  const model = scriptedModel(['- Cron job stuck retrying'])
  const { strategy } = createMemoryStrategy('per-turn', { model, memory })
  await strategy.onTurnEnd!({
    scopeId: 'org:acme' as ScopeId,
    input: 'run the cron',
    reply: 'cron failed',
    actorId: 'system:cron',
    autonomous: true,
    conversationScopeId: 'org:acme' as ScopeId,
  })
  assert.equal((await memory.query('org:acme' as ScopeId, 'cron')).length, 1)
  assert.equal(model.calls[0]!.system.includes('AUTONOMOUS'), true)
  assert.deepEqual(await memory.query('personal:system:cron' as ScopeId, 'cron'), [])
})

test('per-turn: bursts buffer by key until the quiet window elapses', async () => {
  const flushed: Array<{ turns: number; scopeId: ScopeId }> = []
  const onTurnEnd = createBurstBuffer(30, 10, async (burst) => {
    flushed.push({ turns: burst.turns.length, scopeId: burst.scopeId })
  })
  await onTurnEnd({ scopeId: 'org:a' as ScopeId, input: 'i1', reply: 'r1' })
  await onTurnEnd({ scopeId: 'org:a' as ScopeId, input: 'i2', reply: 'r2' })
  await onTurnEnd({ scopeId: 'org:b' as ScopeId, input: 'i3', reply: 'r3' })
  assert.equal(flushed.length, 0, 'nothing flushes while the window is open')
  await sleep(60)
  assert.equal(flushed.length, 2)
  assert.deepEqual(flushed.map((f) => f.turns).sort(), [1, 2])
})

test('consolidation: action grammar and marker math', () => {
  const actions = parseConsolidationActions('UPDATE 2: prefers go now\nDELETE 1\nADD: owns the cli\nNONE')
  assert.deepEqual(actions, [
    { kind: 'update', index: 2, text: 'prefers go now' },
    { kind: 'delete', index: 1 },
    { kind: 'add', text: 'owns the cli' },
  ])
  const body = '# Memory\n\n- (2026-01-01) prefers rust\n- (2026-01-02) owns the cli\n'
  const next = applyConsolidationActions(body, actions, Date.UTC(2026, 0, 3))
  assert.match(next, /\(2026-01-02\) prefers go now/, 'an updated fact keeps its original capture date')
  assert.ok(!next.includes('prefers rust'))
  assert.match(next, /\(2026-01-03\) owns the cli/, 'a re-added fact is dated today')
  assert.match(next, /<!-- consolidated: 2026-01-03 -->/)
  assert.equal(bulletsBelowMarker(next), 0, 'everything consolidated sits above the marker')
  assert.equal(
    bulletsBelowMarker(`${next}\n- (2026-01-04) new capture\n- another\n`),
    2,
    'captures after a consolidation count below it',
  )
  assert.equal(isAutonomousBurst({ actorId: 'system:x' }), true)
  assert.equal(isAutonomousBurst({ autonomous: true }), true)
  assert.equal(isAutonomousBurst({ actorId: 'person:ada' }), false)
})

test('consolidation: maintain revises via CAS and the wrapper triggers on threshold', async () => {
  const memory = createMemoryScopeMemory()
  await memory.append('org:acme' as ScopeId, ['prefers rust', 'owns the cli'], Date.UTC(2026, 0, 1), 'person:ada')
  const model = scriptedModel(['UPDATE 1: prefers go now'])
  const consolidator = createConsolidator({ model, memory, afterN: 2 })
  assert.ok(consolidator)
  const { memory: wrapped, maintain } = createConsolidatingMemory(memory, consolidator)
  assert.ok(maintain)

  await maintain!('org:acme' as ScopeId)
  const bullets = await memory.query('org:acme' as ScopeId, 'prefers')
  assert.equal(bullets.length, 1)
  assert.match(bullets[0]!, /prefers go now/)

  model.calls.length = 0
  await wrapped.append('org:acme' as ScopeId, ['fresh fact one'], Date.now(), 'person:ada')
  await wrapped.append('org:acme' as ScopeId, ['fresh fact two'], Date.now(), 'person:ada')
  await sleep(10)
  assert.ok(model.calls.length >= 1, 'the wrapper reconsolidates once the threshold is crossed')
})

test('consolidation: a store that refuses the rewrite degrades to capture-only', async () => {
  const memory = createMemoryScopeMemory()
  const stubborn: typeof memory = {
    ...memory,
    replaceIfRevision: async () => false,
  }
  await stubborn.append('org:acme' as ScopeId, ['prefers rust'], Date.UTC(2026, 0, 1), 'person:ada')
  const logs: string[] = []
  const consolidator = createConsolidator({
    model: scriptedModel(['UPDATE 1: prefers go']),
    memory: stubborn,
    log: (m) => logs.push(m),
  })
  await consolidator!.maintain('org:acme' as ScopeId)
  assert.ok(logs[0]!.includes('capture-only'))
  await consolidator!.maybeMaintain('org:acme' as ScopeId)
})

test('agent-only: prompts only, nothing automatic', () => {
  const strategy = createAgentOnlyStrategy()
  assert.equal(strategy.onTurnEnd, undefined)
  assert.match(strategy.promptLines!()[0]!, /sole curator/)
})

test('scratch-promote: captures land in the scratch tier, promotion graduates durable facts', async () => {
  const memory = createMemoryScopeMemory()
  const scratch = createMemoryScratchLogStore()
  const model = scriptedModel(['# Memory\n\n- (2026-09-14) Prefers terse replies'])
  const { strategy, memory: twoTier } = createMemoryStrategy('scratch-promote', {
    model,
    memory,
    scratchLogs: scratch,
    consolidateAfter: 2,
  })
  assert.ok(strategy.onTurnEnd && strategy.maintain)
  assert.match(strategy.promptLines!()[0]!, /two tiers/)

  await twoTier.append('personal:person:ada' as ScopeId, ['Prefers terse replies'], Date.now(), 'person:ada')
  const today = new Date().toISOString().slice(0, 10)
  assert.match(await scratch.read('personal:person:ada' as ScopeId, today), /Prefers terse replies/)
  assert.match(await memory.get('personal:person:ada' as ScopeId), /captures-since-promote: 1/)
  assert.deepEqual(
    await memory.query('personal:person:ada' as ScopeId, 'terse'),
    [],
    'scratch facts are not notebook facts yet',
  )

  await twoTier.append('personal:person:ada' as ScopeId, ['Owns the cli'], Date.now(), 'person:ada')
  await sleep(10)
  const head = await memory.head('personal:person:ada' as ScopeId)
  assert.match(head.content, /Prefers terse replies/)
  assert.ok(!head.content.includes('captures-since-promote: 2'), 'the marker reset before promotion')
  assert.equal(model.calls.length, 1)
  assert.match(model.calls[0]!.prompt, /Scratch log:/)

  const recalled = await twoTier.recall('personal:person:ada' as ScopeId)
  assert.ok(recalled.includes('Prefers terse replies'))
  assert.ok(!recalled.includes('captures-since-promote'), 'recall strips the marker')
})

test('scratch-promote: the retention sweep drops logs past the window', async () => {
  const memory = createMemoryScopeMemory()
  const scratch = createMemoryScratchLogStore()
  const model = scriptedModel([new Error('no model in this deployment')])
  const { strategy } = createMemoryStrategy('scratch-promote', {
    model,
    memory,
    scratchLogs: scratch,
    consolidateAfter: 0,
  })
  const old = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
  await scratch.appendFacts('org:acme' as ScopeId, old, ['stale note'], Date.now())
  await strategy.maintain!('org:acme' as ScopeId)
  assert.equal(await scratch.read('org:acme' as ScopeId, old), '')
})

test('scratch-promote: a custom scratch store rides the same flow', async () => {
  const memory = createMemoryScopeMemory()
  const logs = new Map<string, string>()
  const scratch: ScratchLogStore = {
    read: async (s, d) => logs.get(`${s}|${d}`) ?? '',
    appendFacts: async (s, d, facts, at) => {
      const key = `${s}|${d}`
      const line = `- (${new Date(at).toISOString().slice(0, 10)}) ${facts.join(' ')}`
      const prev = logs.get(key) ?? ''
      logs.set(key, prev ? `${prev}\n${line}` : `# Scratch log ${d}\n\n${line}\n`)
      return facts.length
    },
    listDates: async (s) => [...logs.keys()].filter((k) => k.startsWith(`${s}|`)).map((k) => k.split('|')[1]!),
    remove: async (s, d) => {
      logs.delete(`${s}|${d}`)
    },
  }
  const model = scriptedModel(['# Memory\n\n- (2026-09-14) graduated'])
  const { memory: twoTier } = createMemoryStrategy('scratch-promote', {
    model,
    memory,
    scratchLogs: scratch,
    consolidateAfter: 1,
  })
  await twoTier.append('org:acme' as ScopeId, ['graduated'], Date.now(), 'person:ada')
  await sleep(10)
  assert.match(await memory.get('org:acme' as ScopeId), /graduated/)
})
