/**
 * Phase 4 — Trigger Runtime implementation.
 *
 * ADR-0003: API supplies the implementation during composition; Triggers
 * depend only on the minimal `TriggerRuntime` contract. This file is the
 * factory that builds the runtime from API's existing primitives
 * (RunStore, SessionStore).
 *
 * Linked plan: `docs/implementation-plan.md` §Phase 4.
 */
import type {
  Conversation,
  Principal,
  ResolutionService,
  RunStore,
  SessionStore,
  TurnInput,
  TurnOrigin,
} from '@qm/types'
import type {
  TriggerHealth,
  TriggerIdentity,
  TriggerRuntime,
  TriggerSubmitInput,
  TriggerSubmitResult,
} from '@qm/types'
import {
  RUN_METRICS,
  bumpTriggerSubmit,
  type RunMetricsRegistry,
} from '@qm/runs'

export interface TriggerRuntimeImplOptions {
  /** Stable instance id (per deployment). */
  instanceId?: string
  /** Runtime version (semver). */
  version?: string
  /** Trigger kinds this runtime accepts. Phase 5 will refine the list. */
  supportedTriggers?: readonly string[]
  /** Optional metrics registry; defaults to the @qm/runs default-registry. */
  metrics?: RunMetricsRegistry
}

export interface TriggerRuntimeDeps {
  runs: RunStore
  sessions: SessionStore
  resolution: ResolutionService
}

export interface TriggerRuntimeImpl extends TriggerRuntime {
  readonly instanceId: string
  readonly version: string
  readonly supportedTriggers: readonly string[]
}

const DEFAULT_VERSION = '0.1.0'
const DEFAULT_SUPPORTED: readonly string[] = ['cron', 'webhook', 'manual', 'automation']

export function createTriggerRuntimeFromApi(
  deps: TriggerRuntimeDeps,
  opts: TriggerRuntimeImplOptions = {},
): TriggerRuntimeImpl {
  const instanceId = opts.instanceId ?? `api-${process.pid}`
  const version = opts.version ?? DEFAULT_VERSION
  const supportedTriggers = opts.supportedTriggers ?? DEFAULT_SUPPORTED

  return {
    instanceId,
    version,
    supportedTriggers,
    identity(): TriggerIdentity {
      return { instanceId, version, supportedTriggers }
    },
    async health(): Promise<TriggerHealth> {
      return { ok: true }
    },
    async submit(input: TriggerSubmitInput): Promise<TriggerSubmitResult> {
      const acceptedAt = Date.now()
      try {
        if (!supportedTriggers.includes(input.triggerKind)) {
          bumpTriggerSubmit(opts.metrics, 'rejected')
          throw new TriggerRuntimeError(
            `unsupported trigger kind: ${input.triggerKind}`,
            'unsupported_trigger_kind',
          )
        }
        const conversation: Conversation = {
          threadRef: `trigger:${input.fireKey}`,
          kind: 'web',
          channelName: input.triggerKind,
          participants: [input.actor],
        }
        const session = await deps.sessions.getOrCreateByThread(
          conversation.threadRef,
          conversation.kind,
          input.scopeId,
          input.triggerKind,
          conversation.channelName,
        )
        await deps.sessions.addParticipant(session.id, input.actor.id)
        const resolution = await deps.resolution.resolve(conversation, input.actor)
        const origin: TurnOrigin = { kind: 'automation' }
        const turnInput: TurnInput = {
          surface: input.triggerKind,
          actor: input.actor,
          conversation,
          origin,
          text: input.text,
          ...(input.harness !== undefined ? { harness: input.harness } : {}),
        }
        void resolution
        const enqueue = await deps.runs.enqueue({
          request: turnInput,
          ...(input.fireKey !== undefined ? { idempotencyKey: input.fireKey } : {}),
        } as Parameters<RunStore['enqueue']>[0])
        bumpTriggerSubmit(opts.metrics, 'accepted')
        return {
          runId: enqueue.id,
          sessionId: session.id,
          acceptedAt,
        }
      } catch (err) {
        bumpTriggerSubmit(opts.metrics, 'rejected')
        if (err instanceof TriggerRuntimeError) throw err
        throw new TriggerRuntimeError(
          err instanceof Error ? err.message : String(err),
          'submit_failed',
        )
      }
    },
  }
}

export class TriggerRuntimeError extends Error {
  constructor(
    message: string,
    /** Stable error code surfaced to Triggers. */
    public readonly code:
      | 'unsupported_trigger_kind'
      | 'session_resolution_failed'
      | 'enqueue_failed'
      | 'submit_failed',
  ) {
    super(message)
    this.name = 'TriggerRuntimeError'
  }
}

// Suppress unused-import false positives for re-exports that downstream
// consumers depend on (kept in the type layer even when not used here).
export type {
  TriggerHealth,
  TriggerIdentity,
  TriggerRuntime,
  TriggerSubmitInput,
  TriggerSubmitResult,
}
export { RUN_METRICS }