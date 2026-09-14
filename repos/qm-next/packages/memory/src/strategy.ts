/**
 * Memory strategy modes, ported from qm's `src/memory/strategy.ts` onto
 * the ScopeMemory port and a structural one-shot model slice. The strategy
 * decides what happens at turn end (automatic capture) and before prompts
 * (maintenance); the returned memory may be a wrapped store (consolidating
 * or scratch-tier).
 */
import type { ScopeId } from '@qm/types'
import { scopeId, parseScopeId } from '@qm/types'
import { captureFacts, type MemoryCaptureContext, type ScopeMemory } from './contract.ts'
import { createConsolidatingMemory, createConsolidator, DEFAULT_CONSOLIDATE_AFTER } from './strategies/consolidation.ts'
import { createAgentOnlyStrategy } from './strategies/agent-only.ts'
import { createPerTurnStrategy } from './strategies/per-turn.ts'
import { createScratchPromote } from './strategies/scratch-promote.ts'
import type { ScratchLogStore } from './scratch-log.ts'

/** Structural slice of the model utilities strategies need. */
export interface MemoryModel {
  oneShot(systemPrompt: string, prompt: string): Promise<string | undefined>
}

export interface MemoryStrategy {
  onTurnEnd?(ctx: {
    scopeId: ScopeId
    input: string
    reply: string
    actorId?: string
    autonomous?: boolean
    conversationScopeId?: ScopeId
    conversationLabel?: string
    sessionId?: string
    idempotencyKey?: string
  }): Promise<void>
  maintain?(scopeId: ScopeId): Promise<void>
  promptLines?(): string[]
}

export type MemoryStrategyKind = 'per-turn' | 'scratch-promote' | 'agent-only'

export const DEFAULT_MEMORY_STRATEGY: MemoryStrategyKind = 'per-turn'

export function parseMemoryStrategyKind(value: string | undefined): MemoryStrategyKind {
  return value === 'agent-only' || value === 'scratch-promote' ? value : DEFAULT_MEMORY_STRATEGY
}

export interface MemoryStrategyDeps {
  model: MemoryModel
  memory: ScopeMemory
  /** Scratch-tier storage; required by the scratch-promote strategy. */
  scratchLogs?: ScratchLogStore
  consolidateAfter?: number
  captureQuietMs?: number
  captureMaxTurns?: number
  onCaptureError?: (e: unknown, scopeId: ScopeId) => void
}

/** qm's `ccTargetFor`: channel/group chatter copies to the speaker's personal scope. */
export function ccTargetFor(origin: ScopeId, actorId: string | undefined): ScopeId | null {
  if (!actorId || actorId.startsWith('system:')) return null
  const { kind } = parseScopeId(origin)
  if (kind !== 'channel' && kind !== 'group') return null
  const target = scopeId('personal', actorId)
  return target === origin ? null : target
}

export async function ccCaptureToPersonal(
  memory: ScopeMemory,
  origin: ScopeId,
  actorId: string | undefined,
  facts: string[],
  at: number,
  sourceLabel?: string,
  context?: MemoryCaptureContext,
): Promise<number> {
  const target = ccTargetFor(origin, actorId)
  if (!target || !facts.length) return 0
  const { kind } = parseScopeId(origin)
  const clean = sourceLabel
    ?.replace(/[()\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  const source = clean || (kind === 'channel' ? 'a channel' : 'a group conversation')
  const tagged = facts.map((f) => `${f} (said in ${source})`)
  return captureFacts(memory, target, tagged, at, `cc:${origin}`, context)
}

export function createMemoryStrategy(
  kind: MemoryStrategyKind,
  deps: MemoryStrategyDeps,
): { strategy: MemoryStrategy; memory: ScopeMemory } {
  if (kind === 'scratch-promote') {
    if (!deps.scratchLogs) throw new Error('the scratch-promote strategy needs a scratch log store')
    return createScratchPromote({
      model: deps.model,
      memory: deps.memory,
      scratchLogs: deps.scratchLogs,
      consolidateAfter: deps.consolidateAfter ?? DEFAULT_CONSOLIDATE_AFTER,
      ...(deps.captureQuietMs !== undefined ? { captureQuietMs: deps.captureQuietMs } : {}),
      ...(deps.captureMaxTurns !== undefined ? { captureMaxTurns: deps.captureMaxTurns } : {}),
      ...(deps.onCaptureError ? { onCaptureError: deps.onCaptureError } : {}),
    })
  }
  const consolidator = createConsolidator({
    model: deps.model,
    memory: deps.memory,
    ...(deps.consolidateAfter !== undefined ? { afterN: deps.consolidateAfter } : {}),
  })
  const { memory, maintain } = createConsolidatingMemory(deps.memory, consolidator)
  if (kind === 'agent-only') {
    return {
      strategy: {
        ...createAgentOnlyStrategy(),
        ...(maintain ? { maintain } : {}),
      },
      memory,
    }
  }
  return {
    strategy: createPerTurnStrategy({
      model: deps.model,
      memory,
      ...(maintain ? { maintain } : {}),
      ...(deps.captureQuietMs !== undefined ? { captureQuietMs: deps.captureQuietMs } : {}),
      ...(deps.captureMaxTurns !== undefined ? { captureMaxTurns: deps.captureMaxTurns } : {}),
      ...(deps.onCaptureError ? { onCaptureError: deps.onCaptureError } : {}),
    }),
    memory,
  }
}
