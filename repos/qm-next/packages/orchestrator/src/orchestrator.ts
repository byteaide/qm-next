/**
 * Turn orchestration service.
 *
 * Skeleton translation of qm's handleTurn (src/core/orchestrator.ts:401) with
 * every surface branch and all M3 subsystems stripped: admission (identity,
 * rate limit, budget), session resolution, entry log, harness dispatch and
 * result mapping. Every turn states its surface explicitly; no default
 * surface exists.
 */
import { Context, Service } from '@qm/cordis'
import type {
  Conversation,
  Orchestrator,
  OrchestratorDeps,
  PendingApproval,
  RunDeltaEvent,
  RunEvent,
  RunEventDraft,
  RunProgressEvent,
  SessionEntry,
  TurnInput,
  TurnResult,
} from '@qm/types'

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sessionTypeOf(conversation: Conversation): Conversation['kind'] {
  return conversation.kind
}

export class OrchestratorService extends Service implements Orchestrator {
  constructor(ctx: Context, public deps: OrchestratorDeps) {
    super(ctx, 'orchestrator')
  }

  async handleTurn(input: TurnInput): Promise<TurnResult> {
    const { deps } = this
    const { actor, conversation } = input
    if (!deps.identity.isInternal(actor)) {
      return { status: 'refused', reason: 'internal-only: non-internal principals cannot interact' }
    }
    const rl = await deps.rateLimiter.check(actor.id)
    if (!rl.allowed) {
      return {
        status: 'refused',
        reason: `rate limit exceeded — try again in ${Math.ceil((rl.retryAfterMs ?? 0) / 1000)}s`,
      }
    }
    if (deps.budget) {
      const b = await deps.budget.check(actor.id)
      if (!b.allowed) {
        return {
          status: 'refused',
          reason: `budget exceeded ($${b.spentUsd.toFixed(2)} of $${b.limitUsd}); try again later`,
        }
      }
    }
    const resolution = await deps.resolution.resolve(conversation, actor)
    const scopeId = deps.resolution.scopeFor(conversation, actor)
    let harness
    try {
      harness = deps.harness.resolve(input.harness)
    } catch (err) {
      return { status: 'refused', reason: errMessage(err) }
    }
    const session = await deps.sessions.getOrCreateByThread(
      conversation.threadRef,
      sessionTypeOf(conversation),
      scopeId,
      input.surface,
      conversation.channelName,
    )
    const leaseAttempt = await deps.sessions.acquireLease(session.id, 'turn')
    if (!leaseAttempt.lease) {
      return { status: 'refused', reason: 'another turn is active for this session' }
    }
    const lease = leaseAttempt.lease
    const events = deps.runEvents && input.runId ? deps.runEvents : undefined
    let seq = 0
    const publish = (event: RunEventDraft): void => {
      events?.publish({ ...event, runId: input.runId!, sessionId: session.id, seq } as RunEvent)
      seq += 1
    }
    if (events) publish({ kind: 'status', status: 'running' })
    try {
      const history = await deps.sessions.getEntries(session.id)
      const userEntry = await deps.sessions.append(lease, {
        type: 'user',
        payload: { text: input.text, author: actor.id },
        scopeLabel: scopeId,
      })
      const emitted: SessionEntry[] = []
      const tools = deps.tools ? await deps.tools({ scopeId, sessionId: session.id }) : undefined
      const result = await harness.turns.runTurn({
        session,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.cancel ? { cancel: input.cancel } : {}),
        input: input.text,
        ...(input.priorTurns?.length ? { priorTurns: input.priorTurns } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.harness ? { harness: input.harness } : {}),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
        ...(input.readOnly ? { readOnly: true } : {}),
        ...(tools ? { tools } : {}),
        systemPrompt: resolution.systemPrompt,
        history,
        emit: async (entry) => {
          const full = await deps.sessions.append(lease, entry)
          emitted.push(full)
          return full
        },
        scopeLabel: scopeId,
        orgScopeId: resolution.orgScopeId,
        recordModelCall: (rec) => {
          deps.modelGateway?.recordCall({
            at: Date.now(),
            scopeLabel: scopeId,
            model: rec.model,
            inputTokens: rec.inputTokens,
            entryCount: rec.entryCount,
          })
        },
        ...(events
          ? {
              onDelta: (text: string) => publish({ kind: 'delta', text } satisfies Omit<RunDeltaEvent, 'runId' | 'sessionId' | 'seq'>),
              onProgress: (p: { toolCalls: number }) => publish({ kind: 'progress', toolCalls: p.toolCalls } satisfies Omit<RunProgressEvent, 'runId' | 'sessionId' | 'seq'>),
            }
          : {}),
      })
      const sourceAssistantEntrySeq = [...emitted].reverse().find((e) => e.type === 'assistant')?.seq
      let finalResult: TurnResult
      if (result.pausedOnApproval) {
        const approvals: PendingApproval[] = (result.pendingApprovals ?? []).map((pa) => ({
          requestId: `${session.id}:${pa.command}`,
          command: pa.command,
          reason: pa.reason,
          ...(pa.kind ? { kind: 'approval' as const } : {}),
        }))
        finalResult = { status: 'pending_approval', sessionId: session.id, pendingApprovals: approvals }
      } else if (result.pendingApprovals?.length) {
        finalResult = { status: 'ok', sessionId: session.id, reply: result.reply, pendingApprovals: result.pendingApprovals.map((pa) => ({
          requestId: `${session.id}:${pa.command}`,
          command: pa.command,
          reason: pa.reason,
          ...(pa.kind ? { kind: 'approval' as const } : {}),
        })) }
      } else if (result.silent) {
        finalResult = { status: 'silent', sessionId: session.id, ...(result.stopped ? { stopped: true } : {}) }
      } else {
        finalResult = {
          status: 'ok',
          sessionId: session.id,
          reply: result.reply,
          ...(result.stopped ? { stopped: true } : {}),
          sourceUserSeq: userEntry.seq,
          ...(sourceAssistantEntrySeq !== undefined ? { sourceAssistantEntrySeq } : {}),
        }
      }
      if (events) {
        publish({ kind: 'status', status: finalResult.status })
        events.close(input.runId!)
      }
      return finalResult
    } catch (err) {
      const failed: TurnResult = { status: 'failed', sessionId: session.id, reason: errMessage(err) }
      if (events) {
        publish({ kind: 'status', status: 'failed' })
        events.close(input.runId!)
      }
      return failed
    } finally {
      await deps.sessions.releaseLease(lease)
    }
  }
}

export default OrchestratorService

declare module '@qm/cordis' {
  interface Context {
    orchestrator: OrchestratorService
  }
}
