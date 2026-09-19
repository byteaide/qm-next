/**
 * Phase 3 — Turn Admission Waterfall.
 *
 * Implements the fixed waterfall from `docs/implementation-plan.md` §3.1:
 *   1. identity
 *   2. rate_limit
 *   3. budget
 *   4. screen
 *   5. session (resolution and Session lease)
 *   6. dispatch
 *
 * ADR-0007 forbids reordering. On any reject, the waterfall short-circuits
 * and returns a RejectedAdmission — no Run is created (ADR-0006). The
 * orchestrator must treat rejection as a closed outcome and never fall
 * back to the harness.
 *
 * The waterfall accepts narrow ports (`StagePorts`) so deployments can
 * swap identity, rate-limit, budget, screen, resolution, lease, and
 * dispatch implementations without changing the orchestrator.
 */
import type {
  AdmissionInput,
  AdmissionRecord,
  AdmissionStage,
  AdmissionStageRecord,
} from '@qm/types'
import { _resetDefaultRunMetricsRegistryForTests as _reset } from '@qm/runs'
import {
  allocateAdmissionRecordId,
  type AdmissionRecordStore,
} from './admission-record-store.ts'
import {
  redactAdmissionReason,
  redactAdmissionStageReason,
} from './redaction.ts'
import {
  WATERFALL_ORDER,
  type AcceptedAdmission,
  type RejectedAdmission,
  type StagePorts,
  type WaterfallOptions,
  type WaterfallOutcome,
} from './types.ts'

export interface WaterfallDeps {
  ports: StagePorts
  store: AdmissionRecordStore
  options?: WaterfallOptions
}

interface StageHistory {
  records: AdmissionStageRecord[]
  closingStage?: AdmissionStage
  context: {
    rateLimit?: { limit: number; remaining: number; resetMs: number }
    budget?: { remaining: number; unit: string }
  }
}

const defaultNow: () => number = Date.now

export async function runAdmissionWaterfall(
  deps: WaterfallDeps,
  input: AdmissionInput,
): Promise<WaterfallOutcome> {
  const now = deps.options?.now ?? defaultNow
  const metrics = deps.options?.metrics
  const history: StageHistory = { records: [], context: {} }
  const id = allocateAdmissionRecordId()
  const ts = now()

  // Stage 1: identity
  const identityStart = now()
  const identityDecision = await deps.ports.identity.check(input.actor)
  history.records.push({
    stage: 'identity',
    decision: identityDecision.decision,
    reason: redactAdmissionStageReason(identityDecision.reason),
    latencyMs: now() - identityStart,
  })
  bumpStageMetric(metrics, 'identity', identityDecision.decision)
  if (identityDecision.decision !== 'allow') {
    return reject(id, input, history, identityDecision.reason, ts, now, deps)
  }

  // Stage 2: rate_limit
  const rlStart = now()
  const rlDecision = await deps.ports.rateLimit.check(input.actor.id)
  history.records.push({
    stage: 'rate_limit',
    decision: rlDecision.decision,
    reason: redactAdmissionStageReason(rlDecision.reason),
    latencyMs: now() - rlStart,
  })
  bumpStageMetric(metrics, 'rate_limit', rlDecision.decision)
  if (rlDecision.decision !== 'allow') {
    if (rlDecision.limit !== undefined && rlDecision.remaining !== undefined && rlDecision.resetMs !== undefined) {
      history.context.rateLimit = {
        limit: rlDecision.limit,
        remaining: rlDecision.remaining,
        resetMs: rlDecision.resetMs,
      }
    }
    return reject(id, input, history, rlDecision.reason, ts, now, deps)
  }
  if (rlDecision.limit !== undefined && rlDecision.remaining !== undefined && rlDecision.resetMs !== undefined) {
    history.context.rateLimit = {
      limit: rlDecision.limit,
      remaining: rlDecision.remaining,
      resetMs: rlDecision.resetMs,
    }
  }

  // Stage 3: budget (optional)
  if (deps.ports.budget) {
    const bStart = now()
    const bDecision = await deps.ports.budget.check(input.actor.id)
    history.records.push({
      stage: 'budget',
      decision: bDecision.decision,
      reason: redactAdmissionStageReason(bDecision.reason),
      latencyMs: now() - bStart,
    })
    bumpStageMetric(metrics, 'budget', bDecision.decision)
    if (bDecision.decision !== 'allow') {
      if (bDecision.remaining !== undefined && bDecision.unit !== undefined) {
        history.context.budget = {
          remaining: bDecision.remaining,
          unit: bDecision.unit,
        }
      }
      return reject(id, input, history, bDecision.reason, ts, now, deps)
    }
    if (bDecision.remaining !== undefined && bDecision.unit !== undefined) {
      history.context.budget = {
        remaining: bDecision.remaining,
        unit: bDecision.unit,
      }
    }
  } else {
    history.records.push({
      stage: 'budget',
      decision: 'skipped',
      reason: 'budget stage not configured',
      latencyMs: 0,
    })
    bumpStageMetric(metrics, 'budget', 'skipped')
  }

  // Stage 4: screen (optional)
  let screenOutcome: import('@qm/types').SecurityScreenOutcome | undefined
  if (deps.ports.screen) {
    const sStart = now()
    screenOutcome = await deps.ports.screen.screen(input)
    history.records.push({
      stage: 'screen',
      decision: screenOutcome.decision === 'allow' ? 'allow' : 'deny',
      reason: redactAdmissionStageReason(screenOutcome.reason),
      latencyMs: now() - sStart,
    })
    bumpScreenDecisionMetric(metrics, screenOutcome.mode, screenOutcome.decision)
    if (screenOutcome.mode === 'enforce' && screenOutcome.decision !== 'allow') {
      bumpScreenUnavailableMetric(metrics, 'enforce')
      return reject(id, input, history, `security screen denied: ${screenOutcome.reason ?? 'unspecified'}`, ts, now, deps, screenOutcome)
    }
    if (screenOutcome.mode === 'shadow' && screenOutcome.decision === 'unavailable') {
      bumpScreenUnavailableMetric(metrics, 'shadow')
    }
  } else {
    history.records.push({
      stage: 'screen',
      decision: 'skipped',
      reason: 'screen stage not configured',
      latencyMs: 0,
    })
    bumpStageMetric(metrics, 'screen', 'skipped')
  }

  // Stage 5: session (resolution + lease)
  const sStart = now()
  const sessionDecision = await deps.ports.session.resolveAndLease(input)
  history.records.push({
    stage: 'session',
    decision: sessionDecision.decision,
    reason: redactAdmissionStageReason(sessionDecision.reason),
    latencyMs: now() - sStart,
  })
  bumpStageMetric(metrics, 'session', sessionDecision.decision)
  if (sessionDecision.decision !== 'allow') {
    return reject(id, input, history, sessionDecision.reason, ts, now, deps, screenOutcome)
  }

  // Stage 6: dispatch
  const dStart = now()
  const dispatchDecision = await deps.ports.dispatch.prepare(input, {
    sessionId: sessionDecision.sessionId,
    scopeId: sessionDecision.scopeId,
  })
  history.records.push({
    stage: 'dispatch',
    decision: dispatchDecision.decision,
    reason: redactAdmissionStageReason(dispatchDecision.reason),
    latencyMs: now() - dStart,
  })
  bumpStageMetric(metrics, 'dispatch', dispatchDecision.decision)
  if (dispatchDecision.decision !== 'allow') {
    return reject(id, input, history, dispatchDecision.reason, ts, now, deps, screenOutcome)
  }

  // Accepted
  const commandRequest = input.commandRequest ?? {
    id: `cmd-${id}`,
    runId: `run-${id}`,
    attemptId: `attempt-${id}`,
    class: 'read',
    args: { argv: [] },
    context: { scopeId: sessionDecision.scopeId, principalId: input.actor.id, surface: input.surface },
    ts: ts,
  } as import('@qm/types').CommandRequest

  const record: AdmissionRecord = {
    id,
    surface: input.surface,
    actor: input.actor,
    ...(input.scopeId !== undefined ? { scopeId: input.scopeId } : { scopeId: sessionDecision.scopeId }),
    decision: 'accepted',
    stages: history.records.slice(),
    ...(screenOutcome !== undefined ? { screen: screenOutcome } : {}),
    ...(Object.keys(history.context).length > 0 ? { context: history.context } : {}),
    ts,
  }
  await deps.store.create(record)
  bumpRecordMetric(metrics, 'accepted')

  return {
    decision: 'accepted',
    record,
    commandRequest,
    resolved: {
      sessionId: sessionDecision.sessionId,
      scopeId: sessionDecision.scopeId,
      leaseToken: sessionDecision.leaseToken,
      systemPrompt: sessionDecision.systemPrompt,
      orgScopeId: sessionDecision.orgScopeId,
      commandRequest,
      ...(history.context.rateLimit !== undefined ? { rateLimit: history.context.rateLimit } : {}),
      ...(history.context.budget !== undefined ? { budget: history.context.budget } : {}),
      ...(screenOutcome !== undefined ? { screen: screenOutcome } : {}),
    },
  } satisfies AcceptedAdmission
}

async function reject(
  id: string,
  input: AdmissionInput,
  history: StageHistory,
  reason: string | undefined,
  ts: number,
  now: () => number,
  deps: WaterfallDeps,
  screenOutcome?: import('@qm/types').SecurityScreenOutcome,
): Promise<RejectedAdmission> {
  // closing stage = the last non-allow stage
  let closingStage: AdmissionStage | undefined
  for (let i = history.records.length - 1; i >= 0; i -= 1) {
    if (history.records[i]!.decision !== 'allow') {
      closingStage = history.records[i]!.stage
      break
    }
  }
  const record: AdmissionRecord = {
    id,
    surface: input.surface,
    actor: input.actor,
    ...(input.scopeId !== undefined ? { scopeId: input.scopeId } : {}),
    decision: 'rejected',
    ...(closingStage !== undefined ? { closingStage } : {}),
    stages: history.records.slice(),
    ...(screenOutcome !== undefined ? { screen: screenOutcome } : {}),
    ...(Object.keys(history.context).length > 0 ? { context: history.context } : {}),
    ...(reason !== undefined ? { reason: redactAdmissionReason(reason) } : {}),
    ts,
  }
  await deps.store.create(record)
  bumpRecordMetric(deps.options?.metrics, 'rejected')
  return { decision: 'rejected', record }
}

function bumpStageMetric(
  metrics: WaterfallOptions['metrics'] | undefined,
  stage: AdmissionStage,
  decision: 'allow' | 'deny' | 'error' | 'skipped',
): void {
  if (!metrics) return
  // Lazy import keeps the seam decoupled from `@qm/runs` in tests.
  // Phase 3.3 wires the real counters via `bumpAdmissionDecision`.
  metrics.inc('admission_decision_total', { stage, decision })
}

function bumpScreenDecisionMetric(
  metrics: WaterfallOptions['metrics'] | undefined,
  mode: 'off' | 'shadow' | 'enforce',
  decision: 'allow' | 'deny' | 'unavailable',
): void {
  if (!metrics) return
  metrics.inc('security_screen_decision_total', { mode, decision })
}

function bumpScreenUnavailableMetric(
  metrics: WaterfallOptions['metrics'] | undefined,
  mode: 'shadow' | 'enforce',
): void {
  if (!metrics) return
  metrics.inc('security_screen_unavailable_total', { mode })
}

function bumpRecordMetric(
  metrics: WaterfallOptions['metrics'] | undefined,
  outcome: 'accepted' | 'rejected',
): void {
  if (!metrics) return
  metrics.inc('admission_record_total', { outcome })
}

// Re-export for tests (clear default-registry between cases).
export const __reset = _reset