/**
 * Ambient minimal-slice implementation: the service wiring policy + judge
 * + turn submission behind `AmbientService`. The judge itself is a port —
 * qm's judge model plugs in later; the no-op default keeps ambient inert.
 */
import type { InboundMessageEvent, ImLogger } from '@qm/im-core'
import type { Conversation, Principal, TurnInput } from '@qm/types'
import type {
  AmbientJudge,
  AmbientRoute,
  AmbientService,
  AmbientServiceOptions,
  ChannelPolicy,
  ChannelPolicyStore,
} from './contract.ts'

/**
 * Ambient minimal slice: for non-mention, non-bot messages consult the
 * container policy (default off → zero behavior change), then the judge;
 * an engaging verdict submits one turn with `origin: { kind: 'ambient' }`.
 */
export function createAmbientService(options: AmbientServiceOptions): AmbientService {
  const logger: ImLogger = options.logger ?? console
  async function observe(event: InboundMessageEvent): Promise<void> {
    if (event.mentionedBot) return
    if (event.actor.isBot) return
    const container = `${event.provider}:${event.destination.target}`
    const policy = await options.policy.get(container)
    if (!policy?.ambientEnabled) return
    const verdict = await options.judge.consider({
      provider: event.provider,
      destination: event.destination,
      ...(event.threadId !== undefined ? { threadId: event.threadId } : {}),
      actor: event.actor,
      text: event.text,
      occurredAt: event.occurredAt,
    })
    if (!verdict.engage) {
      logger.debug(`approvals: ambient judge declined container ${container}`)
      return
    }
    const actor: Principal = {
      id: `${event.provider}:${event.actor.providerUserId}`,
      type: options.actorType ?? 'internal',
      ...(event.actor.displayName ? { displayName: event.actor.displayName } : {}),
    }
    const threadRef = `${event.destination.type}:${event.destination.target}${event.threadId ? `:${event.threadId}` : ''}`
    const conversation: Conversation = { kind: 'channel', threadRef, audience: [actor] }
    const input: TurnInput = {
      surface: event.provider,
      actor,
      conversation,
      origin: { kind: 'ambient' },
      text: verdict.text ?? event.text,
    }
    const route: AmbientRoute = {
      destination: event.destination,
      ...(event.threadId !== undefined ? { threadId: event.threadId } : {}),
      conversation,
    }
    await options.submit(input, route)
  }
  return {
    observe: (event) =>
      observe(event).catch((err) => {
        logger.error(`approvals: ambient observe failed for event ${event.eventId}:`, err)
      }),
  }
}

/** In-memory channel policies; absent entries mean ambient disabled. */
export function createMemoryChannelPolicyStore(): ChannelPolicyStore {
  const policies = new Map<string, ChannelPolicy>()
  return {
    async get(container) {
      return policies.get(container) ?? null
    },
    async setAmbient(container, enabled) {
      const policy: ChannelPolicy = { container, ambientEnabled: enabled, updatedAt: Date.now() }
      policies.set(container, policy)
      return policy
    },
    async close() {},
  }
}

/**
 * Deterministic stub judge for smokes and the real-device e2e: engages
 * when the overheard text contains `keyword` (case-insensitive); the
 * literal `*` engages everything. The verdict text is the observed
 * message verbatim — the turn pipeline answers overheard chatter with
 * whatever the harness/model makes of the original text. qm's model
 * judge replaces this stub when it lands.
 */
export function createKeywordAmbientJudge(keyword: string): AmbientJudge {
  const needle = keyword.trim().toLowerCase()
  return {
    async consider(candidate) {
      if (!needle) return { engage: false }
      if (needle !== '*' && !candidate.text.toLowerCase().includes(needle)) return { engage: false }
      return { engage: true }
    },
  }
}
