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
import { createMemoryRunEventBus } from '@qm/store'
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
}

class FakeRuns implements RunStore {
  runs = new Map<string, any>()
  async enqueue(input: any) {
    const run = {
      id: `run-${this.runs.size + 1}`,
      status: 'pending',
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
    run.leaseToken = 'lease'
    return run
  }
  async claimById(runId: string) {
    const run = this.runs.get(runId)
    if (!run || run.status !== 'pending') return null
    run.status = 'running'
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
    run.status = 'done'
    run.result = result
    return true
  }
  async fail(runId: string, token: string) {
    const run = this.runs.get(runId)
    if (run?.leaseToken !== token) return { requeued: false }
    run.status = 'failed'
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
    return [...new Set([...this.runs.values()].filter((r) => r.status !== 'done' && r.status !== 'failed').map((r) => r.sessionId))]
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
  assert.equal(stored?.status, 'done')
  assert.equal(stored?.result?.reply, 'echo: hello')
})

test('run events: deltas, progress and terminal status publish for runId turns only', async () => {
  const bus = createMemoryRunEventBus()
  const harness = createMockHarness({ defaultReply: 'streamed', deltas: ['he', 'llo'] })
  const registry = createHarnessRouter({ defaultId: 'mock' })
  registry.register(harness)
  const orch = boot(buildDeps({ harness: registry, runEvents: bus }))

  const live: string[] = []
  bus.subscribe('run-1', (event) => live.push(`${event.kind}@${event.seq}`))
  const result = await orch.handleTurn(turnInput({ runId: 'run-1' }))
  assert.equal(result.status, 'ok')

  const events = bus.replay('run-1')
  const describe = (e: (typeof events)[number]): string =>
    e.kind === 'delta' ? `delta:${e.text}` : e.kind === 'status' ? `status:${e.status}` : `progress:${e.toolCalls}`
  assert.deepEqual(
    events.map(describe),
    ['status:running', 'delta:he', 'delta:llo', 'status:ok'],
  )
  assert.deepEqual(live, events.map((e) => `${e.kind}@${e.seq}`))
  for (const [index, event] of events.entries()) {
    assert.equal(event.seq, index)
    assert.equal(event.runId, 'run-1')
    assert.equal(event.sessionId, result.sessionId)
  }

  await orch.handleTurn(turnInput())
  assert.equal(bus.replay('run-1').length, 4)
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
