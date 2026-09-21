/**
 * Turn orchestration service.
 *
 * Skeleton translation of qm's handleTurn (src/core/orchestrator.ts:401) with
 * every surface branch and all M3 subsystems stripped: admission (identity,
 * rate limit, budget), session resolution, entry log, harness dispatch and
 * result mapping. Every turn states its surface explicitly; no default
 * surface exists.
 *
 * Phase 3 — Admission Waterfall seam (ADR-0007): handleTurn now delegates
 * the identity / rate-limit / budget / screen / session stages to
 * `runAdmissionWaterfall` from `@qm/admission`. Rejected work produces an
 * Admission Record (never a Run, ADR-0006) and is surfaced as a refused
 * `TurnResult`.
 */
import { Context, Service } from '@qm/cordis'
import type {
  AdmissionInput,
  Orchestrator,
  OrchestratorDeps,
  PendingApproval,
  Session,
  SessionEntry,
  TurnInput,
  TurnResolution,
  TurnResult,
} from '@qm/types'
import { redactSecrets } from '@qm/runs'
import { createMemoryAdmissionRecordStore, runAdmissionWaterfall } from '@qm/admission'
import type { AdmissionRecordStore } from '@qm/admission'
import { buildStagePorts } from './admission-integration.ts'
import { composeFrame, currentTimeBlock } from './frame-composer.ts'

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class OrchestratorService extends Service implements Orchestrator {
  /**
   * Optional explicit admission record store. When omitted, a process-wide
   * memory store is created on first use. Production composition wires a
   * Postgres twin (slice 3.1 follow-up) here.
   */
  private _admissionStore: AdmissionRecordStore | undefined

  constructor(ctx: Context, public deps: OrchestratorDeps, opts?: { admissionRecordStore?: AdmissionRecordStore }) {
    super(ctx, 'orchestrator')
    if (opts?.admissionRecordStore) {
      this._admissionStore = opts.admissionRecordStore
    }
  }

  private admissionStore(): AdmissionRecordStore {
    if (!this._admissionStore) {
      this._admissionStore = createMemoryAdmissionRecordStore()
    }
    return this._admissionStore
  }

  async handleTurn(input: TurnInput): Promise<TurnResult> {
    const { deps } = this
    const store = this.admissionStore()

    // Phase 3 — Admission Waterfall (ADR-0007). The fixed waterfall lives
    // in `@qm/admission`; the orchestrator is the seam that wires ports.
    const admissionInput: AdmissionInput = {
      surface: input.surface,
      actor: input.actor,
      conversation: input.conversation,
    }
    const ports = buildStagePorts({ deps, store })
    const outcome = await runAdmissionWaterfall({ ports, store }, admissionInput)
    if (outcome.decision === 'rejected') {
      return {
        status: 'refused',
        reason: outcome.record.reason ?? `${outcome.record.closingStage ?? 'unknown'} rejected`,
      }
    }
    const { sessionId, scopeId, leaseToken, systemPrompt, orgScopeId, resolution: resolvedResolution } = outcome.resolved
    const resolution: TurnResolution = resolvedResolution ?? { systemPrompt, orgScopeId }
    const conversation = input.conversation
    // Session aggregate for the harness. `ConversationKind` and
    // `SessionType` share the `'dm' | 'channel' | 'group'` domain; the
    // Session is identified by the id the session stage resolved/leased.
    const session: Session = {
      id: sessionId,
      type: conversation.kind,
      scopeId,
      threadRef: conversation.threadRef,
      surface: input.surface,
      createdAt: 0,
      ...(conversation.channelName !== undefined ? { channelName: conversation.channelName } : {}),
    }
    const lease = leaseToken as never

    let harness
    let choiceModel: string | undefined
    try {
      const configured = deps.harness as Partial<
        import('./router.ts').ConfiguredHarnessRegistry
      >
      const choice = configured.resolveChoice?.(conversation.threadRef, scopeId, {
        ...(input.harness ? { harness: input.harness } : {}),
        ...(input.model ? { model: input.model } : {}),
      })
      harness = deps.harness.resolve(choice?.harnessId ?? input.harness)
      choiceModel = choice?.modelId
    } catch (err) {
      return { status: 'refused', reason: errMessage(err) }
    }

    // Phase 7 / KV-006 cutover — the orchestrator produces non-terminal
    // events only, through the typed envelope (seq allocated by the
    // SequenceAllocator inside the bus; ADR-0001 §2.5). Terminal truth is
    // published by the turn runner AFTER the RunStore commits, so this
    // service owns no subscriber notification. Publications are tracked
    // and awaited before the turn returns: observation delivery must be
    // ordered and settled, never racing the Run's completion.
    const events = deps.runEventLog && input.runId ? deps.runEventLog : undefined
    const publishes: Array<Promise<unknown>> = []
    if (events) {
      publishes.push(
        events.publish({ kind: 'attempt.started', runId: input.runId!, sessionId: session.id }).catch(() => undefined),
      )
    }
    try {
      const history = await deps.sessions.getEntries(session.id)
      const userEntry = await deps.sessions.append(lease, {
        type: 'user',
        payload: { text: input.text, author: input.actor.id },
        scopeLabel: scopeId,
      })
      const emitted: SessionEntry[] = []
      const tools = deps.tools
        ? await deps.tools({
            scopeId,
            sessionId: session.id,
            ...(input.runId ? { runId: input.runId } : {}),
            ...(input.runId ? { attempt: input.attempt ?? 1 } : {}),
          })
        : undefined
      // ADR-0018 — compose the protocol frame for this turn: mode selected
      // from turn origin, soul from the resolution, shared core, security
      // policy, and decorator blocks in qm segment order. The memory block
      // (⑭) appends AFTER the recorded cache boundary, never inside the
      // stable prefix.
      const composedSurfaceTools = input.surfaceTools ?? resolution.surfaceTools
      const composed = composeFrame({
        origin: input.origin,
        surface: input.surface,
        conversation,
        actor: input.actor,
        ...(composedSurfaceTools !== undefined ? { surfaceTools: composedSurfaceTools } : {}),
        ...(input.proactiveOpener ? { proactiveOpener: true } : {}),
        soul: systemPrompt,
        resolution,
        ...(input.gatewayContext ? { gatewayContext: input.gatewayContext } : {}),
      })
      // Post-boundary blocks (⑬⑭): the timezone block rides the user's IANA
      // zone; the memory block comes from the resolution decorator. Neither
      // enters the recorded cache boundary.
      const timeBlock = input.timezone ? currentTimeBlock(input.timezone, Date.now()) : ''
      const postBoundary = `${timeBlock ? `\n\n${timeBlock}` : ''}${resolution.memoryBlock ?? ''}`
      const turnSystemPrompt = `${composed.systemPrompt}${postBoundary}`
      const result = await harness.turns.runTurn({
        session,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.cancel ? { cancel: input.cancel } : {}),
        input: input.text,
        ...(input.priorTurns?.length ? { priorTurns: input.priorTurns } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.model || choiceModel ? { model: input.model ?? choiceModel! } : {}),
        ...(input.harness || (harness && choiceModel) ? { harness: harness.profile.id } : {}),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
        ...(input.readOnly ? { readOnly: true } : {}),
        // ADR-0010 continuation executor — a Continuation Attempt
        // carries the approval so the harness resumes the saved
        // command point (by commandRequestId), not a blind replay.
        ...(input.approval ? { approval: input.approval } : {}),
        ...(tools ? { tools } : {}),
        systemPrompt: turnSystemPrompt,
        systemCacheBoundary: composed.stableSystemBytes,
        surfaceTools: composed.mode === 'autonomous',
        history,
        emit: async (entry) => {
          const full = await deps.sessions.append(lease, entry)
          emitted.push(full)
          return full
        },
        scopeLabel: scopeId,
        orgScopeId,
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
              // Deltas surface as typed progress events carrying a
              // producer-side redacted excerpt (ADR-0014 §2); the raw
              // assistant text never enters the durable log. Failures
              // are swallowed: observation must never break the turn.
              onDelta: (text: string) => {
                publishes.push(
                  events
                    .publish({ kind: 'progress', runId: input.runId!, sessionId: session.id, redactedExcerpt: redactSecrets(text) })
                    .catch(() => undefined),
                )
              },
            }
          : {}),
      })
      const sourceAssistantEntrySeq = [...emitted].reverse().find((e) => e.type === 'assistant')?.seq
      let finalResult: TurnResult
      // ADR-0010 continuation executor — a paused turn is a Suspended
      // Attempt, not a finished one: the runner publishes
      // `attempt.suspended` when it suspends the Run, so this service
      // must not claim the Attempt finished here.
      let finalPendingApproval = false
      if (result.pausedOnApproval) {
        finalPendingApproval = true
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
      if (events && !finalPendingApproval) {
        publishes.push(
          events
            .publish({ kind: 'attempt.finished', runId: input.runId!, sessionId: session.id, attemptState: 'succeeded' })
            .catch(() => undefined),
        )
      }
      await Promise.all(publishes)
      return finalResult
    } catch (err) {
      const failed: TurnResult = { status: 'failed', sessionId: session.id, reason: errMessage(err) }
      if (events) {
        publishes.push(
          events
            .publish({ kind: 'attempt.finished', runId: input.runId!, sessionId: session.id, attemptState: 'failed' })
            .catch(() => undefined),
        )
      }
      await Promise.all(publishes)
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
