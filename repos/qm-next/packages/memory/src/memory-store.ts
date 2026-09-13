/**
 * In-process ScopeMemory. Revision log mirrors the Postgres twin: opaque
 * monotonic sequence tokens ('0' = empty scope), so head/replaceIfRevision
 * semantics are identical across implementations and history/restore work
 * in dev mode. Mutations per scope are serialized through a promise chain.
 */
import type { ScopeId } from '@qm/types'
import type { MemoryHead, ScopeMemory } from './contract.ts'
import { MEMORY_RECALL_MAX_CHARS } from './contract.ts'
import { foldCapture, normalizeReplace, queryBullets, recallBody } from './notebook.ts'

interface RevisionRow {
  seq: number
  op: string
  body: string
  author?: string
  at: number
}

export function createMemoryScopeMemory(): ScopeMemory {
  const scopes = new Map<ScopeId, RevisionRow[]>()
  const chains = new Map<ScopeId, Promise<unknown>>()

  function rows(scopeId: ScopeId): RevisionRow[] {
    let rows = scopes.get(scopeId)
    if (!rows) {
      rows = []
      scopes.set(scopeId, rows)
    }
    return rows
  }

  function serialized<T>(scopeId: ScopeId, fn: () => T | Promise<T>): Promise<T> {
    const prior = chains.get(scopeId) ?? Promise.resolve()
    const next = prior.then(fn, fn)
    chains.set(
      scopeId,
      next.catch(() => undefined),
    )
    return next
  }

  function currentBody(scopeId: ScopeId): string {
    const rows_ = rows(scopeId)
    return rows_.length ? rows_[rows_.length - 1]!.body : ''
  }

  function insertRevision(scopeId: ScopeId, op: string, body: string, author: string | undefined, at: number): void {
    const rows_ = rows(scopeId)
    rows_.push({ seq: (rows_.length ? rows_[rows_.length - 1]!.seq : 0) + 1, op, body, ...(author ? { author } : {}), at })
  }

  async function conditionalReplace(
    scopeId: ScopeId,
    content: string,
    expectedSeq: number,
    author: string | undefined,
    op: string,
  ): Promise<boolean> {
    return serialized(scopeId, () => {
      const rows_ = rows(scopeId)
      const seq = rows_.length ? rows_[rows_.length - 1]!.seq : 0
      if (seq !== expectedSeq) return false
      const next = normalizeReplace(content)
      if (next !== currentBody(scopeId)) insertRevision(scopeId, op, next, author, Date.now())
      return true
    })
  }

  async function append(
    scopeId: ScopeId,
    op: string,
    at: number,
    author: string | undefined,
    derive: (existing: string) => { body: string } | null,
  ): Promise<void> {
    await serialized(scopeId, () => {
      const existing = currentBody(scopeId)
      const next = derive(existing)
      if (next && next.body !== existing) insertRevision(scopeId, op, next.body, author, at)
    })
  }

  function headOf(scopeId: ScopeId): MemoryHead {
    const rows_ = rows(scopeId)
    const last = rows_.length ? rows_[rows_.length - 1]! : undefined
    return {
      content: last?.body ?? '',
      revision: String(last?.seq ?? 0),
      ...(last ? { updatedAt: last.at } : {}),
    }
  }

  return {
    head: async (scopeId) => headOf(scopeId),

    get: async (scopeId) => currentBody(scopeId),

    replace: async (scopeId, content, author) => {
      await append(scopeId, 'replace', Date.now(), author, () => ({ body: normalizeReplace(content) }))
    },

    replaceIfRevision: async (scopeId, content, revision, author) => {
      if (!/^\d+$/.test(revision)) return false
      return conditionalReplace(scopeId, content, Number(revision), author, 'replace')
    },

    append: async (scopeId, facts, at, author) => {
      const trustedProvenance = author?.startsWith('cc:') === true
      let added = 0
      await append(scopeId, 'capture', at, author, (existing) => {
        const folded = foldCapture(existing, facts, at, trustedProvenance)
        added = folded.added
        return folded.added ? { body: `${folded.body}\n` } : null
      })
      return added
    },

    recall: async (scopeId, opts) => recallBody(currentBody(scopeId), opts?.maxChars ?? MEMORY_RECALL_MAX_CHARS),

    query: async (scopeId, q, limit = 20) => queryBullets(currentBody(scopeId), q, limit),

    history: async (scopeId, limit = 30) => {
      const capped = Math.max(1, Math.min(limit, 100))
      return rows(scopeId)
        .slice(-capped)
        .reverse()
        .map((r) => ({
          revision: String(r.seq),
          content: r.body,
          operation: r.op,
          ...(r.author ? { author: r.author } : {}),
          at: r.at,
        }))
    },

    restore: async (scopeId, revision, expectedRevision, author) => {
      if (!/^\d+$/.test(revision) || !/^\d+$/.test(expectedRevision)) return false
      const target = rows(scopeId).find((r) => r.seq === Number(revision))
      if (!target) return false
      return conditionalReplace(scopeId, target.body, Number(expectedRevision), author, 'restore')
    },

    updatedAt: async (scopeId) => headOf(scopeId).updatedAt,

    metadata: async () => {
      const out = new Map<ScopeId, { bytes: number; updatedAt?: number }>()
      for (const [scopeId] of scopes) {
        const head = headOf(scopeId)
        out.set(scopeId, { bytes: Buffer.byteLength(head.content, 'utf8'), ...(head.updatedAt ? { updatedAt: head.updatedAt } : {}) })
      }
      return out
    },
  }
}
