/**
 * The M2 convergence bridge: IM inbound events become run-queue turn
 * submissions, and run terminal states become delivery-queue outbound
 * operations. This is the seam qm solves in `src/api/slack-core-client.ts`
 * and `src/delivery/run-result-delivery.ts`, generalized over the im-core
 * contract.
 *
 * M2 scope notes:
 * - Reply routes (runId → destination/thread) are in-memory; they follow the
 *   memory-store dev path and move durable in M3 alongside the Postgres queue.
 * - The pending-approval card is a minimal placeholder until
 *   `packages/approvals` (12.0) owns approval semantics and rendering.
 * - Refused turns deliver a short notice; qm's run-result delivery drops
 *   refusals. On a chat surface silence reads as breakage, so the bridge
 *   answers.
 */
import type {
  ImDeliveryEnqueueInput,
  ImDeliveryQueue,
  ImInboundSink,
  ImLogger,
  ImRegistryLike,
  InboundInteractionEvent,
  InboundMessageEvent,
  OutboundBody,
} from '@qm/im-core'
import { createDeliveryLoop, createMemoryDeliveryQueue } from '@qm/im-core/runtime'
import type {
  Conversation,
  Destination,
  PendingApproval,
  Principal,
  PrincipalType,
  ResolutionService,
  Run,
  RunStore,
  SessionStore,
  TurnInput,
} from '@qm/types'

export const APPROVAL_VALUE_KIND = 'qm.approval.v1'

/** Value round-tripped through the approval card buttons. */
export interface ApprovalActionValue {
  kind: typeof APPROVAL_VALUE_KIND
  runId: string
  sessionId: string
  requestId: string
  command: string
  decision: 'approve' | 'reject'
}

/** Where replies for a run go, captured from the inbound event. */
export interface ImReplyRoute {
  destination: Destination
  threadId?: string
  replyToMessageId?: string
  conversation: Conversation
}

export interface ImTurnBridgeLoopOptions {
  tickMs?: number
  claimTtlMs?: number
  maxPerClaim?: number
  maxAttempts?: number
  backoffMs?: number
}

export interface ImTurnBridgeOptions {
  /** Principal type assigned to IM actors (directory mapping is M3). */
  actorType?: PrincipalType
  /** Reply body shape; markdown rides the provider format pipeline. */
  replyAs?: 'markdown' | 'text'
  /** Retained reply routes before the oldest are dropped. */
  maxRoutes?: number
  loop?: ImTurnBridgeLoopOptions
}

export interface ImTurnBridgeDeps {
  runs: RunStore
  sessions: SessionStore
  resolution: ResolutionService
  im: ImRegistryLike
  queue?: ImDeliveryQueue
  logger?: ImLogger
}

export interface ImTurnBridge {
  readonly queue: ImDeliveryQueue
  sink: ImInboundSink
  start(): Promise<void>
  stop(): Promise<void>
  routeFor(runId: string): ImReplyRoute | undefined
}

const DEFAULT_MAX_ROUTES = 2000

export function createImTurnBridge(deps: ImTurnBridgeDeps, options: ImTurnBridgeOptions = {}): ImTurnBridge {
  const logger: ImLogger = deps.logger ?? console
  const queue = deps.queue ?? createMemoryDeliveryQueue()
  const routes = new Map<string, ImReplyRoute>()
  const maxRoutes = options.maxRoutes ?? DEFAULT_MAX_ROUTES

  function rememberRoute(runId: string, route: ImReplyRoute): void {
    routes.set(runId, route)
    if (routes.size <= maxRoutes) return
    for (const key of routes.keys()) {
      routes.delete(key)
      if (routes.size <= maxRoutes) break
    }
  }

  function principalOf(provider: string, actor: InboundMessageEvent['actor']): Principal {
    return {
      id: `${provider}:${actor.providerUserId}`,
      type: options.actorType ?? 'internal',
      ...(actor.displayName ? { displayName: actor.displayName } : {}),
    }
  }

  function conversationOf(destination: Destination, actor: Principal, threadId?: string): Conversation {
    const threadRef = `${destination.type}:${destination.target}${threadId ? `:${threadId}` : ''}`
    return { kind: 'channel', threadRef, audience: [actor] }
  }

  async function enqueueTurn(input: TurnInput, route: ImReplyRoute): Promise<void> {
    const session = await deps.sessions.getOrCreateByThread(
      input.conversation.threadRef,
      input.conversation.kind,
      deps.resolution.scopeFor(input.conversation, input.actor),
      input.surface,
      input.conversation.channelName,
    )
    const { run } = await deps.runs.enqueue({ sessionId: session.id, request: input })
    rememberRoute(run.id, route)
    logger.info(`im-bridge: run ${run.id} queued from ${input.surface} session ${session.id}`)
  }

  async function submitMessage(event: InboundMessageEvent): Promise<void> {
    const actor = principalOf(event.provider, event.actor)
    const conversation = conversationOf(event.destination, actor, event.threadId)
    const input: TurnInput = {
      surface: event.provider,
      actor,
      conversation,
      origin: { kind: 'human' },
      text: event.text,
      ...(event.attachments?.length ? { attachments: event.attachments } : {}),
    }
    const route: ImReplyRoute = {
      destination: event.destination,
      ...(event.threadId ? { threadId: event.threadId } : {}),
      ...(event.replyToMessageId ? { replyToMessageId: event.replyToMessageId } : {}),
      conversation,
    }
    await enqueueTurn(input, route)
  }

  async function submitInteraction(event: InboundInteractionEvent): Promise<void> {
    const value = parseApprovalValue(event.action.value)
    if (!value) {
      logger.debug(`im-bridge: interaction ${event.eventId} carries no approval value; ignored`)
      return
    }
    const approved = value.decision === 'approve'
    const actor = principalOf(event.provider, event.actor)
    const prior = routes.get(value.runId)
    const conversation = prior?.conversation ?? conversationOf(event.ref.destination, actor)
    const input: TurnInput = {
      surface: event.provider,
      actor,
      conversation,
      origin: { kind: 'human' },
      text: `${approved ? 'Approve' : 'Reject'}: ${value.command}`,
      approval: { requestId: value.requestId, approved },
    }
    const route: ImReplyRoute = prior ?? {
      destination: event.ref.destination,
      replyToMessageId: event.ref.messageId,
      conversation,
    }
    await enqueueTurn(input, route)
  }

  const sink: ImInboundSink = async (events) => {
    for (const event of events) {
      if (event.kind === 'message') await submitMessage(event)
      else if (event.kind === 'interaction') await submitInteraction(event)
      else logger.debug(`im-bridge: ${event.kind} event ${event.eventId} observed; no M2 action`)
    }
  }

  function deliver(run: Run): void {
    void (async () => {
      const route = routes.get(run.id)
      if (!route) return
      const delivery = imRunResultDelivery(run, route, options.replyAs ?? 'markdown')
      if (!delivery) return
      await queue.enqueue(delivery)
    })().catch((err) => {
      logger.error(`im-bridge: failed to enqueue delivery for run ${run.id}:`, err)
    })
  }

  const loop = createDeliveryLoop({ queue, registry: deps.im, ...(options.loop ?? {}) })
  deps.runs.onTerminal(deliver)

  return {
    queue,
    sink,
    start: () => loop.start(),
    stop: () => loop.stop(),
    routeFor: (runId) => routes.get(runId),
  }
}

/**
 * Map a terminal run to its outbound delivery, mirroring qm's
 * `runResultDelivery` over the im-core operation shape. Returns null when
 * nothing should be sent (non-IM run, silent, or ok-without-reply).
 */
export function imRunResultDelivery(
  run: Run,
  route: ImReplyRoute,
  replyAs: 'markdown' | 'text' = 'markdown',
): ImDeliveryEnqueueInput | null {
  const result = run.result
  let body: OutboundBody | undefined
  if (run.status === 'failed' || result?.status === 'failed') {
    body = { text: `⚠️ I couldn't finish that turn: ${result?.reason ?? 'unknown error'}` }
  } else if (result?.status === 'pending_approval' || (result?.status === 'ok' && result.pendingApprovals?.length)) {
    body = { card: approvalRequestCard(run.id, result.sessionId ?? '', result.pendingApprovals ?? []) }
  } else if (result?.status === 'ok' && result.reply !== undefined) {
    body = replyAs === 'text' ? { text: result.reply } : { markdown: result.reply }
  } else if (result?.status === 'refused') {
    body = { text: `⚠️ ${result.reason ?? 'turn refused'}` }
  }
  if (!body) return null
  const op = {
    op: 'send',
    destination: route.destination,
    body,
    ...(route.threadId ? { threadId: route.threadId } : {}),
    ...(route.replyToMessageId ? { replyToMessageId: route.replyToMessageId } : {}),
  } as const
  return { provider: route.destination.type, op, idempotencyKey: `run:${run.id}`, origin: { runId: run.id } }
}

/**
 * Minimal interactive approval card. Provider-native payloads are opaque by
 * contract; this Feishu-shaped placeholder exists so the M2 smoke can click
 * an approval end to end. `packages/approvals` (12.0) replaces it.
 */
export function approvalRequestCard(
  runId: string,
  sessionId: string,
  approvals: readonly PendingApproval[],
): Record<string, unknown> {
  const primary = approvals[0]
  const command = primary?.command ?? 'turn'
  const reason = primary?.reason ?? ''
  const detail = approvals.length > 1 ? ` (+${approvals.length - 1} more)` : ''
  const value = (decision: ApprovalActionValue['decision']): ApprovalActionValue => ({
    kind: APPROVAL_VALUE_KIND,
    runId,
    sessionId,
    ...(primary ? { requestId: primary.requestId } : { requestId: '' }),
    command,
    decision,
  })
  return {
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: 'Approval needed' }, template: 'orange' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**${command}** — ${reason}${detail}` } },
      {
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: 'Approve' }, type: 'primary', value: value('approve') },
          { tag: 'button', text: { tag: 'plain_text', content: 'Reject' }, type: 'danger', value: value('reject') },
        ],
      },
    ],
  }
}

export function parseApprovalValue(value: unknown): ApprovalActionValue | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  if (candidate.kind !== APPROVAL_VALUE_KIND) return null
  if (typeof candidate.runId !== 'string' || !candidate.runId) return null
  if (typeof candidate.requestId !== 'string') return null
  if (typeof candidate.command !== 'string') return null
  if (candidate.decision !== 'approve' && candidate.decision !== 'reject') return null
  return {
    kind: APPROVAL_VALUE_KIND,
    runId: candidate.runId,
    sessionId: typeof candidate.sessionId === 'string' ? candidate.sessionId : '',
    requestId: candidate.requestId,
    command: candidate.command,
    decision: candidate.decision,
  }
}
