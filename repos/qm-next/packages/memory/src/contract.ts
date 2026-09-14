/**
 * ScopeMemory port (14.0, frozen): per-scope MEMORY.md notebook with
 * revision-conflict detection and recall-by-bullets. Adapted from qm's
 * MemoryService (`src/memory/{memory-service,postgres-memory-service}.ts`)
 * with the workspace/file backing removed: both implementations keep a
 * revision log, so revision tokens are opaque monotonic sequence strings
 * in both ('0' = empty scope) and history/restore work in dev mode too.
 *
 * OUT of M3 (m3-scope 14.0) — restored with parity 15.0: strategy modes,
 * memorable relay, provider routing. Still OUT: the MCP memory provider
 * (lands with the 16.0 mcp package).
 */
import type { ScopeId } from '@qm/types'

export const MEMORY_MAX_FACTS = 300

export const MEMORY_RECALL_MAX_CHARS = 6_000

export interface MemoryHead {
  content: string
  revision: string
  updatedAt?: number
}

export interface MemoryRevision {
  revision: string
  content: string
  operation: string
  author?: string
  at: number
}

/** How a capture was produced; automatic captures may target procedural providers. */
export interface MemoryCaptureContext {
  mode: 'explicit' | 'automatic'
  actorId?: string
  sessionId?: string
  conversationScopeId?: ScopeId
  input?: string
  reply?: string
  autonomous?: boolean
  idempotencyKey?: string
}

export interface ScopeMemory {
  head(scopeId: ScopeId): Promise<MemoryHead>
  get(scopeId: ScopeId): Promise<string>
  replace(scopeId: ScopeId, content: string, author?: string): Promise<void>
  replaceIfRevision(scopeId: ScopeId, content: string, revision: string, author?: string): Promise<boolean>
  append(scopeId: ScopeId, facts: string[], at: number, author?: string): Promise<number>
  /**
   * Context-aware capture (parity 15.0): automatic-mode procedural
   * providers (memorable) override this; the default routes to `append`
   * and returns its count.
   */
  capture?(
    scopeId: ScopeId,
    facts: string[],
    at: number,
    author?: string,
    context?: MemoryCaptureContext,
  ): Promise<number>
  recall(scopeId: ScopeId, opts?: { maxChars?: number; /** Turn task — procedural providers (memorable) key their retrieval on it. */ query?: string }): Promise<string>
  query(scopeId: ScopeId, q: string, limit?: number): Promise<string[]>
  history?(scopeId: ScopeId, limit?: number): Promise<MemoryRevision[]>
  restore?(scopeId: ScopeId, revision: string, expectedRevision: string, author?: string): Promise<boolean>
  updatedAt?(scopeId: ScopeId): Promise<number | undefined>
  metadata?(): Promise<Map<ScopeId, { bytes: number; updatedAt?: number }>>
  close?(): Promise<void>
}

/** Route an append-shaped call through `capture` when a provider overrides it. */
export async function captureFacts(
  memory: ScopeMemory,
  scopeId: ScopeId,
  facts: string[],
  at: number,
  author?: string,
  context?: MemoryCaptureContext,
): Promise<number> {
  if (memory.capture) return memory.capture(scopeId, facts, at, author, context)
  return memory.append(scopeId, facts, at, author)
}
