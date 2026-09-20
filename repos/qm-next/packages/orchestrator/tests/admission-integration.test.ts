/**
 * Phase 3 — Orchestrator integration tests.
 *
 * Asserts that:
 *  - identity rejection never creates a Run (ADR-0006)
 *  - rate-limit rejection never creates a Run
 *  - accepted Turn has full Admission Record with resolved context
 *  - existing harness call still runs after admission accepts
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@qm/cordis'
import type {
  BudgetTracker,
  Conversation,
  Harness,
  HarnessRegistry,
  HarnessTurnInput,
  HarnessTurnResult,
  IdentityService,
  OrchestratorDeps,
  Principal,
  RateLimiter,
  ResolutionService,
  SessionStore,
  TurnInput,
} from '@qm/types'
import { OrchestratorService } from '@qm/orchestrator'
import { buildStagePorts } from '@qm/orchestrator'
import { createMemoryAdmissionRecordStore } from '@qm/admission'

const principal: Principal = { id: 'person:ada', type: 'internal' }
const conversation: Conversation = {
  threadRef: 'thread-1',
  kind: 'dm',
  channelName: 'main',
  audience: [principal],
}

function makeTurnInput(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    surface: 'web',
    actor: principal,
    text: 'hello',
    conversation,
    origin: { kind: 'direct' },
    ...overrides,
  }
}

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  const identity: IdentityService = {
    isInternal: () => true,
    audienceIsAllInternal: () => true,
  }
  const rateLimiter: RateLimiter = {
    async check() {
      return { allowed: true, limit: 100, remaining: 99, resetMs: 60_000 }
    },
  }
  const resolution: ResolutionService = {
    async resolve() {
      return { systemPrompt: '', orgScopeId: 'personal:ada' }
    },
    scopeFor: () => 'personal:ada',
  }
  // Partial in-memory SessionStore double: `handleTurn` exercises only
  // the members below; the full interface is satisfied in production.
  const sessions: Partial<SessionStore> = {
    async getOrCreateByThread(threadRef) {
      return {
        id: 'session-A',
        threadRef,
        type: 'dm',
        scopeId: 'personal:ada',
        surface: 'web',
        channelName: 'main',
        createdAt: 0,
      }
    },
    async addParticipant() {
      // no-op for tests
    },
    async acquireLease() {
      return { lease: 'lease-A' as unknown as never }
    },
    async listByParticipant() { return [] },
    async getEntries() { return [] },
    async append() {
      return {
        id: 'entry-1',
        sessionId: 'session-A',
        seq: 1,
        parentSeq: null,
        type: 'user',
        payload: { text: 'hello', author: 'person:ada' },
        scopeLabel: 'personal:ada',
        createdAt: 0,
      }
    },
    async releaseLease() {},
  }
  const harness: HarnessRegistry = {
    resolve(): Harness {
      return {
        profile: {
          id: 'mock',
          controlTransport: 'mock',
          toolTransport: 'mock',
          transcriptFormat: 'json',
          capabilities: new Set(),
        },
        turns: {
          async runTurn(_input: HarnessTurnInput): Promise<HarnessTurnResult> {
            return { reply: 'mock result' }
          },
        },
        models: {},
        tools: { name: (coreName: string) => coreName },
      }
    },
    register() {},
    get() { return undefined },
    ids() { return [] },
  }
  const deps = {
    identity,
    rateLimiter,
    resolution,
    sessions: sessions as SessionStore,
    harness,
    // Apply only explicitly-provided overrides; callers pass the stage
    // double they want to replace (identity, rateLimiter, budget, …).
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
  } as unknown as OrchestratorDeps
  return deps
}

test('orchestrator: identity rejection returns refused and records Admission Record', async () => {
  const store = createMemoryAdmissionRecordStore()
  const deps = makeDeps({
    identity: { isInternal: () => false, audienceIsAllInternal: () => false },
  })
  const svc = new OrchestratorService(new Context(), deps, { admissionRecordStore: store })
  const result = await svc.handleTurn(makeTurnInput())
  assert.equal(result.status, 'refused')
  const records = await store.list()
  assert.equal(records.length, 1)
  assert.equal(records[0]?.decision, 'rejected')
  assert.equal(records[0]?.closingStage, 'identity')
})

test('orchestrator: rate-limit rejection returns refused and records Admission Record', async () => {
  const store = createMemoryAdmissionRecordStore()
  const deps = makeDeps({
    rateLimiter: {
      async check() {
        return { allowed: false, retryAfterMs: 30_000, limit: 100, remaining: 0, resetMs: 30_000 }
      },
    },
  })
  const svc = new OrchestratorService(new Context(), deps, { admissionRecordStore: store })
  const result = await svc.handleTurn(makeTurnInput())
  assert.equal(result.status, 'refused')
  const records = await store.list()
  assert.equal(records.length, 1)
  assert.equal(records[0]?.closingStage, 'rate_limit')
})

test('orchestrator: accepted Turn reaches harness, produces ok, records accepted Admission Record', async () => {
  const store = createMemoryAdmissionRecordStore()
  const deps = makeDeps()
  const svc = new OrchestratorService(new Context(), deps, { admissionRecordStore: store })
  const result = await svc.handleTurn(makeTurnInput())
  assert.equal(result.status, 'ok')
  const records = await store.list()
  assert.equal(records.length, 1)
  assert.equal(records[0]?.decision, 'accepted')
})

test('buildStagePorts: identity port denies non-internal actors', async () => {
  const deps = makeDeps({
    identity: { isInternal: () => false, audienceIsAllInternal: () => false },
  })
  const ports = buildStagePorts({ deps, store: createMemoryAdmissionRecordStore() })
  const decision = await ports.identity.check({ id: 'person:bob', type: 'guest' })
  assert.equal(decision.decision, 'deny')
})

test('buildStagePorts: rateLimit port denies exceeded buckets', async () => {
  const deps = makeDeps({
    rateLimiter: {
      async check() {
        return { allowed: false, retryAfterMs: 30_000, limit: 100, remaining: 0, resetMs: 30_000 }
      },
    },
  })
  const ports = buildStagePorts({ deps, store: createMemoryAdmissionRecordStore() })
  const decision = await ports.rateLimit.check('person:ada')
  assert.equal(decision.decision, 'deny')
})

test('buildStagePorts: budget port is wired when deps.budget is present', async () => {
  const budget: BudgetTracker = {
    async check() {
      return { allowed: false, spentUsd: 10, limitUsd: 5, retryAfterMs: 0 }
    },
    async record() {},
  }
  const deps = makeDeps({ budget })
  const ports = buildStagePorts({ deps, store: createMemoryAdmissionRecordStore() })
  assert.ok(ports.budget)
  const decision = await ports.budget!.check('person:ada')
  assert.equal(decision.decision, 'deny')
})

test('buildStagePorts: screen port is wired when supplied', async () => {
  const deps = makeDeps()
  const ports = buildStagePorts({
    deps,
    store: createMemoryAdmissionRecordStore(),
    screen: {
      async screen() {
        return { mode: 'shadow', decision: 'allow', ts: 0 }
      },
    },
  })
  assert.ok(ports.screen)
  const outcome = await ports.screen!.screen({
    surface: 'web',
    actor: principal,
  })
  assert.equal(outcome.mode, 'shadow')
})