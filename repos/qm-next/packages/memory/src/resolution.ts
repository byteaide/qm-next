/**
 * Resolution seam for memory (14.0): wraps a ResolutionService so recalled
 * scope memory is appended to the system prompt — the hook point named in
 * m3-scope 14.0. Selection is static (caller-provided scope chain); recall
 * failures are fail-open so a broken store never blocks a turn.
 */
import type { Conversation, Principal, ResolutionService } from '@qm/types'
import type { ScopeId } from '@qm/types'
import type { ScopeMemory } from './contract.ts'

export interface MemoryTurnSelection {
  /** Scopes recalled into the prompt, in order; non-empty recalls join with a blank line. */
  read: ScopeId[]
  /** Human label for the conversation context line, e.g. `#eng` or `a direct message`. */
  context?: string
}

export function memoryRecallBlock(recalled: string, context = 'this conversation'): string {
  return `\n\n## What you remember\nYou're in ${context}. A memory tagged \`(said in …)\` was stated in another context — apply it only if that tag matches here; untagged memories are general.\n\n${recalled}`
}

export function wrapResolutionWithMemory(
  inner: ResolutionService,
  memory: ScopeMemory,
  select: (conversation: Conversation, actor: Principal, scope: ScopeId) => MemoryTurnSelection | undefined,
): ResolutionService {
  return {
    scopeFor: (conversation, actor) => inner.scopeFor(conversation, actor),
    resolve: async (conversation, actor) => {
      const base = await inner.resolve(conversation, actor)
      const selection = select(conversation, actor, base.orgScopeId)
      if (!selection || !selection.read.length) return base
      const recalls: string[] = []
      for (const scopeId of selection.read) {
        try {
          const text = await memory.recall(scopeId)
          if (text) recalls.push(text)
        } catch {
          continue
        }
      }
      if (!recalls.length) return base
      return { ...base, systemPrompt: `${base.systemPrompt}${memoryRecallBlock(recalls.join('\n\n'), selection.context)}` }
    },
  }
}
