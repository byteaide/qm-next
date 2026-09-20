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
  LegacyRunDeltaEvent,
  LegacyRunEvent,
  LegacyRunEventDraft,
  LegacyRunProgressEvent,
  Session,
  SessionEntry,
  TurnInput,
  TurnResult,
} from '@qm/types'
import { createMemoryAdmissionRecordStore, runAdmissionWaterfall } from '@qm/admission'
import type { AdmissionRecordStore } from '@qm/admission'
import { buildStagePorts } from './admission-integration.ts'

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
    const { sessionId, scopeId, leaseToken, systemPrompt, orgScopeId } = outcome.resolved
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

    const events = deps.runEvents && input.runId ? deps.runEvents : undefined
    let seq = 0
    const publish = (event: LegacyRunEventDraft): void => {
      events?.publish({ ...event, runId: input.runId!, sessionId: session.id, seq } as LegacyRunEvent)
      seq += 1
    }
    if (events) publish({ kind: 'status', status: 'running' })
    try {
      const history = await deps.sessions.getEntries(session.id)
      const userEntry = await deps.sessions.append(lease, {
        type: 'user',
        payload: { text: input.text, author: input.actor.id },
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
        ...(input.model || choiceModel ? { model: input.model ?? choiceModel! } : {}),
        ...(input.harness || (harness && choiceModel) ? { harness: harness.profile.id } : {}),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
        ...(input.readOnly ? { readOnly: true } : {}),
        ...(tools ? { tools } : {}),
        systemPrompt,
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
              onDelta: (text: string) => publish({ kind: 'delta', text } satisfies Omit<LegacyRunDeltaEvent, 'runId' | 'sessionId' | 'seq'>),
              onProgress: (p: { toolCalls: number }) => publish({ kind: 'progress', toolCalls: p.toolCalls } satisfies Omit<LegacyRunProgressEvent, 'runId' | 'sessionId' | 'seq'>),
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
