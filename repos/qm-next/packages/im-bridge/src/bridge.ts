/**
 * The M2 convergence bridge: IM inbound events become run-queue turn
 * submissions, and run terminal states become delivery-queue outbound
 * operations. This is the seam qm solves in `src/api/slack-core-client.ts`
 * and `src/delivery/run-result-delivery.ts`, generalized over the im-core
 * contract.
 *
 * M3 scope notes (12.0):
 * - Approval semantics live in `@qm/approvals`: pending approvals are
 *   recorded durably before the card goes out, clicks run through the
 *   decision state machine (requester-only, double-click dedup), and a
 *   first decision submits the approval-carrying follow-up turn. Without an
 *   injected store the bridge uses an in-memory one, so restart-safe
 *   recovery means configuring the Postgres store.
 * - Card rendering stays provider-side (`OutboundBody.card` is opaque);
 *   `approvalCards` swaps the built-in default renderer.
 * - Ambient: when ambient ingredients are provided, unaddressed group
 *   chatter (no mention, known `channel` container kind) in a
 *   policy-enabled container is offered to the judge instead of submitting
 *   a human turn; an engaging verdict replies over the same delivery
 *   path. Mentions and DMs always submit human turns. Without the
 *   ingredients every message submits a human turn (M2 behavior).
 * - Refused turns deliver a short notice; qm's run-result delivery drops
 *   refusals. On a chat surface silence reads as breakage, so the bridge
 *   answers.
 */
import {
  APPROVAL_VALUE_KIND,
  createAmbientService,
  createMemoryApprovalStore,
  parseApprovalValue,
  type AmbientJudge,
  type AmbientService,
  type ApprovalActionValue,
  type ApprovalCardRenderer,
  type ApprovalStore,
  type ChannelPolicyStore,
} from '@qm/approvals'
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

export { APPROVAL_VALUE_KIND, parseApprovalValue }
export type { ApprovalActionValue }

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

/**
 * Ambient ingredients: the container policy plus the engagement judge.
 * The bridge builds the `AmbientService` internally so the ambient
 * submit seam enqueues through the same route-recording turn path as
 * human turns — ambient replies deliver like any other reply.
 */
export interface ImTurnBridgeAmbient {
  policy: ChannelPolicyStore
  judge: AmbientJudge
}

export interface ImTurnBridgeOptions {
  /** Principal type assigned to IM actors (directory mapping is M3). */
  actorType?: PrincipalType
  /** Reply body shape; markdown rides the provider format pipeline. */
  replyAs?: 'markdown' | 'text'
  /** Retained reply routes before the oldest are dropped. */
  maxRoutes?: number
  /** Durable approval registry; defaults to an in-memory store. */
  approvalStore?: ApprovalStore
  /** Approval card renderer; defaults to the built-in Feishu-shaped card. */
  approvalCards?: ApprovalCardRenderer
  /** Ambient ingredients; absent means ambient is fully inert. */
  ambient?: ImTurnBridgeAmbient
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
  /** The approval registry this bridge records pending approvals into. */
  readonly approvals: ApprovalStore
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
  const approvalStore = options.approvalStore ?? createMemoryApprovalStore()

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

  async function deliverNotice(event: InboundInteractionEvent, text: string): Promise<void> {
    await queue.enqueue({
      provider: event.ref.destination.type,
      op: {
        op: 'send',
        destination: event.ref.destination,
        body: { text },
        ...(event.ref.destination.threadId ? { threadId: event.ref.destination.threadId } : {}),
        replyToMessageId: event.ref.messageId,
      },
      idempotencyKey: `approval-click:${event.eventId}`,
    })
  }

  async function rememberPendingApprovals(run: Run, route: ImReplyRoute): Promise<void> {
    const pending = run.result?.pendingApprovals ?? []
    for (const approval of pending) {
      await approvalStore.record({
        requestId: approval.requestId,
        runId: run.id,
        sessionId: run.sessionId,
        command: approval.command,
        reason: approval.reason,
        ...(approval.kind ? { kind: approval.kind } : {}),
        requester: run.request.actor,
        destination: route.destination,
        ...(route.threadId ? { threadId: route.threadId } : {}),
      })
    }
  }

  /**
   * Ambient service built from the injected ingredients. Constructed
   * after `enqueueTurn` is in scope so ambient submissions ride the same
   * turn + route-recording path; never throws to the inbound loop.
   */
  const ambient: AmbientService | undefined = options.ambient
    ? createAmbientService({
        policy: options.ambient.policy,
        judge: options.ambient.judge,
        submit: (input, route) => enqueueTurn(input, route),
        ...(options.actorType ? { actorType: options.actorType } : {}),
        logger,
      })
    : undefined

  /**
   * True when this message is unaddressed group chatter covered by an
   * enabled ambient policy: no mention, known `channel` container kind,
   * and the container policy on. Those messages go to the judge instead
   * of submitting a human turn; mentions, DMs and legacy events without
   * a container kind always take the human path. Callers pass an ambient
   * service in — false without one.
   */
  async function isAmbientOnly(event: InboundMessageEvent): Promise<boolean> {
    if (!options.ambient) return false
    if (event.mentionedBot) return false
    if (event.containerKind !== 'channel') return false
    const container = `${event.provider}:${event.destination.target}`
    const policy = await options.ambient.policy.get(container)
    return policy?.ambientEnabled === true
  }

  async function submitInteraction(event: InboundInteractionEvent): Promise<void> {
    const value = parseApprovalValue(event.action.value)
    if (!value) {
      logger.debug(`im-bridge: interaction ${event.eventId} carries no approval value; ignored`)
      return
    }
    const actor = principalOf(event.provider, event.actor)
    const decided = await approvalStore.decide(value.requestId, {
      approved: value.decision === 'approve',
      decidedBy: actor.id,
    })
    if (decided.outcome === 'not_found') {
      logger.info(`im-bridge: approval ${value.requestId} not found; click treated as expired`)
      await deliverNotice(event, 'That approval request could not be found — it may have expired.')
      return
    }
    if (decided.outcome === 'forbidden') {
      logger.info(`im-bridge: approval ${value.requestId} clicked by non-requester ${actor.id}; refused`)
      await deliverNotice(event, 'Only the person who requested this command can approve or deny it.')
      return
    }
    if (decided.outcome === 'already_decided') {
      logger.info(`im-bridge: approval ${value.requestId} already decided; duplicate click ignored`)
      return
    }
    const approved = decided.approved
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
      if (event.kind === 'message') {
        if (ambient && (await isAmbientOnly(event))) {
          void ambient.observe(event)
          continue
        }
        await submitMessage(event)
      } else if (event.kind === 'interaction') await submitInteraction(event)
      else logger.debug(`im-bridge: ${event.kind} event ${event.eventId} observed; no bridge action`)
    }
  }

  function deliver(run: Run): void {
    void (async () => {
      const route = routes.get(run.id)
      if (!route) return
      if (isPendingApprovalResult(run)) await rememberPendingApprovals(run, route)
      const delivery = imRunResultDelivery(run, route, options.replyAs ?? 'markdown', options.approvalCards)
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
    approvals: approvalStore,
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
  cards?: ApprovalCardRenderer,
): ImDeliveryEnqueueInput | null {
  const result = run.result
  let body: OutboundBody | undefined
  if (run.status === 'failed' || result?.status === 'failed') {
    body = { text: `⚠️ I couldn't finish that turn: ${result?.reason ?? 'unknown error'}` }
  } else if (result?.status === 'pending_approval' || (result?.status === 'ok' && result.pendingApprovals?.length)) {
    body = {
      card: cards
        ? cards.render({ runId: run.id, sessionId: result.sessionId ?? '', approvals: result.pendingApprovals ?? [] })
        : approvalRequestCard(run.id, result.sessionId ?? '', result.pendingApprovals ?? []),
    }
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

/** True when the run's result carries approvals still waiting on a human. */
export function isPendingApprovalResult(run: Run): boolean {
  const result = run.result
  return result?.status === 'pending_approval' || (result?.status === 'ok' && !!result.pendingApprovals?.length)
}

/**
 * Built-in interactive approval card. Provider-native payloads are opaque
 * by contract; this Feishu-shaped default covers the M2/M3 smoke path and
 * is swapped per provider via the `ApprovalCardRenderer` port.
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

/** `ApprovalCardRenderer` adapter over the built-in card. */
export const defaultApprovalCardRenderer: ApprovalCardRenderer = {
  render: ({ runId, sessionId, approvals }) => approvalRequestCard(runId, sessionId, approvals),
}
