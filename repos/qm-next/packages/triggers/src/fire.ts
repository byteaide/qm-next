/**
 * The fire engine: turns one keyed fire into one run-queue submission and
 * one terminal outcome. Cron fires render the standing-task preamble;
 * trigger fires submit their event text as-is. Terminal runs record their
 * fire-log entry and — when the fire carries a destination and the reply
 * is deliverable — enqueue the reply on the IM delivery queue, gated on
 * the frozen DirectoryStore visibility when one is configured.
 */
import { isVisible, type DirectoryStore } from '@qm/directory'
import type { DeliveryOrigin, ImDeliveryQueue, ImLogger } from '@qm/im-core'
import type { Conversation, Destination, Principal, PrincipalType, ResolutionService, Run, RunStore, ScopeId, SessionStore, TurnInput } from '@qm/types'
import type { CronFireLogEntry, TriggerSubmission } from './contract.ts'
import { hashId, truncate } from './util.ts'

export const FIRE_REPLY_MAX_CHARS = 2000

/** Deps shared by the cron scheduler and the trigger sink. */
export interface FireEngineDeps {
  sessions: SessionStore
  runs: RunStore
  resolution: ResolutionService
  deliveries?: ImDeliveryQueue
  directory?: DirectoryStore
  replyAs?: 'markdown' | 'text'
  logger?: ImLogger
}

export interface SubmitSpec {
  surface: string
  fireKey: string
  text: string
  ownerId: string
  ownerType?: PrincipalType
  scopeId?: ScopeId
  destination?: Destination
  title?: string
  /** Cron record id, carried onto delivery origin for audit. */
  cronId?: string
  firedAt: number
  scheduledAt?: number
  /** Called once when the enqueued run reaches a terminal state. */
  onTerminal?: (entry: CronFireLogEntry) => Promise<void>
}

export interface FireEngine {
  submit(spec: SubmitSpec): Promise<TriggerSubmission>
}

const CRON_CONTEXT_MARKERS = ['[Cron runtime context]', '[End cron runtime context]']

/**
 * The standing task every fire receives, wrapped in the runtime context
 * that states the fresh-thread contract. `!run`/`!scratch` tasks pass
 * through verbatim.
 */
export function renderCronFireInput(task: string, cronId: string, title?: string): string {
  if (!task.trim()) return task
  if (/^!(run|scratch)\s/.test(task.trimStart())) return task
  return [
    '[Cron runtime context]',
    `Cron id: ${cronId}${title ? ` (${title})` : ''}.`,
    'Each fire runs as a fresh thread with no memory of previous fires. Two things persist between fires:',
    '- Your workspace disk. Durable state — notes, queues, checkpoints, anything a future fire should know — lives in files there.',
    '- The stored task below: the standing instructions every fire receives.',
    `The retained fire log (id="${cronId}") shows how prior fires went — useful when this run hits errors or surprising state.`,
    '[End cron runtime context]',
    '',
    'Stored cron task:',
    task,
  ].join('\n')
}

/** Fire-log reply form: context echoes collapse, long replies truncate. */
export function fireLogReply(reply: string): string {
  if (CRON_CONTEXT_MARKERS.some((marker) => reply.includes(marker))) return '[reply echoed cron runtime context; omitted]'
  return truncate(reply, FIRE_REPLY_MAX_CHARS)
}

export function actorOf(spec: Pick<SubmitSpec, 'ownerId' | 'ownerType'>): Principal {
  return { id: spec.ownerId, type: spec.ownerType ?? 'internal' }
}

/** Every fire lands in a fresh thread: the ref derives from the fire key. */
export function fireThreadRef(spec: Pick<SubmitSpec, 'surface' | 'fireKey'>): string {
  return `${spec.surface}:${hashId([spec.fireKey], 12)}`
}

export function conversationOf(spec: SubmitSpec, actor: Principal, threadRef: string): Conversation {
  if (spec.destination) {
    return { kind: 'channel', threadRef, channelRef: spec.destination.target, audience: [actor] }
  }
  return { kind: 'dm', threadRef, audience: [actor] }
}

/**
 * Visibility gate over the frozen DirectoryStore: when the owner's
 * provider matches the destination, the destination space must exist in
 * the directory and be visible to the owner (public non-external channel,
 * or membership). Unknown provider/space fails open — a roster sync gap
 * must not silently drop deliveries.
 */
export async function destinationVisibleToOwner(
  directory: DirectoryStore,
  ownerId: string,
  destination: Destination,
): Promise<boolean> {
  const sep = ownerId.indexOf(':')
  if (sep <= 0) return true
  const provider = ownerId.slice(0, sep)
  if (destination.type !== provider) return true
  const space = await directory.getSpace(provider, destination.target).catch(() => null)
  if (!space) return true
  return isVisible(directory, provider, ownerId.slice(sep + 1), space)
}

export function createFireEngine(deps: FireEngineDeps): FireEngine {
  const logger: ImLogger = deps.logger ?? console
  const routes = new Map<string, SubmitSpec>()

  async function deliver(run: Run, spec: SubmitSpec, reply: string): Promise<void> {
    if (!deps.deliveries || !spec.destination) return
    const origin: DeliveryOrigin = { runId: run.id, ...(spec.cronId ? { trigger: spec.cronId } : { trigger: spec.fireKey }) }
    await deps.deliveries.enqueue({
      provider: spec.destination.type,
      op: {
        op: 'send',
        destination: spec.destination,
        body: deps.replyAs === 'text' ? { text: reply } : { markdown: reply },
      },
      idempotencyKey: `cron-fire:${spec.fireKey}`,
      origin,
    })
  }

  deps.runs.onTerminal((run) => {
    const spec = routes.get(run.id)
    if (!spec) return
    routes.delete(run.id)
    void (async () => {
      const result = run.result
      const status = result?.status ?? (run.status === 'failed' ? 'failed' : undefined)
      const pendingApprovals = result?.pendingApprovals ?? []
      const suppressDelivery = status === 'pending_approval' || pendingApprovals.length > 0
      let reply: string | undefined
      let note: string | undefined
      if (suppressDelivery) {
        note = 'hit a require_approval command — no human at fire time; delivery skipped'
      } else if (result?.status === 'ok') {
        if (typeof result.reply === 'string' && result.reply.trim()) reply = result.reply
        else note = 'produced no reply'
      } else if (result?.status === 'refused') {
        note = result.reason ? `refused: ${result.reason}` : 'refused'
      } else if (result?.status === 'failed') {
        note = result.reason ? `failed: ${result.reason}` : 'failed'
      }
      if (reply !== undefined && spec.destination && deps.directory) {
        const visible = await destinationVisibleToOwner(deps.directory, spec.ownerId, spec.destination)
        if (!visible) {
          reply = undefined
          note = 'destination is no longer visible to the cron owner — delivery skipped'
        }
      }
      const entry: CronFireLogEntry = {
        fireKey: spec.fireKey,
        firedAt: run.finishedAt ?? Date.now(),
        ...(spec.scheduledAt !== undefined ? { scheduledAt: spec.scheduledAt } : {}),
        ...(status ? { status } : {}),
        ...(note ? { note } : {}),
        ...(reply !== undefined ? { reply: fireLogReply(reply) } : {}),
        runId: run.id,
        ...(result?.sessionId ? { sessionId: result.sessionId } : {}),
      }
      await spec.onTerminal?.(entry)
      if (reply !== undefined) await deliver(run, spec, reply)
    })().catch((err) => {
      logger.error(`triggers: fire ${spec.fireKey} terminal handling failed:`, err)
    })
  })

  return {
    async submit(spec: SubmitSpec): Promise<TriggerSubmission> {
      const actor = actorOf(spec)
      const threadRef = fireThreadRef(spec)
      const conversation = conversationOf(spec, actor, threadRef)
      const input: TurnInput = {
        surface: spec.surface,
        actor,
        conversation,
        origin: { kind: 'automation', ...(spec.destination ? { destination: spec.destination } : {}) },
        text: spec.text,
        background: true,
      }
      const scope = spec.scopeId ?? deps.resolution.scopeFor(conversation, actor)
      const session = await deps.sessions.getOrCreateByThread(
        threadRef,
        conversation.kind,
        scope,
        spec.surface,
        spec.destination?.target,
      )
      const { run, deduped } = await deps.runs.enqueue({ sessionId: session.id, request: input, dedupKey: spec.fireKey })
      routes.set(run.id, spec)
      if (deduped) logger.debug(`triggers: fire ${spec.fireKey} deduped onto run ${run.id}`)
      return { runId: run.id, deduped }
    },
  }
}
