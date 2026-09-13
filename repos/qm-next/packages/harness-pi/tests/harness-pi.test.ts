import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isContextOverflow, isRetryableAssistantError } from '@earendil-works/pi-ai'
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options'
import {
  guardOutputBudget,
  OUTPUT_BUDGET_FLOOR_TOKENS,
  OUTPUT_GUARD_SAFETY_TOKENS,
  parseDetectVerdict,
  buildDetectionPrompt,
  sanitizeTitle,
  trimPayloadToByteBudget,
  seedRawMessagesIntoSession,
  planColdStartSeed,
  lintFold,
  foldTape,
  planTapeSeed,
  reconstructMessagesFromHistory,
  seedPriorTurns,
  createGoalRecord,
  goalSteeringNote,
  enforceGoal,
  createGrindMeter,
  classifyScopeLabel,
  createPiTools,
  type ToolContextRef,
} from '@qm/harness-pi'
import type { SessionEntry, TapeRecord, ToolContext } from '@qm/types'

const FABLE = { contextWindow: 200_000, maxTokens: 64_000 }

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-fable-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    system: [{ type: 'text', text: 'You are Agent.' }],
    max_tokens: 64_000,
    stream: true,
    ...over,
  }
}

function asAssistantError(err: Error) {
  return {
    role: 'assistant',
    content: [],
    provider: 'anthropic',
    model: 'claude-fable-5',
    stopReason: 'error',
    errorMessage: err.message,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    timestamp: Date.now(),
  } as never
}

test('output-budget guard: healthy cap untouched', () => {
  const p = payload()
  const before = JSON.stringify(p)
  assert.deepEqual(guardOutputBudget(p, FABLE), { kind: 'ok' })
  assert.equal(JSON.stringify(p), before, 'payload not mutated')
})

test('output-budget guard: clamped cap raised to model cap', () => {
  const p = payload({ max_tokens: 1 })
  const r = guardOutputBudget(p, FABLE)
  assert.equal(r.kind, 'raised')
  assert.equal(p.max_tokens, FABLE.maxTokens, 'cap restored to the model\'s own output cap')
})

test('output-budget guard: raise bounded by window - estimate - safety', () => {
  const text = 'x'.repeat(600_000)
  const p = payload({ max_tokens: 1, messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
  const r = guardOutputBudget(p, FABLE)
  assert.equal(r.kind, 'raised')
  if (r.kind !== 'raised') return
  assert.equal(r.to, FABLE.contextWindow - r.estimatedPromptTokens - OUTPUT_GUARD_SAFETY_TOKENS)
  assert.ok(r.to < FABLE.maxTokens, 'could not fit the full model cap')
  assert.ok(r.to >= OUTPUT_BUDGET_FLOOR_TOKENS, 'but always at least the floor')
  assert.equal(p.max_tokens, r.to)
})

test('output-budget guard: genuinely full refuses and pi-ai treats it as overflow', () => {
  const text = 'x'.repeat(790_000)
  const p = payload({ max_tokens: 1, messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
  assert.throws(() => guardOutputBudget(p, FABLE), /prompt is too long/i)
  try {
    guardOutputBudget(p, FABLE)
  } catch (e) {
    const err = e as Error
    assert.equal(isRetryableAssistantError(asAssistantError(err)), false, 'never a blind same-payload retry')
    assert.equal(isContextOverflow(asAssistantError(err), FABLE.contextWindow), true, 'handled as overflow')
  }
})

test('output-budget guard: inline image bytes do not fake a full window', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(1_000_000) } }
  const p = payload({
    max_tokens: 1,
    messages: [{ role: 'user', content: [image, { type: 'text', text: 'what is this?' }] }],
  })
  const r = guardOutputBudget(p, FABLE)
  assert.equal(r.kind, 'raised', 'raised, not thrown')
  assert.equal(p.max_tokens, FABLE.maxTokens)
})

test('output-budget guard: non-image data blobs count at full length', () => {
  const blob = { type: 'redacted_thinking', data: 'E'.repeat(790_000) }
  const p = payload({
    max_tokens: 1,
    messages: [
      { role: 'assistant', content: [blob] },
      { role: 'user', content: [{ type: 'text', text: 'go on' }] },
    ],
  })
  assert.throws(() => guardOutputBudget(p, FABLE), /prompt is too long/i)
})

test('output-budget guard: pdf documents and pasted data URLs count at full length', () => {
  const doc = {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: 'P'.repeat(790_000) },
  }
  const docPayload = payload({
    max_tokens: 1,
    messages: [{ role: 'user', content: [doc] }],
  })
  assert.throws(() => guardOutputBudget(docPayload, FABLE), /prompt is too long/i)
  const pasted = 'data:image/png;base64,' + 'Q'.repeat(790_000)
  const pastedAsText = payload({
    max_tokens: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text: pasted }] }],
  })
  assert.throws(() => guardOutputBudget(pastedAsText, FABLE), /prompt is too long/i)
  const asImage = payload({
    max_tokens: 1,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: pasted } },
          { type: 'text', text: 'what is this?' },
        ],
      },
    ],
  })
  assert.equal(guardOutputBudget(asImage, FABLE).kind, 'raised')
})

test('output-budget guard: unknown shapes and missing windows left alone', () => {
  assert.deepEqual(guardOutputBudget({ input: 'no cap field' }, FABLE), { kind: 'ok' })
  assert.deepEqual(guardOutputBudget(null, FABLE), { kind: 'ok' })
  assert.deepEqual(guardOutputBudget('nonsense', FABLE), { kind: 'ok' })
  const nonNumeric = payload({ max_tokens: '64000' })
  assert.deepEqual(guardOutputBudget(nonNumeric, FABLE), { kind: 'ok' })
  const p = payload({ max_tokens: 1 })
  assert.deepEqual(guardOutputBudget(p, {}), { kind: 'ok' })
  assert.equal(p.max_tokens, 1)
})

test('pi-ai characterization: a stale usage anchor clamps max_tokens to 1', () => {
  const staleAnchor = {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    stopReason: 'stop',
    usage: {
      input: 2,
      output: 1,
      cacheRead: 198_187,
      cacheWrite: 412,
      totalTokens: 198_602,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-fable-5',
  }
  const context = {
    systemPrompt: 'You are Agent.',
    messages: [
      staleAnchor,
      { role: 'user', content: [{ type: 'text', text: 'please write the final report' }], timestamp: Date.now() },
    ],
  }
  const clamped = clampMaxTokensToContext({ contextWindow: 200_000 } as never, context as never, 64_000)
  assert.equal(clamped, 1, 'upstream floors the cap at 1 instead of failing or compacting')
})

test('detect verdict: yes/no/react parsing with emoji dedupe', () => {
  assert.equal(parseDetectVerdict('YES\nbecause asked', false).respond, true)
  assert.equal(parseDetectVerdict('verdict: no — chit-chat', false).respond, false)
  const react = parseDetectVerdict('REACT :eyes: 👍 :eyes:', true)
  assert.equal(react.respond, false)
  assert.deepEqual(react.reactions, ['eyes', '👍'])
  assert.ok(buildDetectionPrompt('nice work gets a thumbs up').includes('REACT'))
  assert.ok(!buildDetectionPrompt().includes('REACT (a REACT verdict'))
})

test('sanitizeTitle rejects reply-shaped output and caps length', () => {
  assert.equal(sanitizeTitle('Fix hover gap chevron'), 'Fix hover gap chevron')
  assert.equal(sanitizeTitle('NONE'), undefined)
  assert.equal(sanitizeTitle("I'm sorry, I cannot help with that at all because it is beyond my"), undefined)
  assert.equal(sanitizeTitle('x'.repeat(100)), undefined, 'one long word is rejected outright')
  const capped = sanitizeTitle(`fix ${'y'.repeat(70)}`)
  assert.ok(capped && capped.length <= 61, 'capped at 60 chars plus ellipsis')
})

test('trimPayloadToByteBudget elides inline images first', () => {
  const big = 'A'.repeat(4_000_000)
  const p = {
    messages: [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: big, media_type: 'image/png' } }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
  }
  const out = trimPayloadToByteBudget(p, 1_000_000) as { messages: Array<{ content: unknown[] }> }
  const first = out.messages[0]!.content[0] as { source?: { data?: string }; text?: string }
  assert.equal(first.source, undefined)
  assert.ok((first.text ?? '').includes('[image removed'))
  const second = out.messages[1]!.content[0] as { text?: string }
  assert.equal(second.text, 'hi')
})

test('seedRawMessagesIntoSession pushes into agent state and tolerates append errors', () => {
  const state: { messages: unknown[] } = { messages: [] }
  const session = {
    agent: { state },
    sessionManager: { appendMessage: () => { throw new Error('boom') } },
  }
  const messages = reconstructMessagesFromHistory([])
  seedRawMessagesIntoSession(session, [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }])
  assert.equal(state.messages.length, 1)
  assert.equal(messages.length, 0)
  assert.equal(planColdStartSeed(null, false), 'preamble')
  assert.equal(planColdStartSeed(null, true), 'priorTurns')
  assert.equal(planColdStartSeed([], true), 'priorTurns')
  assert.equal(planColdStartSeed([{ role: 'user', content: [{ type: 'text', text: 'x' }], timestamp: 1 }], false), 'structured')
})

function entry(partial: Partial<SessionEntry> & { type: SessionEntry['type']; payload: unknown }): SessionEntry {
  return {
    sessionId: 's1',
    seq: partial.seq ?? 1,
    parentSeq: null,
    scopeLabel: 'personal:u1',
    createdAt: 1_000,
    ...partial,
  } as SessionEntry
}

test('replay reconstruction pairs tool calls with results and flags interrupts', () => {
  const history: SessionEntry[] = [
    entry({ seq: 1, type: 'user', payload: { text: 'run it' } }),
    entry({ seq: 2, type: 'assistant', payload: { text: 'ok' } }),
    entry({ seq: 3, type: 'tool_call', payload: { callId: 'c1', tool: 'execute', command: 'ls' } }),
    entry({ seq: 4, type: 'tool_result', payload: { callId: 'c1', result: 'files', isError: false } }),
    entry({ seq: 5, type: 'tool_call', payload: { callId: 'c2', tool: 'execute', command: 'rm' } }),
  ]
  const messages = reconstructMessagesFromHistory(history)
  assert.equal(messages[0]!.role, 'user')
  assert.equal(messages[1]!.role, 'assistant')
  const call1 = messages[2] as { role: string; content: Array<{ type: string; id: string }> }
  assert.equal(call1.content[0]!.id, 'c1')
  const result1 = messages[3] as { role: string; toolCallId: string; isError: boolean }
  assert.equal(result1.toolCallId, 'c1')
  assert.equal(result1.isError, false)
  const result2 = messages[5] as { role: string; isError: boolean; content: Array<{ text: string }> }
  assert.equal(result2.isError, true)
  assert.ok(result2.content[0]!.text.includes('interrupted'))
  const lint = lintFold(messages)
  assert.deepEqual(lint.problems, [], 'reconstruction always synthesizes results, so the fold is lintable')
})

test('replay merges consecutive user messages and drops leading non-user', () => {
  const history: SessionEntry[] = [
    entry({ seq: 1, type: 'assistant', payload: { text: 'earlier' } }),
    entry({ seq: 2, type: 'user', payload: { text: 'a' } }),
    entry({ seq: 3, type: 'user', payload: { text: 'b' } }),
  ]
  const messages = reconstructMessagesFromHistory(history)
  assert.equal(messages.length, 1)
  assert.equal(messages[0]!.role, 'user')
  assert.equal((messages[0] as { content: unknown[] }).content.length, 2)
})

test('seedPriorTurns dedupes, quotes both roles as user transcript, and merges', () => {
  const seeded = seedPriorTurns(
    [
      { role: 'user', text: 'hello' },
      { role: 'assistant', name: 'agent', text: 'hi there' },
      { role: 'user', text: 'hello' },
    ],
    [],
  )
  assert.equal(seeded.length, 1, 'same-role replays merge into one user message')
  assert.ok(seeded[0]!.text.startsWith('<message from="human"'))
  assert.ok(seeded[0]!.text.includes('via="agent"'))
})

function tapeRow(partial: Partial<TapeRecord> & { payload: unknown }): TapeRecord {
  return {
    kind: 'message',
    harness: 'pi',
    scopeLabel: 'personal:u1',
    sessionId: 's1',
    seq: 1,
    createdAt: 1,
    ...partial,
  } as TapeRecord
}

test('tape fold: lint catches dangling calls, interrupt heals, foreign harness skipped', () => {
  const call = tapeRow({
    seq: 2,
    payload: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'c1', name: 'execute', arguments: {} }],
      timestamp: 2,
      stopReason: 'stop',
    },
  })
  const rows: TapeRecord[] = [
    tapeRow({ seq: 1, payload: { role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: 1 } }),
    call,
    tapeRow({ kind: 'context_event', seq: 3, payload: { event: 'interrupt' } }),
  ]
  const dangling = foldTape(rows.slice(0, 2))
  assert.equal(lintFold(dangling).ok, false, 'unanswered call is a lint failure')
  assert.equal(planTapeSeed(rows.slice(0, 2), 'pi', 'serve').seed, null, 'unlintable fold is not served')

  const healed = foldTape(rows)
  assert.deepEqual(lintFold(healed).problems, [], 'the interrupt event heals dangling calls')
  assert.equal(planTapeSeed(rows, 'pi', 'serve')!.seed!.length, healed.length)
  assert.deepEqual(planTapeSeed(rows, 'claude', 'serve').skip, 'foreign-harness')
})

test('classifyScopeLabel routes soul to org and tool_result to source', () => {
  assert.equal(classifyScopeLabel({ type: 'soul', sessionScopeId: 'channel:c1', orgScopeId: 'org:o1' }), 'org:o1')
  assert.equal(
    classifyScopeLabel({
      type: 'tool_result',
      sessionScopeId: 'channel:c1',
      orgScopeId: 'org:o1',
      sourceScopeId: 'personal:u2',
    }),
    'personal:u2',
  )
  assert.equal(
    classifyScopeLabel({ type: 'user', sessionScopeId: 'channel:c1', orgScopeId: 'org:o1', sourceScopeId: null }),
    'channel:c1',
  )
})

test('goal records validate and enforceGoal loops with waiver', async () => {
  assert.throws(() => createGoalRecord({ objective: '   ', source: 'tool' }))
  assert.throws(() => createGoalRecord({ objective: 'x', capTokens: -1, source: 'tool' }))
  const goal = createGoalRecord({ objective: 'make tests green', source: 'tool', now: 1 })
  assert.equal(goal.blockedStreak, 0)
  assert.ok(goalSteeringNote(goal).includes('<objective>'))
  let prompts = 0
  const result = await enforceGoal({
    goal,
    meter: createGrindMeter(1),
    outcome: 'ok',
    ok: 'ok' as const,
    toolCalls: () => 0,
    blocked: () => false,
    beforePrompt: () => {},
    prompt: async () => {
      prompts++
      return 'ok'
    },
  })
  assert.equal(result.outcome, 'ok')
  assert.ok(result.waiverNote.includes('goal waived'))
  assert.equal(prompts, 4, 'four continuation prompts, then the stall waiver')
})

function fakeRef(over: Partial<ToolContextRef> = {}): ToolContextRef {
  return { current: null, ...over }
}

function fakeToolContext(over: Partial<Record<string, unknown>> = {}): ToolContext {
  return {
    execute: async () => ({ code: 0, stdout: 'out', stderr: '', timedOut: false }),
    restartComputer: async () => undefined,
    computerStatus: async () => ({ machine: 'up', guestResponsive: true }),
    ...over,
  } as unknown as ToolContext
}

test('pi-tools: readOnly trims to read-only tools; execute runs through the context', async () => {
  const ref = fakeRef({ current: fakeToolContext() })
  const readOnly = createPiTools(ref, { readOnly: true })
  assert.deepEqual(
    readOnly.map((t) => t.name).sort(),
    ['finish_silently', 'history', 'memory'],
  )
  const full = createPiTools(ref, {})
  const execute = full.find((t) => t.name === 'execute')!
  const result = (await execute.execute('call-1', { command: 'ls', purpose: 'list' }, undefined, undefined, {} as never)) as {
    content: Array<{ text: string }>
  }
  assert.ok(result.content[0]!.text.includes('[exit 0]'))
  const read = full.find((t) => t.name === 'read')!
  assert.ok(read, 'read tool present')
})

test('pi-tools: approval flows record pending approvals and pause the turn', async () => {
  const { NeedsApproval } = await import('@qm/types')
  const ref = fakeRef({
    current: fakeToolContext({
      execute: async () => {
        throw new NeedsApproval('rm -rf /', 'destructive command')
      },
    }),
    pendingApprovals: [],
  })
  const tools = createPiTools(ref, {})
  const execute = tools.find((t) => t.name === 'execute')!
  const result = (await execute.execute('call-1', { command: 'rm -rf /', purpose: 'cleanup' }, undefined, undefined, {} as never)) as {
    content: Array<{ text: string }>
  }
  assert.ok(result.content[0]!.text.includes('[blocked: needs human approval]'))
  assert.equal(ref.pausedOnApproval, true)
  assert.equal(ref.pendingApprovals!.length, 1)
  assert.equal(ref.pendingApprovals![0]!.command, 'rm -rf /')
})
