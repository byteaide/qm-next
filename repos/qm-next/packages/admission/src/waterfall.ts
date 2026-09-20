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
  AdmissionStageDecision,
  AdmissionStageRecord,
} from '@qm/types'
import {
  _resetDefaultRunMetricsRegistryForTests as _reset,
  bumpAdmissionDecision,
  bumpAdmissionRecord,
  bumpSecurityScreenDecision,
  bumpSecurityScreenUnavailable,
} from '@qm/runs'
import {
  allocateAdmissionRecordId,
  type AdmissionRecordStore,
} from './admission-record-store.ts'
import {
  redactAdmissionReason,
  redactAdmissionStageReason,
} from './redaction.ts'
import {
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

/**
 * Build one AdmissionStageRecord. `reason` is omitted (not set to
 * `undefined`) when absent — `exactOptionalPropertyTypes` forbids an
 * explicit `undefined` on an optional property.
 */
function stageRecord(
  stage: AdmissionStage,
  decision: AdmissionStageDecision,
  reason: string | undefined,
  latencyMs: number,
): AdmissionStageRecord {
  return {
    stage,
    decision,
    ...(reason !== undefined ? { reason: redactAdmissionStageReason(reason) } : {}),
    latencyMs,
  }
}

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
  history.records.push(stageRecord('identity', identityDecision.decision, identityDecision.reason, now() - identityStart))
  bumpStageMetric(metrics, 'identity', identityDecision.decision)
  if (identityDecision.decision !== 'allow') {
    return reject(id, input, history, identityDecision.reason, ts, deps)
  }

  // Stage 2: rate_limit
  const rlStart = now()
  const rlDecision = await deps.ports.rateLimit.check(input.actor.id)
  history.records.push(stageRecord('rate_limit', rlDecision.decision, rlDecision.reason, now() - rlStart))
  bumpStageMetric(metrics, 'rate_limit', rlDecision.decision)
  if (rlDecision.decision !== 'allow') {
    if (rlDecision.limit !== undefined && rlDecision.remaining !== undefined && rlDecision.resetMs !== undefined) {
      history.context.rateLimit = {
        limit: rlDecision.limit,
        remaining: rlDecision.remaining,
        resetMs: rlDecision.resetMs,
      }
    }
    return reject(id, input, history, rlDecision.reason, ts, deps)
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
    history.records.push(stageRecord('budget', bDecision.decision, bDecision.reason, now() - bStart))
    bumpStageMetric(metrics, 'budget', bDecision.decision)
    if (bDecision.decision !== 'allow') {
      if (bDecision.remaining !== undefined && bDecision.unit !== undefined) {
        history.context.budget = {
          remaining: bDecision.remaining,
          unit: bDecision.unit,
        }
      }
      return reject(id, input, history, bDecision.reason, ts, deps)
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
    history.records.push(
      stageRecord('screen', screenOutcome.decision === 'allow' ? 'allow' : 'deny', screenOutcome.reason, now() - sStart),
    )
    bumpStageMetric(metrics, 'screen', screenOutcome.decision === 'allow' ? 'allow' : 'deny')
    bumpScreenDecisionMetric(metrics, screenOutcome.mode, screenOutcome.decision)
    if (screenOutcome.mode === 'enforce' && screenOutcome.decision !== 'allow') {
      return reject(id, input, history, `security screen denied: ${screenOutcome.reason ?? 'unspecified'}`, ts, deps, screenOutcome)
    }
    if (screenOutcome.mode === 'shadow' && screenOutcome.decision === 'unavailable') {
      bumpScreenUnavailableMetric(metrics, 'shadow')
    }
    if (screenOutcome.mode === 'enforce' && screenOutcome.decision === 'unavailable') {
      // Plan §3.3: Shadow mode records unavailability; Enforce mode does
      // not. The waterfall rejects the Turn, and the rejection is
      // surfaced as `admission_decision_total{stage="screen",decision="deny"}`
      // — the unavailable counter is reserved for the Shadow path.
      // (No-op here, deliberately.)
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
  const sessionReason: string | undefined = sessionDecision.decision === 'allow' ? undefined : sessionDecision.reason
  history.records.push(stageRecord('session', sessionDecision.decision, sessionReason, now() - sStart))
  bumpStageMetric(metrics, 'session', sessionDecision.decision)
  if (sessionDecision.decision !== 'allow') {
    return reject(id, input, history, sessionDecision.reason, ts, deps, screenOutcome)
  }

  // Stage 6: dispatch
  const dStart = now()
  const dispatchDecision = await deps.ports.dispatch.prepare(input, {
    sessionId: sessionDecision.sessionId,
    scopeId: sessionDecision.scopeId,
  })
  const dispatchReason: string | undefined = dispatchDecision.decision === 'allow' ? undefined : dispatchDecision.reason
  history.records.push(stageRecord('dispatch', dispatchDecision.decision, dispatchReason, now() - dStart))
  bumpStageMetric(metrics, 'dispatch', dispatchDecision.decision)
  if (dispatchDecision.decision !== 'allow') {
    return reject(id, input, history, dispatchDecision.reason, ts, deps, screenOutcome)
  }

  // Accepted. `commandRequest` stays absent for non-side-effecting work
  // (ADR-0002: pure, non-sensitive reads are not gated) — no synthetic
  // placeholder is fabricated.
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
    ...(input.commandRequest !== undefined ? { commandRequest: input.commandRequest } : {}),
    resolved: {
      sessionId: sessionDecision.sessionId,
      scopeId: sessionDecision.scopeId,
      leaseToken: sessionDecision.leaseToken,
      systemPrompt: sessionDecision.systemPrompt,
      orgScopeId: sessionDecision.orgScopeId,
      ...(input.commandRequest !== undefined ? { commandRequest: input.commandRequest } : {}),
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
  bumpAdmissionDecision(metrics, stage, decision)
}

function bumpScreenDecisionMetric(
  metrics: WaterfallOptions['metrics'] | undefined,
  mode: 'off' | 'shadow' | 'enforce',
  decision: 'allow' | 'deny' | 'unavailable',
): void {
  bumpSecurityScreenDecision(metrics, mode, decision)
}

function bumpScreenUnavailableMetric(
  metrics: WaterfallOptions['metrics'] | undefined,
  mode: 'shadow' | 'enforce',
): void {
  bumpSecurityScreenUnavailable(metrics, mode)
}

function bumpRecordMetric(
  metrics: WaterfallOptions['metrics'] | undefined,
  outcome: 'accepted' | 'rejected',
): void {
  bumpAdmissionRecord(metrics, outcome)
}

// Re-export for tests (clear default-registry between cases).
export const __reset = _reset