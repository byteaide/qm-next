/**
 * Orchestrator loop tests over the frozen contracts. Stores are local
 * in-memory fakes (packages/store is a parallel lane; integration happens at
 * the M1 rendezvous). Exercises: ok loop, refusals, routing, approval/silent
 * mapping, failure lease release, and the async queue path.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  BudgetCheck,
  BudgetTracker,
  Harness,
  HarnessRegistry,
  HarnessTurnInput,
  IdentityService,
  OrchestratorDeps,
  RateDecision,
  RateLimiter,
  ResolutionService,
  RunStore,
  ScopeId,
  SessionStore,
  TurnInput,
  TurnResult,
  TurnResolution,
} from '@qm/types'
import { Context } from '@qm/cordis'
import { createInMemoryEventLog, createMemorySequenceAllocator } from '@qm/concurrency'
import { createHarnessRouter, createMockHarness, OrchestratorService } from '../src/index.ts'

const SCOPE: ScopeId = 'org:test'
const ORG: ScopeId = 'org:test'

class FakeSessions implements SessionStore {
  sessions = new Map<string, { id: string; threadRef: string; surface: string; title?: string | null }>()
  entries = new Map<string, Array<{ seq: number; type: string; payload: unknown }>>()
  leases = new Map<string, string>()

  async getOrCreateByThread(threadRef: string, _type: any, _scopeId: ScopeId, surface: string, _channelName?: string) {
    let s = [...this.sessions.values()].find((x) => x.threadRef === threadRef)
    if (!s) {
      s = { id: `sess-${this.sessions.size + 1}`, threadRef, surface }
      this.sessions.set(s.id, s)
      this.entries.set(s.id, [])
    }
    return { id: s.id, type: 'dm', scopeId: SCOPE, threadRef, surface, createdAt: 0 } as any
  }

  async getByThread(threadRef: string) {
    const s = [...this.sessions.values()].find((x) => x.threadRef === threadRef)
    return s ? ({ id: s.id, type: 'dm', scopeId: SCOPE, threadRef, surface: s.surface, createdAt: 0 } as any) : null
  }

  async get(id: string) {
    const s = this.sessions.get(id)
    return s ? ({ id: s.id, type: 'dm', scopeId: SCOPE, threadRef: s.threadRef, surface: s.surface, createdAt: 0 } as any) : null
  }

  async updateTitle(sessionId: string, title: string) {
    const s = this.sessions.get(sessionId)
    if (s) s.title = title
  }

  async acquireLease(sessionId: string) {
    if (this.leases.has(sessionId)) return { lease: null, heldBy: 'turn' as const }
    const token = `tok-${Math.random()}`
    this.leases.set(sessionId, token)
    return { lease: { sessionId, token } }
  }

  async releaseLease(lease: { sessionId: string; token: string }) {
    if (this.leases.get(lease.sessionId) === lease.token) this.leases.delete(lease.sessionId)
  }

  async forceReleaseLease(sessionId: string) {
    this.leases.delete(sessionId)
  }

  async append(lease: { sessionId: string; token: string }, entry: { type: any; payload: unknown; scopeLabel: ScopeId }) {
    if (this.leases.get(lease.sessionId) !== lease.token) throw new Error('append without a valid session lease')
    const log = this.entries.get(lease.sessionId)!
    const full = { seq: log.length, type: entry.type, payload: entry.payload }
    log.push(full)
    return { sessionId: lease.sessionId, ...full, parentSeq: full.seq - 1, scopeLabel: entry.scopeLabel, createdAt: 0 } as any
  }

  async getEntries(sessionId: string) {
    return (this.entries.get(sessionId) ?? []).map((e) => ({
      sessionId,
      ...e,
      parentSeq: e.seq - 1,
      scopeLabel: SCOPE,
      createdAt: 0,
    })) as any[]
  }

  async addParticipant(): Promise<void> {}
  async removeParticipant(): Promise<void> {}
  async participantsOf(): Promise<string[]> {
    return []
  }

  async listByParticipant(): Promise<any[]> {
    return []
  }
  async searchEntries(): Promise<any[]> {
    return []
  }
  async patchSession(sessionId: string, patch: any) {
    const s = this.sessions.get(sessionId)
    if (!s) return null
    return { id: s.id, type: 'dm', scopeId: SCOPE, threadRef: s.threadRef, surface: s.surface, createdAt: 0, ...patch } as any
  }
  async forkSession(sessionId: string, _by: string, _opts?: any) {
    const s = this.sessions.get(sessionId)
    if (!s) return null
    return { session: { ...s } as any, entriesCopied: 0 }
  }
  async discardSession(): Promise<boolean> {
    return false
  }

  async sessionsByThreadRefs(threadRefs: readonly string[]) {
    const wanted = new Set(threadRefs)
    return [...this.sessions.values()]
      .filter((s) => wanted.has(s.threadRef))
      .map((s) => ({ id: s.id, threadRef: s.threadRef, scopeId: SCOPE, type: 'dm' as const, title: null }))
  }

  tapeRows = new Map<string, any[]>()
  async appendTape(lease: { sessionId: string; token: string }, rec: any) {
    if (this.leases.get(lease.sessionId) !== lease.token) throw new Error('appendTape without a valid session lease')
    const rows = this.tapeRows.get(lease.sessionId) ?? []
    this.tapeRows.set(lease.sessionId, rows)
    const full = { sessionId: lease.sessionId, seq: rows.length, createdAt: 0, ...rec }
    rows.push(full)
    return full
  }

  async getTape(sessionId: string) {
    return this.tapeRows.get(sessionId) ?? []
  }

  llmRequests = new Map<string, any[]>()
  async recordLlmRequest(sessionId: string, rec: any) {
    const rows = this.llmRequests.get(sessionId) ?? []
    this.llmRequests.set(sessionId, rows)
    const full = { id: `llm-${rows.length + 1}`, sessionId, createdAt: 0, ...rec }
    rows.push(full)
    return full
  }

  async listLlmRequests(sessionId: string) {
    return this.llmRequests.get(sessionId) ?? []
  }

  // --- M-Tape-1 projection readers (renderer view; not exercised by
  //     the orchestrator path itself, but the interface requires them). ---

  async getTranscriptEntries(sessionId: string) {
    const log = this.entries.get(sessionId) ?? []
    return [...log]
      .sort((a, b) => a.seq - b.seq)
      .map((e) => ({
        sessionId,
        seq: e.seq,
        parentSeq: e.seq === 0 ? null : e.seq - 1,
        type: e.type as any,
        payload: e.payload,
        scopeLabel: SCOPE,
        createdAt: 0,
      }))
  }

  async canReadTranscriptSuffix(_sessionId: string, _beforeSeq: number) {
    return true
  }

  async latestEntrySeq(sessionId: string) {
    const log = this.entries.get(sessionId) ?? []
    return log.length === 0 ? -1 : log[log.length - 1]!.seq
  }

  async visibleEntries(sessionId: string, _principalId: string) {
    return (this.entries.get(sessionId) ?? []).map((e) => ({
      sessionId,
      seq: e.seq,
      parentSeq: e.seq === 0 ? null : e.seq - 1,
      type: e.type as any,
      payload: e.payload,
      scopeLabel: SCOPE,
      createdAt: 0,
    }))
  }

  async participantWindowsOf(_sessionId: string) {
    return []
  }
}

class FakeRuns implements RunStore {
  runs = new Map<string, any>()
  async enqueue(input: any) {
    const run = {
      id: `run-${this.runs.size + 1}`,
      status: 'pending',
      targetState: 'queued',
      runSource: 'target',
      result: null,
      deliveryState: null,
      dedupKey: null,
      attempts: 0,
      errorAttempts: 0,
      maxAttempts: 3,
      leaseToken: null,
      leaseExpiresAt: null,
      workerId: null,
      createdAt: 0,
      startedAt: null,
      finishedAt: null,
      ...input,
    }
    this.runs.set(run.id, run)
    return { run, deduped: false }
  }
  async claim(_workerId: string, _ttlMs: number) {
    const run = [...this.runs.values()].find((r) => r.status === 'pending')
    if (!run) return null
    run.status = 'running'
    run.targetState = 'running'
    run.leaseToken = 'lease'
    return run
  }
  async claimById(runId: string) {
    const run = this.runs.get(runId)
    if (!run || run.status !== 'pending') return null
    run.status = 'running'
    run.targetState = 'running'
    run.leaseToken = 'lease'
    return run
  }
  async heartbeat(runId: string, token: string) {
    return this.runs.get(runId)?.leaseToken === token
  }
  async releaseLease(runId: string, token: string) {
    const run = this.runs.get(runId)
    if (run?.leaseToken !== token) return false
    run.status = 'pending'
    run.leaseToken = null
    return true
  }
  async complete(runId: string, token: string, result: TurnResult) {
    const run = this.runs.get(runId)
    if (run?.leaseToken !== token) return false
    run.targetState = 'succeeded'
    run.result = result
    return true
  }
  async fail(runId: string, token: string) {
    const run = this.runs.get(runId)
    if (run?.leaseToken !== token) return { requeued: false }
    run.status = 'failed'
    run.targetState = 'failed'
    run.leaseToken = null
    return { requeued: false }
  }
  async setDeliveryState() {
    return true
  }
  onTerminal(): void {}
  async get(runId: string) {
    return this.runs.get(runId) ?? null
  }
  async activeForThread(sessionId: string) {
    return [...this.runs.values()].find((r) => r.sessionId === sessionId && (r.status === 'pending' || r.status === 'running')) ?? null
  }
  async inFlightForThread(sessionId: string) {
    return [...this.runs.values()].filter((r) => r.sessionId === sessionId && (r.status === 'pending' || r.status === 'running'))
  }
  async withdraw(runId: string) {
    return this.runs.delete(runId)
  }
  async activeSessionIds() {
    // Phase 7 cutover: terminal truth is `targetState` (the legacy
    // `status` column stays 'running' on completed target rows).
    return [...new Set([...this.runs.values()].filter((r) => r.targetState !== 'succeeded' && r.targetState !== 'failed' && r.targetState !== 'cancelled').map((r) => r.sessionId))]
  }
  async list() {
    return [...this.runs.values()]
  }
  async reapExpired() {
    return { requeued: 0, parked: 0, skippedNewerSession: 0 }
  }
  async waitFor(runId: string) {
    return this.runs.get(runId)
  }
}

const identity: IdentityService = {
  isInternal: (p) => p.type === 'internal',
  audienceIsAllInternal: (audience) => audience.every((p) => p.type === 'internal'),
}

const resolution: ResolutionService = {
  resolve: async () => ({ systemPrompt: 'You are a test agent.', orgScopeId: ORG }) as TurnResolution,
  scopeFor: () => SCOPE,
}

function allowLimiter(): RateLimiter {
  return { check: async () => ({ allowed: true }) as RateDecision }
}

class GateLimiter implements RateLimiter {
  constructor(public allowed: boolean) {}
  async check() {
    return this.allowed ? { allowed: true } : { allowed: false, retryAfterMs: 42_000 }
  }
}

class GateBudget implements BudgetTracker {
  constructor(public allowed: boolean) {}
  async check(): Promise<BudgetCheck> {
    return this.allowed ? { allowed: true, spentUsd: 0, limitUsd: 10 } : { allowed: false, spentUsd: 12, limitUsd: 10 }
  }
  async record(): Promise<void> {}
}

function turnInput(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    surface: 'test',
    actor: { id: 'user-1', type: 'internal' },
    conversation: { kind: 'dm', threadRef: 'thread:1', audience: [{ id: 'user-1', type: 'internal' }] },
    origin: { kind: 'direct' },
    text: 'hello',
    ...overrides,
  }
}

function buildDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  const harnesses: Harness[] = [createMockHarness()]
  const registry: HarnessRegistry = createHarnessRouter({ defaultId: 'mock' })
  for (const h of harnesses) registry.register(h)
  return {
    sessions: new FakeSessions(),
    runs: new FakeRuns(),
    harness: registry,
    identity,
    resolution,
    rateLimiter: allowLimiter(),
    ...overrides,
  }
}

function boot(deps: OrchestratorDeps): OrchestratorService {
  return new OrchestratorService(new Context(), deps)
}

test('ok loop: reply, entries and lease release', async () => {
  const sessions = new FakeSessions()
  const deps = buildDeps({ sessions })
  const orch = boot(deps)
  const result = await orch.handleTurn(turnInput())
  assert.equal(result.status, 'ok')
  assert.equal(result.reply, 'echo: hello')
  assert.equal(result.sourceUserSeq, 0)
  assert.equal(result.sourceAssistantEntrySeq, 1)
  const entries = await sessions.getEntries(result.sessionId!)
  assert.deepEqual(
    entries.map((e) => e.type),
    ['user', 'assistant'],
  )
  assert.equal(sessions.leases.size, 0)
})

test('refused: non-internal principal', async () => {
  const orch = boot(buildDeps())
  const result = await orch.handleTurn(turnInput({ actor: { id: 'stranger', type: 'guest' } }))
  assert.equal(result.status, 'refused')
  assert.match(result.reason ?? '', /internal-only/)
})

test('refused: rate limit and budget', async () => {
  const orch = boot(buildDeps({ rateLimiter: new GateLimiter(false) }))
  const limited = await orch.handleTurn(turnInput())
  assert.equal(limited.status, 'refused')
  assert.match(limited.reason ?? '', /rate limit/)

  const orch2 = boot(buildDeps({ budget: new GateBudget(false) }))
  const broke = await orch2.handleTurn(turnInput())
  assert.equal(broke.status, 'refused')
  assert.match(broke.reason ?? '', /budget exceeded/)
})

test('routing: explicit id, default, unknown throws', async () => {
  const alt = createMockHarness({ defaultReply: 'alt reply' })
  alt.profile.id = 'alt'
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(createMockHarness())
  registry.register(alt)
  const orch = boot(buildDeps({ harness: registry }))
  assert.equal((await orch.handleTurn(turnInput())).reply, 'echo: hello')
  assert.equal((await orch.handleTurn(turnInput({ harness: 'alt' }))).reply, 'alt reply')
  const unknown = await orch.handleTurn(turnInput({ harness: 'nope' }))
  assert.equal(unknown.status, 'refused')
  assert.match(unknown.reason ?? '', /unknown harness/)
})

test('pending approval mapping', async () => {
  const approval = { command: 'rm -rf /', reason: 'destructive' }
  const mock = createMockHarness({ script: [{ reply: 'need a yes', pausedOnApproval: true, pendingApprovals: [approval] }] })
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(mock)
  const orch = boot(buildDeps({ harness: registry }))
  const result = await orch.handleTurn(turnInput())
  assert.equal(result.status, 'pending_approval')
  assert.equal(result.pendingApprovals?.[0]?.command, 'rm -rf /')
})

test('silent mapping keeps stopped flag', async () => {
  const mock = createMockHarness({ script: [{ reply: '', silent: true, stopped: true }] })
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(mock)
  const orch = boot(buildDeps({ harness: registry }))
  const result = await orch.handleTurn(turnInput())
  assert.equal(result.status, 'silent')
  assert.equal(result.stopped, true)
})

test('harness failure maps to failed and releases the lease', async () => {
  const sessions = new FakeSessions()
  const mock = createMockHarness({ script: [new Error('model exploded')] })
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(mock)
  const orch = boot(buildDeps({ sessions, harness: registry }))
  const result = await orch.handleTurn(turnInput())
  assert.equal(result.status, 'failed')
  assert.match(result.reason ?? '', /model exploded/)
  assert.equal(sessions.leases.size, 0)
})

test('async queue path: enqueue, claim, handleTurn, complete', async () => {
  const sessions = new FakeSessions()
  const runs = new FakeRuns()
  const orch = boot(buildDeps({ sessions, runs }))
  const session = await sessions.getOrCreateByThread('thread:1', 'dm', SCOPE, 'test')
  const { run } = await runs.enqueue({ sessionId: session.id, request: turnInput() })
  const claimed = await runs.claim('worker-1', 5_000)
  assert.ok(claimed)
  const result = await orch.handleTurn({ ...claimed.request, runId: claimed.id })
  assert.equal(result.status, 'ok')
  assert.equal(await runs.complete(claimed.id, claimed.leaseToken!, result), true)
  const stored = await runs.get(run.id)
  assert.equal(stored?.runSource, 'target')
  assert.equal(stored?.targetState, 'succeeded')
  assert.equal(stored?.result?.reply, 'echo: hello')
})

test('run events: typed attempt/progress events publish for runId turns only, seq from the allocator', async () => {
  const log = createInMemoryEventLog({ allocator: createMemorySequenceAllocator() })
  const harness = createMockHarness({ defaultReply: 'streamed', deltas: ['he', 'llo'] })
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(harness)
  const orch = boot(buildDeps({ harness: registry, runEventLog: log.bus }))

  const live: string[] = []
  const unsubscribe = log.bus.subscribe({ runId: 'run-1', seq: -1 }, (event) => live.push(`${event.kind}@${event.seq}`))
  const result = await orch.handleTurn(turnInput({ runId: 'run-1' }))
  assert.equal(result.status, 'ok')
  unsubscribe()

  const events = log.readAll('run-1')
  const describe = (e: (typeof events)[number]): string =>
    e.kind === 'progress' ? `progress:${e.redactedExcerpt}` : `${e.kind}`
  // Phase 7 / KV-006: the orchestrator publishes non-terminal events only
  // (attempt.started, progress with redacted excerpts); terminal truth is
  // the runner's post-commit run.finished, not an orchestrator publish.
  assert.deepEqual(
    events.map(describe),
    ['attempt.started', 'progress:he', 'progress:llo', 'attempt.finished'],
  )
  assert.deepEqual(live, events.map((e) => `${e.kind}@${e.seq}`))
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!
    // Monotonic from 0 — the allocator's contract, not a self-assigned seq.
    assert.equal(event.seq, index)
    assert.equal(event.runId, 'run-1')
    assert.equal(event.sessionId, result.sessionId)
    assert.equal(typeof event.ts, 'number')
  }

  await orch.handleTurn(turnInput())
  assert.equal(log.readAll('run-1').length, 4)
})

test('tool context: the factory result rides the harness turn; null opts out', async () => {
  const seen: Array<unknown> = []
  const captureHarness = {
    profile: { id: 'capture', label: 'capture', capabilities: {} },
    turns: {
      runTurn: async (input: { tools?: unknown }) => {
        seen.push(input.tools)
        return { reply: 'captured' }
      },
    },
  } as unknown as Harness
  const registry = createHarnessRouter({ defaultId: 'capture' })
  registry.register(captureHarness)
  const ctx = { execute: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }) }
  const scopedTool: OrchestratorDeps['tools'] = ({ sessionId }) => (sessionId === 'sess-1' ? (ctx as never) : null)
  const orch = boot(buildDeps({ harness: registry, tools: scopedTool }))
  const result = await orch.handleTurn(turnInput())
  assert.equal(result.status, 'ok')
  assert.equal(seen.length, 1)
  assert.equal(seen[0], ctx)

  const otherScope = await orch.handleTurn(
    turnInput({ conversation: { kind: 'dm', threadRef: 'thread:2', audience: [{ id: 'user-1', type: 'internal' }] } }),
  )
  assert.equal(otherScope.status, 'ok')
  assert.equal(seen.length, 2)
  assert.equal(seen[1], undefined)

  const bare = boot(buildDeps({ harness: registry }))
  await bare.handleTurn(turnInput())
  assert.equal(seen.length, 3)
  assert.equal(seen[2], undefined)
})

test('mode selection rides the harness turn input (ADR-0018)', async () => {
  const captured: Array<{ systemPrompt: string; systemCacheBoundary: number | undefined; surfaceTools: boolean | undefined }> = []
  const mock = createMockHarness()
  const capturing: Harness = {
    profile: mock.profile,
    models: mock.models,
    tools: mock.tools,
    turns: {
      runTurn: async (input: HarnessTurnInput) => {
        captured.push({ systemPrompt: input.systemPrompt, systemCacheBoundary: input.systemCacheBoundary, surfaceTools: input.surfaceTools })
        return mock.turns.runTurn(input)
      },
    },
  } as unknown as Harness
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(capturing)
  const soulResolution: ResolutionService = {
    resolve: async () => ({
      systemPrompt: 'soul-body',
      orgScopeId: ORG,
      securityPrompt: '## Security posture: Strict',
      memoryBlock: '\n\n## What you remember\nctx\n\nfact',
    }),
    scopeFor: () => SCOPE,
  }
  const orch = boot(buildDeps({ harness: registry, resolution: soulResolution }))

  await orch.handleTurn(turnInput())
  assert.equal(captured[0]!.surfaceTools, false, 'human DM is conversational — no surface tools')
  assert.match(captured[0]!.systemPrompt, /live, private 1:1/)
  assert.ok(captured[0]!.systemPrompt.includes('soul-body'))
  assert.ok(captured[0]!.systemPrompt.includes('## Security posture: Strict'))
  const boundary = captured[0]!.systemCacheBoundary!
  assert.ok(!captured[0]!.systemPrompt.slice(0, boundary).includes('## What you remember'), 'memory stays outside the cache boundary')
  assert.ok(captured[0]!.systemPrompt.slice(boundary).includes('## What you remember'), 'memory appends after the boundary')

  captured.length = 0
  await orch.handleTurn(
    turnInput({ origin: { kind: 'ambient' }, conversation: { kind: 'channel', threadRef: 'thread:3', audience: [{ id: 'user-1', type: 'internal' }] } }),
  )
  assert.equal(captured[0]!.surfaceTools, true, 'ambient turns carry the surface tool set')
  assert.match(captured[0]!.systemPrompt, /Silence is the default and costs nothing\./)

  captured.length = 0
  await orch.handleTurn(turnInput({ origin: { kind: 'automation' } }))
  assert.equal(captured[0]!.surfaceTools, false)
  assert.match(captured[0]!.systemPrompt, /no live 1:1 with a person and no surface tools/)
})

test('segment 15: onboarding appends after memory, outside the cache boundary', async () => {
  const captured: Array<{ systemPrompt: string; systemCacheBoundary: number | undefined }> = []
  const mock = createMockHarness()
  const capturing: Harness = {
    profile: mock.profile,
    models: mock.models,
    tools: mock.tools,
    turns: {
      runTurn: async (input: HarnessTurnInput) => {
        captured.push({ systemPrompt: input.systemPrompt, systemCacheBoundary: input.systemCacheBoundary })
        return mock.turns.runTurn(input)
      },
    },
  } as unknown as Harness
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(capturing)
  const soulResolution: ResolutionService = {
    resolve: async () => ({
      systemPrompt: 'soul-body',
      orgScopeId: ORG,
      memoryBlock: '\n\n## What you remember\nctx\n\nfact',
      onboardingBlock: '## Pending Onboarding\nMemory has no onboarding completion marker for v2.',
    }),
    scopeFor: () => SCOPE,
  }
  const orch = boot(buildDeps({ harness: registry, resolution: soulResolution }))

  await orch.handleTurn(turnInput())
  const prompt = captured[0]!.systemPrompt
  const boundary = captured[0]!.systemCacheBoundary!
  assert.ok(prompt.slice(0, boundary).includes('soul-body'), 'stable prefix holds the soul')
  assert.ok(!prompt.slice(0, boundary).includes('## Pending Onboarding'), 'onboarding never enters the cache boundary')
  const memoryAt = prompt.indexOf('## What you remember')
  const onboardingAt = prompt.indexOf('## Pending Onboarding')
  assert.ok(memoryAt > boundary && onboardingAt > memoryAt, 'qm segment order: memory then onboarding, both post-boundary')
})

test('proactive opener with empty text feeds the opener prompt to the harness', async () => {
  const captured: Array<{ input: string }> = []
  const mock = createMockHarness()
  const capturing: Harness = {
    profile: mock.profile,
    models: mock.models,
    tools: mock.tools,
    turns: {
      runTurn: async (input: HarnessTurnInput) => {
        captured.push({ input: input.input })
        return mock.turns.runTurn(input)
      },
    },
  } as unknown as Harness
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(capturing)
  const sessions = new FakeSessions()
  const orch = boot(buildDeps({ harness: registry, sessions }))

  const opener = turnInput({ proactiveOpener: true, text: '   ' })
  const openerResult = await orch.handleTurn(opener)
  assert.ok(captured[0]!.input.includes("hasn't typed anything yet"), 'empty opener text substitutes the opener prompt')
  const entries = await sessions.getEntries(openerResult.sessionId!)
  const userEntry = entries.find((e) => e.type === 'user')
  assert.equal((userEntry!.payload as { text?: string }).text, '   ', 'the session entry keeps the raw (whitespace) inbound text')

  captured.length = 0
  await orch.handleTurn(turnInput({ proactiveOpener: true, text: 'real user text' }))
  assert.equal(captured[0]!.input, 'real user text', 'non-empty opener text passes through untouched')

  captured.length = 0
  await orch.handleTurn(turnInput({ text: '' }))
  assert.equal(captured[0]!.input, '', 'empty text without the opener flag stays empty')
})
