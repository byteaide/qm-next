/**
 * Phase 3 — Orchestrator ↔ Admission integration.
 *
 * Bridges the existing `OrchestratorDeps` bag into the narrow stage ports
 * the Admission Waterfall consumes (ADR-0007). Rejection is surfaced as a
 * `TurnResult` with `status: 'refused'`; the orchestrator never falls
 * through to the harness on rejection (ADR-0006).
 *
 * The screen port is supplied by the slice 3.2 Security Screen Adapter
 * when present. When absent, the waterfall treats `screen` as `skipped`.
 */
import type {
  AdmissionInput,
  Principal,
  ScopeId,
} from '@qm/types'
import type { OrchestratorDeps } from '@qm/types'
import { type StagePorts } from '@qm/admission'
import type { AdmissionRecordStore } from '@qm/admission'

export interface BuildStagePortsOptions {
  deps: OrchestratorDeps
  store: AdmissionRecordStore
  /** Optional Security Screen port from slice 3.2; absent in slice 3.1. */
  screen?: StagePorts['screen']
}

export function buildStagePorts(opts: BuildStagePortsOptions): StagePorts {
  const { deps, screen } = opts
  const ports: StagePorts = {
    identity: {
      async check(actor: Principal) {
        const start = Date.now()
        const ok = deps.identity.isInternal(actor)
        return {
          decision: ok ? 'allow' : 'deny',
          ...(ok ? {} : { reason: 'internal-only: non-internal principals cannot interact' }),
          latencyMs: Date.now() - start,
        }
      },
    },
    rateLimit: {
      async check(actorId: string) {
        const start = Date.now()
        const rl = await deps.rateLimiter.check(actorId)
        if (rl.allowed) {
          return {
            decision: 'allow',
            latencyMs: Date.now() - start,
            ...(rl.limit !== undefined ? { limit: rl.limit } : {}),
            ...(rl.remaining !== undefined ? { remaining: rl.remaining } : {}),
            ...(rl.resetMs !== undefined ? { resetMs: rl.resetMs } : {}),
          }
        }
        return {
          decision: 'deny',
          reason: `rate limit exceeded — try again in ${Math.ceil((rl.retryAfterMs ?? 0) / 1000)}s`,
          latencyMs: Date.now() - start,
        }
      },
    },
    ...(deps.budget !== undefined
      ? {
          budget: {
            async check(actorId: string) {
              const start = Date.now()
              const b = await deps.budget!.check(actorId)
              if (b.allowed) {
                return {
                  decision: 'allow',
                  latencyMs: Date.now() - start,
                  ...(b.remaining !== undefined ? { remaining: b.remaining } : {}),
                  ...(b.unit !== undefined ? { unit: b.unit } : {}),
                }
              }
              return {
                decision: 'deny',
                reason: `budget exceeded ($${b.spentUsd.toFixed(2)} of $${b.limitUsd}); try again later`,
                latencyMs: Date.now() - start,
              }
            },
          },
        }
      : {}),
    session: {
      async resolveAndLease(input: AdmissionInput) {
        const start = Date.now()
        const conversation = input.conversation
        if (!conversation) {
          return { decision: 'deny', reason: 'missing conversation context for session resolution', latencyMs: Date.now() - start }
        }
        const resolution = await deps.resolution.resolve(conversation, input.actor)
        const scopeId: ScopeId = deps.resolution.scopeFor(conversation, input.actor)
        const session = await deps.sessions.getOrCreateByThread(
          conversation.threadRef,
          conversation.kind,
          scopeId,
          input.surface,
          conversation.channelName,
        )
        await deps.sessions.addParticipant(session.id, input.actor.id)
        const leaseAttempt = await deps.sessions.acquireLease(session.id, 'turn')
        if (!leaseAttempt.lease) {
          return { decision: 'deny', reason: 'another turn is active for this session', latencyMs: Date.now() - start }
        }
        return {
          decision: 'allow',
          sessionId: session.id,
          scopeId,
          leaseToken: leaseAttempt.lease,
          systemPrompt: resolution.systemPrompt,
          orgScopeId: resolution.orgScopeId,
          latencyMs: Date.now() - start,
        }
      },
    },
    dispatch: {
      async prepare() {
        // The orchestrator handles harness dispatch; the Admission
        // dispatch stage is a final authorization gate that returns
        // allow by default. Slice 3.2 may layer rate-limit-on-dispatch
        // here without touching the orchestrator.
        return { decision: 'allow', latencyMs: 0 }
      },
    },
    ...(screen !== undefined ? { screen } : {}),
  }
  return ports
}