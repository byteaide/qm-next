/**
 * The M2 convergence bridge: IM inbound events become run-queue turn
 * submissions, and run terminal states become delivery-queue outbound
 * operations. This is the seam qm solves in its surface-specific core
 * client and run-result delivery modules, generalized over the im-core
 * contract.
 *
 * M3 scope notes (12.0):
 * - Approval semantics live in `@qm/approvals`: pending approvals are
 *   recorded durably before the card goes out, clicks run through the
 *   decision state machine (requester-only, double-click dedup), and a
 *   first decision submits the approval-carrying follow-up turn. Without an
 *   injected store the bridge uses an in-memory one, so restart-safe
 *   recovery means configuring the Postgres store.
 * - Card rendering stays provider-side (`OutboundBody.card` is opaque):
 *   each provider exposes its own `approvalCardRenderer`; `approvalCards`
 *   is a global override; providers without a renderer get a neutral text
 *   notice.
 * - Ambient: when ambient ingredients are provided, unaddressed group
 *   chatter (no mention, known `channel` container kind) in a
 *   policy-enabled container is offered to the judge instead of
 *   submitting a human turn; an engaging verdict replies over the same
 *   delivery path. Mentions and DMs always submit human turns.
 *   Unaddressed chatter without a covering ambient policy is dropped —
 *   providers that filter it SDK-side keep identical behavior, and
 *   providers that deliver everything no longer echo every group message.
 * - Refused turns deliver a short notice; qm's run-result delivery drops
 *   refusals. On a chat surface silence reads as breakage, so the bridge
 *   answers.
 */
import {
  APPROVAL_VALUE_KIND,
  createAmbientService,
  createAskExpirySweep,
  createMemoryApprovalStore,
  extractAgentRequests,
  parseAgentRequestValue,
  parseApprovalValue,
  askResolutionInput,
  type AmbientCursorStore,
  type AmbientJudge,
  type AmbientJudgmentStore,
  type AmbientService,
  type AgentRequestActionValue,
  type AgentRequestRecord,
  type AgentRequestStore,
  type ApprovalActionValue,
  type ApprovalCardRenderer,
  type ApprovalStore,
  type AskResolutionGrant,
  type AskSweepKeychain,
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
  KeychainAsk,
  PendingApproval,
  Principal,
  PrincipalType,
  ResolutionService,
  Run,
  RunStore,
  SessionStore,
  TurnInput,
} from '@qm/types'
import { isTerminal } from '@qm/types'

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
 * human turns — ambient replies deliver like any other reply. Cursors,
 * judgment records, and the self identity are optional observability
 * and prompt-context add-ons (14.0).
 */
export interface ImTurnBridgeAmbient {
  policy: ChannelPolicyStore
  judge: AmbientJudge
  cursors?: AmbientCursorStore
  judgments?: AmbientJudgmentStore
  self?: { name?: string; mentionId?: string }
  judgeModel?: string
}

/**
 * Reaction-as-ack ingredients (14.0 tranche 2): while a run is in flight,
 * react to the triggering message after a short delay (qm's ack presenter,
 * non-streaming variant); the reaction is removed when the reply delivers.
 * `pick` is the harness emoji picker; `onPick` records observability.
 */
export interface ImTurnBridgeAck {
  /** Delay before reacting (qm default 2000ms). */
  delayMs?: number
  /** Candidate emoji; qm's DEFAULT_ACK_REACTIONS when absent. */
  candidates?: readonly string[]
  /** Model emoji picker; a random candidate when absent or declined. */
  pick?(text: string, candidates: readonly string[]): Promise<string | undefined>
  /** Observability sink for pick decisions. */
  onPick?(rec: {
    surface: string
    channel: string
    ts: string
    outcome: 'picked' | 'declined'
    picked?: string
    icon?: string
    message?: string
    candidates?: string
    latencyMs?: number
    createdAt: number
  }): void
}

/**
 * Agent-request ingredients (14.0 tranche 3): the durable registry plus
 * the DM resolver for reaching the target person. `resolveDm` maps a
 * provider user to their direct-message destination (directory-backed in
 * production); without it requests stay pending and the bridge warns.
 */
export interface ImTurnBridgeAgentRequests {
  store: AgentRequestStore
  resolveDm?(provider: string, targetUserId: string): Promise<{ destination: Destination; threadId?: string } | null>
  /** Label for the requesting agent in DM cards. */
  originLabel?: string
  /** Label for the target's personal agent in DM cards. */
  targetLabel?(targetUserId: string): string
}

/**
 * Keychain-ask resolution ingredients (14.0 tranche 4): the sweep polls
 * the keychain for resolved-but-unnotified asks and runs each outcome as
 * a personal turn in the requester's DM (qm's keychain-ask flow).
 */
export interface ImTurnBridgeAskResolutions {
  keychain: AskSweepKeychain & { getGrant?(id: string): Promise<AskResolutionGrant | null> }
  /** Sweep cadence in ms (qm's wiring interval; default 30s). */
  sweepMs?: number
  resolveDm?(provider: string, userId: string): Promise<{ destination: Destination } | null>
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
  /**
   * Approval card renderer override applied to every provider. Unset, the
   * bridge resolves each provider's own `approvalCardRenderer` and falls
   * back to a neutral text notice.
   */
  approvalCards?: ApprovalCardRenderer
  /** Ambient ingredients; absent means ambient is fully inert. */
  ambient?: ImTurnBridgeAmbient
  /** Reaction-as-ack; absent means no ack reactions. */
  ack?: ImTurnBridgeAck
  /** Agent-request directives; absent means the grammar stays inert. */
  agentRequests?: ImTurnBridgeAgentRequests
  /** Keychain-ask resolution sweep; absent means asks are never announced. */
  askResolutions?: ImTurnBridgeAskResolutions
  /**
   * Phase 5 intake hook (ADR-0008): invoked after an intake-sourced Turn
   * is enqueued, with the inbound event id and the created Run id. The
   * durable intake subscriber uses it to record the Turn identity on the
   * Intake Record so a redelivery maps to the same Turn.
   */
  onTurnCreated?: (eventId: string, runId: string) => void | Promise<void>
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

/** qm's default ack reaction candidates (provider-neutral names; providers map). */
export const DEFAULT_ACK_REACTIONS = ['eyes', 'mag', 'hourglass_flowing_sand', 'telescope', 'saluting_face'] as const

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

  async function enqueueTurn(input: TurnInput, route: ImReplyRoute, source?: { eventId?: string }): Promise<void> {
    const session = await deps.sessions.getOrCreateByThread(
      input.conversation.threadRef,
      input.conversation.kind,
      deps.resolution.scopeFor(input.conversation, input.actor),
      input.surface,
      input.conversation.channelName,
    )
    const { run } = await deps.runs.enqueue({ sessionId: session.id, request: input })
    if (source?.eventId && options.onTurnCreated) await options.onTurnCreated(source.eventId, run.id)
    rememberRoute(run.id, route)
    scheduleAck(run.id, route, input.text)
    logger.info(`im-bridge: run ${run.id} queued from ${input.surface} session ${session.id}`)
  }

  /**
   * Reaction-as-ack (qm ack presenter, non-streaming): after `delayMs`,
   * if the run is still in flight, react to the triggering message; the
   * reaction is removed when the terminal reply delivers. Providers
   * without `react` capability (or acks with no trigger message ref)
   * never schedule.
   */
  const ackTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const ackApplied = new Map<string, { messageId: string; destination: Destination; emoji: string }>()

  function scheduleAck(runId: string, route: ImReplyRoute, text: string): void {
    const ack = options.ack
    const replyToMessageId = route.replyToMessageId
    if (!ack || !replyToMessageId) return
    const provider = deps.im.get(route.destination.type)
    if (!provider?.capabilities?.().react) return
    const candidates = ack.candidates?.length ? ack.candidates : DEFAULT_ACK_REACTIONS
    const delayMs = ack.delayMs ?? 2_000
    const timer = setTimeout(() => {
      ackTimers.delete(runId)
      void (async () => {
        const run = await deps.runs.get(runId)
        if (!run || isTerminal(run.status)) return
        const startedAt = Date.now()
        const picked = await ack.pick?.(text, candidates).catch(() => undefined)
        const emoji = picked ?? candidates[Math.floor(Math.random() * candidates.length)]!
        ackApplied.set(runId, { messageId: replyToMessageId, destination: route.destination, emoji })
        ack.onPick?.({
          surface: route.destination.type,
          channel: route.destination.target,
          ts: replyToMessageId,
          outcome: picked ? 'picked' : 'declined',
          ...(picked ? { picked } : {}),
          icon: emoji,
          ...(text ? { message: text } : {}),
          candidates: candidates.join(','),
          latencyMs: Date.now() - startedAt,
          createdAt: Date.now(),
        })
        await queue.enqueue({
          provider: route.destination.type,
          op: {
            op: 'react',
            ref: { destination: route.destination, messageId: replyToMessageId },
            emoji,
            action: 'add',
          },
          idempotencyKey: `ack:${runId}`,
        })
      })().catch((err) => logger.error(`im-bridge: ack reaction failed for run ${runId}:`, err))
    }, delayMs)
    timer.unref?.()
    ackTimers.set(runId, timer)
  }

  function settleAck(runId: string): void {
    const timer = ackTimers.get(runId)
    if (timer) {
      clearTimeout(timer)
      ackTimers.delete(runId)
    }
    const applied = ackApplied.get(runId)
    if (!applied) return
    ackApplied.delete(runId)
    void queue
      .enqueue({
        provider: applied.destination.type,
        op: {
          op: 'react',
          ref: { destination: applied.destination, messageId: applied.messageId },
          emoji: applied.emoji,
          action: 'remove',
        },
        idempotencyKey: `ack-remove:${runId}`,
      })
      .catch((err) => logger.error(`im-bridge: ack removal failed for run ${runId}:`, err))
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
    await enqueueTurn(input, route, { eventId: event.eventId })
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
        ...(options.ambient.cursors ? { cursors: options.ambient.cursors } : {}),
        ...(options.ambient.judgments ? { judgments: options.ambient.judgments } : {}),
        ...(options.ambient.self ? { self: options.ambient.self } : {}),
        ...(options.ambient.judgeModel ? { judgeModel: options.ambient.judgeModel } : {}),
        logger,
      })
    : undefined

  /**
   * Addressing policy for one message: mentions and DMs (plus legacy
   * events without a container kind) are human turns; unaddressed group
   * chatter goes to the judge when an ambient policy covers the
   * container and is dropped otherwise — matching the pre-ambient
   * behavior where the provider never delivered such chatter at all.
   */
  async function classifyMessage(event: InboundMessageEvent): Promise<'human' | 'ambient' | 'ignore'> {
    if (event.mentionedBot) return 'human'
    if (event.containerKind !== 'channel') return 'human'
    if (!options.ambient) return 'ignore'
    const container = `${event.provider}:${event.destination.target}`
    const policy = await options.ambient.policy.get(container)
    return policy?.ambientEnabled === true ? 'ambient' : 'ignore'
  }

  async function submitInteraction(event: InboundInteractionEvent): Promise<void> {
    const approvalValue = parseApprovalValue(event.action.value)
    if (approvalValue) {
      await submitApprovalInteraction(event, approvalValue)
      return
    }
    const agentRequestValue = parseAgentRequestValue(event.action.value)
    if (agentRequestValue) {
      await submitAgentRequestInteraction(event, agentRequestValue)
      return
    }
    logger.debug(`im-bridge: interaction ${event.eventId} carries no decision value; ignored`)
  }

  async function submitApprovalInteraction(event: InboundInteractionEvent, value: ApprovalActionValue): Promise<void> {
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
    await enqueueTurn(input, route, { eventId: event.eventId })
  }

  /** qm's personal-agent handoff prompt, provider-neutral. */
  function personalAgentTurnText(record: AgentRequestRecord): string {
    return (
      'An agent handoff: another conversation\'s agent asked your personal agent for help. ' +
      `Task: ${record.task}\n\n` +
      'Work only with this user\'s personal context and return a concise result safe to share ' +
      'back to the originating thread.'
    )
  }

  async function submitAgentRequestInteraction(event: InboundInteractionEvent, value: AgentRequestActionValue): Promise<void> {
    const agentRequests = options.agentRequests
    if (!agentRequests) return
    const actor = principalOf(event.provider, event.actor)
    const decided = await agentRequests.store.decide(value.requestId, {
      approved: value.decision === 'approve',
      decidedBy: actor.id,
    })
    if (decided.outcome === 'not_found') {
      logger.info(`im-bridge: agent request ${value.requestId} not found; click treated as expired`)
      await deliverNotice(event, 'That personal-agent request could not be found — it may have expired.')
      return
    }
    if (decided.outcome === 'forbidden') {
      logger.info(`im-bridge: agent request ${value.requestId} clicked by non-target ${actor.id}; refused`)
      await deliverNotice(event, 'Only the person who was asked can run or decline this request.')
      return
    }
    if (decided.outcome === 'already_decided') {
      logger.info(`im-bridge: agent request ${value.requestId} already decided; duplicate click ignored`)
      return
    }
    const record = decided.record
    if (!decided.approved) {
      await queue.enqueue({
        provider: record.destination.type,
        op: {
          op: 'send',
          destination: record.destination,
          body: { text: `The personal-agent request was declined — \`${record.task.slice(0, 120)}\` was not run.` },
          ...(record.threadId ? { threadId: record.threadId } : {}),
          ...(record.replyToMessageId ? { replyToMessageId: record.replyToMessageId } : {}),
        },
        idempotencyKey: `agent-request-declined:${record.requestId}`,
      })
      return
    }
    const target: Principal = {
      id: `${record.provider}:${record.targetUserId}`,
      type: options.actorType ?? 'internal',
    }
    const conversation: Conversation = {
      kind: 'dm',
      threadRef: `${record.provider}:dm:${record.targetUserId}`,
      audience: [target],
    }
    const originRoute: ImReplyRoute = {
      destination: record.destination,
      ...(record.threadId ? { threadId: record.threadId } : {}),
      ...(record.replyToMessageId ? { replyToMessageId: record.replyToMessageId } : {}),
      conversation,
    }
    await enqueueTurn(
      {
        surface: record.provider,
        actor: target,
        conversation,
        origin: { kind: 'human' },
        text: personalAgentTurnText(record),
      },
      originRoute,
      { eventId: event.eventId },
    )
  }

  async function deliverAgentRequestDm(record: AgentRequestRecord): Promise<void> {
    const agentRequests = options.agentRequests
    if (!agentRequests) return
    const dm = agentRequests.resolveDm
      ? await agentRequests.resolveDm(record.provider, record.targetUserId).catch(() => null)
      : null
    if (!dm) {
      logger.warn(
        `im-bridge: no DM destination for agent-request target ${record.provider}:${record.targetUserId}; request ${record.requestId} stays pending`,
      )
      return
    }
    const provider = deps.im.get(record.provider)
    const renderer = provider?.approvalCardRenderer?.renderAgentRequest
    const originLabel = agentRequests.originLabel ?? 'The channel agent'
    const targetLabel = agentRequests.targetLabel?.(record.targetUserId) ?? `your personal agent (${record.targetUserId})`
    const body = renderer
      ? { card: renderer({ requestId: record.requestId, originLabel, targetLabel, task: record.task }) }
      : {
          text:
            `${originLabel} asks ${targetLabel} to run a personal-scope task: ${record.task} — ` +
            'reply to the requesting thread to approve or decline.',
        }
    await queue.enqueue({
      provider: record.provider,
      op: {
        op: 'send',
        destination: dm.destination,
        body,
        ...(dm.threadId ? { threadId: dm.threadId } : {}),
      },
      idempotencyKey: `agent-request:${record.requestId}`,
    })
  }

  const sink: ImInboundSink = async (events) => {
    for (const event of events) {
      if (event.kind === 'message') {
        const route = await classifyMessage(event)
        if (route === 'ambient' && ambient) {
          void ambient.observe(event)
        } else if (route === 'ignore') {
          logger.debug(`im-bridge: unaddressed chatter ${event.eventId} in ${event.provider}:${event.destination.target}; no ambient policy — dropped`)
        } else {
          await submitMessage(event)
        }
      } else if (event.kind === 'interaction') await submitInteraction(event)
      else logger.debug(`im-bridge: ${event.kind} event ${event.eventId} observed; no bridge action`)
    }
  }

  function deliver(run: Run): void {
    void (async () => {
      settleAck(run.id)
      const route = routes.get(run.id)
      if (!route) return
      if (isPendingApprovalResult(run)) await rememberPendingApprovals(run, route)
      let result = run.result
      if (options.agentRequests && result?.status === 'ok' && result.reply !== undefined) {
        const { text, requests } = extractAgentRequests(result.reply)
        if (requests.length) {
          result = { ...result, reply: text }
          for (const [index, request] of requests.entries()) {
            const record = await options.agentRequests.store.record({
              requestId: `${run.id}:ar${index}`,
              originRunId: run.id,
              originSessionId: run.sessionId,
              provider: route.destination.type,
              targetUserId: request.targetUserId,
              task: request.task,
              requesterId: run.request.actor.id,
              ...(run.request.actor.displayName ? { requesterName: run.request.actor.displayName } : {}),
              destination: route.destination,
              ...(route.threadId ? { threadId: route.threadId } : {}),
              ...(route.replyToMessageId ? { replyToMessageId: route.replyToMessageId } : {}),
              createdAt: Date.now(),
            })
            await deliverAgentRequestDm(record)
          }
        }
      }
      const cards = options.approvalCards ?? deps.im.get(route.destination.type)?.approvalCardRenderer
      const delivery = imRunResultDelivery({ ...run, result }, route, options.replyAs ?? 'markdown', cards)
      if (!delivery) return
      await queue.enqueue(delivery)
    })().catch((err) => {
      logger.error(`im-bridge: failed to enqueue delivery for run ${run.id}:`, err)
    })
  }

  const loop = createDeliveryLoop({ queue, registry: deps.im, ...(options.loop ?? {}) })
  deps.runs.onTerminal(deliver)

  /**
   * qm's keychain-ask flow: each resolved ask becomes a personal turn in
   * the requester's DM carrying the outcome and the resume instruction.
   * With no resolvable DM the ask is marked notified with a warning —
   * re-firing forever would pin the sweep (qm delivered fallback text to
   * the recorded conversation; qm-next asks carry none).
   */
  async function fireAskResolution(ask: KeychainAsk): Promise<void> {
    const askResolutions = options.askResolutions
    if (!askResolutions) return
    const sep = ask.requesterId.indexOf(':')
    const provider = sep > 0 ? ask.requesterId.slice(0, sep) : undefined
    const uid = sep > 0 ? ask.requesterId.slice(sep + 1) : undefined
    const resolved =
      provider && uid && askResolutions.resolveDm
        ? await askResolutions.resolveDm(provider, uid).catch(() => null)
        : null
    const dm = resolved ?? (ask.requesterDestination ? { destination: ask.requesterDestination } : null)
    if (!dm || !provider || !uid) {
      logger.warn(`im-bridge: ask ${ask.id} ${ask.status} but no DM destination for ${ask.requesterId}; marked notified`)
      return
    }
    const grant =
      ask.status === 'approved' && ask.grantId
        ? ((await askResolutions.keychain.getGrant?.(ask.grantId)) ?? undefined)
        : undefined
    const actor: Principal = { id: ask.requesterId, type: options.actorType ?? 'internal' }
    const conversation: Conversation = {
      kind: 'dm',
      threadRef: ask.requesterThreadRef ?? `${provider}:dm:${uid}`,
      audience: [actor],
    }
    await enqueueTurn(
      {
        surface: 'keychain-ask',
        actor,
        conversation,
        origin: { kind: 'automation' },
        text: askResolutionInput(ask, grant),
      },
      { destination: dm.destination, conversation },
    )
  }

  const askSweep = options.askResolutions
    ? createAskExpirySweep({ keychain: options.askResolutions.keychain, fire: fireAskResolution })
    : undefined
  let askSweepTimer: NodeJS.Timeout | undefined

  return {
    queue,
    approvals: approvalStore,
    sink,
    start: () => {
      if (askSweep) {
        const ms = options.askResolutions?.sweepMs ?? 30_000
        askSweepTimer = setInterval(() => {
          void askSweep(Date.now()).catch((err) => logger.error('im-bridge: ask sweep failed:', err))
        }, ms)
        askSweepTimer.unref()
      }
      return loop.start()
    },
    stop: () => {
      for (const timer of ackTimers.values()) clearTimeout(timer)
      ackTimers.clear()
      if (askSweepTimer) {
        clearInterval(askSweepTimer)
        askSweepTimer = undefined
      }
      return loop.stop()
    },
    routeFor: (runId) => routes.get(runId),
  }
}

/**
 * Map a terminal run to its outbound delivery, mirroring qm's
 * `runResultDelivery` over the im-core operation shape. Returns null when
 * nothing should be sent (non-IM run, silent, or ok-without-reply).
 *
 * Approval cards resolve provider-side: the injected `approvalCards`
 * override wins, then the provider's own `approvalCardRenderer`, then a
 * neutral text notice (no buttons — decisions stay possible via the
 * requesting surface, and both shipping providers carry renderers).
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
    body = cards
      ? { card: cards.render({ runId: run.id, sessionId: result.sessionId ?? '', approvals: result.pendingApprovals ?? [] }) }
      : { text: approvalRequestNotice(result.pendingApprovals ?? []) }
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
 * Built-in neutral fallback for providers without a card renderer: an
 * actionable-text notice carrying the request context (no buttons, no
 * platform-native markup — the bridge stays provider-neutral by contract).
 */
export function approvalRequestNotice(approvals: readonly PendingApproval[]): string {
  const primary = approvals[0]
  const command = primary?.command ?? 'turn'
  const reason = primary?.reason ?? 'requires approval'
  const detail = approvals.length > 1 ? ` (+${approvals.length - 1} more)` : ''
  return `Approval needed before I can run \`${command}\` — ${reason}${detail}`
}
