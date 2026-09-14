/**
 * Scratch-promote strategy, ported from qm's `strategies/scratch-promote.ts`:
 * captures land in dated scratch logs (ScratchLogStore replaces qm's
 * workspace files); a `captures-since-promote` marker in the notebook
 * triggers a one-shot promotion that graduates durable facts into the
 * long-term notebook; logs age out after the retention window.
 */
import type { ScopeId } from '@qm/types'
import type { ScopeMemory } from '../contract.ts'
import { captureFacts } from '../contract.ts'
import { bullets, capTail, dateStr } from '../notebook.ts'
import { createKeyedQueue } from '../util.ts'
import { ccCaptureToPersonal, type MemoryModel, type MemoryStrategy } from '../strategy.ts'
import { isAutonomousBurst, createBurstBuffer, DEFAULT_CAPTURE_MAX_TURNS, extractFacts, type Burst } from './per-turn.ts'
import type { ScratchLogStore } from '../scratch-log.ts'

export const LOG_RETENTION_DAYS = 14
const LOG_RECALL_MAX_CHARS = 3_000

const MARKER_RE = /^<!-- captures-since-promote: (\d+) -->$/m

export const PROMOTION_PROMPT = [
  "You maintain an agent's long-term memory notebook (MEMORY.md).",
  'You are given the current notebook and a scratch log of recent automatic captures.',
  'Output the COMPLETE new notebook as markdown: keep the existing `# Memory` header style,',
  'keep every still-true long-term fact, and graduate from the scratch log only what proved',
  'durable — stable preferences, identifiers, ongoing projects, how the person likes to work.',
  'Drop one-off trivia, transient task state, and anything stale or contradicted. Drop pure',
  'system mechanics that can be looked up when needed (API endpoints, credential plumbing,',
  'state-file paths) — keep user-stated conventions and the existence of standing systems.',
  'Keep facts as concise `- (YYYY-MM-DD) fact` bullets. Never include secrets or credentials.',
  'Preserve any `(said in …)` suffix on a fact verbatim — it scopes where the fact was stated.',
  'Output ONLY the new notebook content. If nothing should change, output exactly: NONE',
].join('\n')

const SCRATCH_PROMOTE_PROMPT_LINES = [
  'Your memory has two tiers: a curated long-term notebook, and dated scratch logs of recent',
  "captures that age out after a couple of weeks. Facts you save with `memory` action \"remember\"",
  'land in the scratch tier alongside the automatic captures; recent scratch entries are',
  'periodically reviewed and the durable ones promoted into the notebook. To pin or fix a',
  'long-term fact immediately, curate the notebook itself (action "read", then "rewrite").',
]

function stripMarker(body: string): string {
  return body
    .replace(MARKER_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function recentDates(now: number, days: number): string[] {
  const out: string[] = []
  for (let i = days - 1; i >= 0; i--) out.push(dateStr(now - i * 86_400_000))
  return out
}

export interface ScratchPromoteDeps {
  model: MemoryModel
  memory: ScopeMemory
  scratchLogs: ScratchLogStore
  consolidateAfter: number
  captureQuietMs?: number
  captureMaxTurns?: number
  onCaptureError?: (e: unknown, scopeId: ScopeId) => void
}

export function createScratchPromote(deps: ScratchPromoteDeps): { strategy: MemoryStrategy; memory: ScopeMemory } {
  const base = deps.memory
  const scratch = deps.scratchLogs
  const perScope = createKeyedQueue<ScopeId>()

  async function rewriteMarker(scopeId: ScopeId, edit: (body: string) => string | null): Promise<string | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = await base.head(scopeId)
      const next = edit(head.content)
      if (next === null) return null
      if (await base.replaceIfRevision(scopeId, next, head.revision)) return next
    }
    return null
  }

  async function bumpMarker(scopeId: ScopeId, by: number): Promise<number> {
    let count = 0
    const committed = await rewriteMarker(scopeId, (body) => {
      const m = body.match(MARKER_RE)
      count = (m ? Number(m[1]) : 0) + by
      const marker = `<!-- captures-since-promote: ${count} -->`
      return m ? body.replace(MARKER_RE, marker) : `${body.trim() || '# Memory'}\n\n${marker}`
    })
    if (committed !== null) return count
    const body = await base.get(scopeId)
    const m = body.match(MARKER_RE)
    return m ? Number(m[1]) : 0
  }

  async function resetMarker(scopeId: ScopeId): Promise<void> {
    await rewriteMarker(scopeId, (body) =>
      MARKER_RE.test(body) ? body.replace(MARKER_RE, '<!-- captures-since-promote: 0 -->') : null,
    )
  }

  async function readLogWindow(scopeId: ScopeId, now: number, days: number): Promise<Array<{ date: string; body: string }>> {
    const present = new Set(await scratch.listDates(scopeId))
    const out: Array<{ date: string; body: string }> = []
    for (const date of recentDates(now, days)) {
      if (!present.has(date)) continue
      const body = (await scratch.read(scopeId, date)).trim()
      if (body) out.push({ date, body })
    }
    return out
  }

  const memory: ScopeMemory = {
    ...base,
    async recall(scopeId) {
      const longTerm = stripMarker(await base.recall(scopeId))
      const parts = longTerm ? [longTerm] : []
      for (const { date, body } of await readLogWindow(scopeId, Date.now(), 2)) {
        parts.push(`### Scratch log ${date}\n${capTail(body, LOG_RECALL_MAX_CHARS)}`)
      }
      return parts.join('\n\n')
    },

    async append(scopeId, facts, at, _author) {
      return perScope(scopeId, async () => {
        const date = dateStr(at)
        const added = await scratch.appendFacts(scopeId, date, facts, at)
        if (!added) return 0
        const count = await bumpMarker(scopeId, added)
        if (deps.consolidateAfter > 0 && count >= deps.consolidateAfter) {
          await resetMarker(scopeId)
          await strategy.maintain!(scopeId).catch(() => {})
        }
        return added
      })
    },

    async capture(scopeId, facts, at, _author, context) {
      void context
      return memory.append(scopeId, facts, at, _author)
    },

    async query(scopeId, q, limit = 20) {
      const fromNotebook = await base.query(scopeId, q, limit)
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
      if (!terms.length) return fromNotebook
      const fromLogs: string[] = []
      for (const { body } of await readLogWindow(scopeId, Date.now(), LOG_RETENTION_DAYS)) {
        for (const line of bullets(body)) {
          if (terms.every((t) => line.toLowerCase().includes(t))) fromLogs.push(line)
        }
      }
      const seen = new Set<string>()
      return [...fromNotebook, ...fromLogs].filter((l) => !seen.has(l) && (seen.add(l), true)).slice(0, limit)
    },
  }

  async function flushBurst(burst: Burst): Promise<void> {
    const autonomous = isAutonomousBurst(burst)
    const facts = await extractFacts(deps.model, burst.turns, { autonomous })
    if (!facts.length) return
    const at = Date.now()
    await captureFacts(memory, burst.scopeId, facts, at, burst.actorId, {
      mode: 'automatic',
      ...(burst.actorId ? { actorId: burst.actorId } : {}),
      conversationScopeId: burst.conversationScopeId,
      input: burst.turns.map((turn) => turn.input).join('\n\n'),
      reply: burst.turns.map((turn) => turn.reply).join('\n\n'),
      ...(autonomous ? { autonomous: true } : {}),
      ...(burst.sessionId ? { sessionId: burst.sessionId } : {}),
      ...(burst.idempotencyKey ? { idempotencyKey: burst.idempotencyKey } : {}),
    })
    if (autonomous) return
    await ccCaptureToPersonal(memory, burst.conversationScopeId, burst.actorId, facts, at, burst.conversationLabel, {
      mode: 'automatic',
      ...(burst.actorId ? { actorId: burst.actorId } : {}),
      conversationScopeId: burst.conversationScopeId,
      ...(burst.sessionId ? { sessionId: burst.sessionId } : {}),
      ...(burst.idempotencyKey ? { idempotencyKey: `${burst.idempotencyKey}:personal` } : {}),
    })
  }

  const strategy: MemoryStrategy = {
    onTurnEnd: createBurstBuffer(
      deps.captureQuietMs ?? 0,
      deps.captureMaxTurns ?? DEFAULT_CAPTURE_MAX_TURNS,
      flushBurst,
      (e, burst) => deps.onCaptureError?.(e, burst.scopeId),
    ),

    async maintain(scopeId) {
      const now = Date.now()
      const window = await readLogWindow(scopeId, now, LOG_RETENTION_DAYS)
      if (window.length && deps.model.oneShot) {
        // Promotion is a read → model round-trip → write. A save that lands
        // during the round-trip must not be silently reverted by the write,
        // so the write is compare-and-set against the revision we read; on a
        // lost race we skip — the next promotion pass will pick everything up.
        const head = await base.head(scopeId)
        const longTerm = stripMarker(head.content)
        const scratchBody = window.map(({ date, body }) => `## ${date}\n${body}`).join('\n\n')
        const out = (
          (await deps.model.oneShot(
            PROMOTION_PROMPT,
            `Current notebook:\n${longTerm || '(empty)'}\n\nScratch log:\n${scratchBody}`,
          )) ?? ''
        ).trim()
        if (out && !/^none$/i.test(out)) {
          await base.replaceIfRevision(scopeId, out, head.revision)
        }
      }
      const cutoff = dateStr(now - LOG_RETENTION_DAYS * 86_400_000)
      for (const date of await scratch.listDates(scopeId)) {
        if (date < cutoff) await scratch.remove(scopeId, date)
      }
    },

    promptLines() {
      return SCRATCH_PROMOTE_PROMPT_LINES
    },
  }

  return { strategy, memory }
}
