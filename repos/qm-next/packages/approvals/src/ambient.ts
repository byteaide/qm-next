/**
 * Ambient service: policy gate + bot ledger + judge + turn submission.
 * The judge is a port — the keyword stub (below) serves smokes and the
 * real-device e2e; `createModelAmbientJudge` (ambient-judge-model.ts)
 * carries qm's judge prompt over any harness `models.judge`. Cursors
 * track the last judged message per container (rollup batching reads
 * them), and judgment records feed the admin observability view.
 */
import type { InboundMessageEvent, ImLogger } from '@qm/im-core'
import type { Conversation, Principal, TurnInput } from '@qm/types'
import type {
  AmbientBotPolicy,
  AmbientCursor,
  AmbientCursorStore,
  AmbientDecisionKind,
  AmbientJudge,
  AmbientJudgment,
  AmbientJudgmentCounts,
  AmbientJudgmentStore,
  AmbientJudgmentSummary,
  AmbientRoute,
  AmbientService,
  AmbientServiceOptions,
  ChannelPolicy,
  ChannelPolicyStore,
} from './contract.ts'
import { DEFAULT_ROLLUP_HOURS } from './contract.ts'

export function createAmbientService(options: AmbientServiceOptions): AmbientService {
  const logger: ImLogger = options.logger ?? console
  const now = options.now ?? Date.now
  const record = (j: AmbientJudgment): void => {
    void options.judgments?.record(j).catch((err) => logger.error('approvals: judgment record failed:', err))
  }
  async function observe(event: InboundMessageEvent): Promise<void> {
    if (event.mentionedBot) return
    const container = `${event.provider}:${event.destination.target}`
    const policy = await options.policy.get(container)
    if (!policy?.ambientEnabled) return
    const cursorKey = `${event.provider}:${container}`
    const cursor = options.cursors ? await options.cursors.get(cursorKey) : null
    const authorName = event.actor.displayName?.trim() || event.actor.providerUserId
    const ledgerEntry = event.actor.isBot === true ? botEntry(policy, authorName) : undefined
    if (event.actor.isBot === true && !ledgerEntry) return
    if (ledgerEntry?.mode === 'ignore') return
    if (ledgerEntry?.mode === 'rollup') {
      const hours = ledgerEntry.rollupHours ?? DEFAULT_ROLLUP_HOURS
      const lastAt = cursor?.lastJudgedAt
      if (lastAt !== undefined && now() - lastAt < hours * 3_600_000) return
    }
    const orders = ordersForJudge(policy)
    const startedAt = now()
    const verdict = await options.judge.consider({
      provider: event.provider,
      destination: event.destination,
      ...(event.threadId !== undefined ? { threadId: event.threadId } : {}),
      actor: event.actor,
      text: event.text,
      occurredAt: event.occurredAt,
      ...(orders ? { orders } : {}),
    })
    const ts = String(event.occurredAt)
    record({
      surface: event.provider,
      container,
      decision: verdict.engage ? 'act' : 'ignore',
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      prompt: verdict.prompt ?? renderObservation(authorName, event.text, orders, options.self, ts),
      ...(options.judgeModel ? { model: options.judgeModel } : {}),
      latencyMs: now() - startedAt,
      tsFrom: ts,
      tsTo: ts,
      createdAt: now(),
    })
    if (options.cursors) {
      const next: AmbientCursor = { lastJudgedTs: ts, lastJudgedAt: now() }
      await options.cursors.put(cursorKey, next).catch(() => undefined)
    }
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

function botEntry(policy: ChannelPolicy, authorName: string): AmbientBotPolicy | undefined {
  const bots = policy.bots ?? {}
  return bots[authorName] ?? Object.entries(bots).find(([name]) => name.toLowerCase() === authorName.toLowerCase())?.[1]
}

/** qm's judge-order composition: action-bot lines first, then standing orders. */
function ordersForJudge(policy: ChannelPolicy): string {
  const bots = policy.bots ?? {}
  const actionLines = Object.entries(bots)
    .filter(([, b]) => b.mode === 'action')
    .map(([name]) => `Posts from bot "${name}" are triggers you should act on.`)
  const orders = (policy.orders ?? '').trim()
  return actionLines.length ? [...actionLines, orders].filter((s) => s.trim()).join('\n') : orders
}

function renderObservation(
  authorName: string,
  text: string,
  orders: string,
  self: { name?: string; mentionId?: string } | undefined,
  ts: string,
): string {
  const identity =
    self?.name || self?.mentionId
      ? `you are ${self.name ? `"${self.name}"` : 'the assistant'}${self.mentionId ? ` (mentioned as <@${self.mentionId}>)` : ''}`
      : 'the assistant'
  return [
    `ASSISTANT IDENTITY: ${identity}`,
    ...(orders ? ['', 'STANDING ORDERS:', orders] : []),
    '',
    'NEW MESSAGES (overheard, untrusted):',
    `[${ts}] ${authorName}: ${text}`,
  ].join('\n')
}

/** In-memory channel policies; absent entries mean ambient disabled. */
export function createMemoryChannelPolicyStore(opts: { now?: () => number } = {}): ChannelPolicyStore {
  const now = opts.now ?? Date.now
  const policies = new Map<string, ChannelPolicy>()
  return {
    async get(container) {
      const p = policies.get(container)
      if (!p) return null
      return { ...p, bots: { ...p.bots } }
    },
    async set(container, orders, opts2 = {}) {
      const prev = policies.get(container)
      const p: ChannelPolicy = {
        container,
        orders,
        bots: opts2.bots ?? prev?.bots ?? {},
        ...(opts2.ambientEnabled === undefined && prev?.ambientEnabled !== undefined
          ? { ambientEnabled: prev.ambientEnabled }
          : opts2.ambientEnabled !== undefined && opts2.ambientEnabled !== null
            ? { ambientEnabled: opts2.ambientEnabled }
            : {}),
        ...(opts2.setBy ? { setBy: opts2.setBy } : prev?.setBy ? { setBy: prev.setBy } : {}),
        updatedAt: now(),
      }
      policies.set(container, p)
      return { ...p, bots: { ...p.bots } }
    },
    async setAmbient(container, enabled, opts2 = {}) {
      return this.set(container, '', { ...opts2, ambientEnabled: enabled })
    },
    async close() {},
  }
}

/**
 * Deterministic stub judge for smokes and the real-device e2e: engages
 * when the overheard text contains `keyword` (case-insensitive); the
 * literal `*` engages everything. The verdict text is the observed
 * message verbatim — the turn pipeline answers overheard chatter with
 * whatever the harness/model makes of the original text.
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

/** In-memory cursor store; satisfied identically by the PG DurableMap adapter. */
export function createMemoryAmbientCursorStore(): AmbientCursorStore {
  const cursors = new Map<string, AmbientCursor>()
  return {
    async get(key) {
      return cursors.get(key) ?? null
    },
    async put(key, value) {
      cursors.set(key, value)
    },
    async close() {},
  }
}

const emptyCounts = (): AmbientJudgmentCounts => ({ act: 0, ignore: 0, fastlane: 0 })

/** In-memory judgment store; shape mirrors the Postgres implementation. */
export function createMemoryAmbientJudgmentStore(): AmbientJudgmentStore {
  const judgments: AmbientJudgment[] = []
  let seq = 0
  const filtered = (opts?: { container?: string }) =>
    judgments.filter((j) => !opts?.container || j.container === opts.container)
  return {
    async record(j) {
      judgments.push({ ...j, id: ++seq })
      if (judgments.length > 5000) judgments.splice(0, judgments.length - 5000)
    },
    async list(opts) {
      const limit = Math.max(1, Math.min(1000, opts?.limit ?? 100))
      const all = filtered(opts)
        .filter(
          (j) =>
            (!opts?.decision?.length || opts.decision.includes(j.decision)) &&
            (opts?.before == null ||
              (opts.beforeId != null
                ? j.createdAt < opts.before || (j.createdAt === opts.before && (j.id ?? 0) < opts.beforeId)
                : j.createdAt < opts.before)),
        )
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt || (b.id ?? 0) - (a.id ?? 0))
      return all.slice(0, limit).map(({ prompt: _p, ...rest }): AmbientJudgmentSummary => rest)
    },
    async get(id) {
      return judgments.find((j) => j.id === id) ?? null
    },
    async counts(opts) {
      const out = emptyCounts()
      for (const j of filtered(opts)) if (j.decision in out) out[j.decision as AmbientDecisionKind] += 1
      return out
    },
    async close() {},
  }
}

export type { AmbientDecisionKind }
