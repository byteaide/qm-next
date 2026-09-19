/**
 * In-memory SequenceAllocator: monotonic `(run_id, seq)` generator.
 *
 * The allocator is the single source of truth for `seq`. Any code path
 * that constructs a `(run_id, seq)` tuple outside this port is a
 * Phase 0 boundary violation (§2.5 of `docs/implementation-plan.md`).
 *
 * Linked ADRs: ADR-0001 (Run owns terminal events and observation).
 */
import type { RunId, SequenceAllocation, SequenceAllocator } from '@qm/types'

export function createMemorySequenceAllocator(): SequenceAllocator {
  const maxSeq = new Map<RunId, number>()
  return {
    async next(runId: RunId): Promise<SequenceAllocation> {
      const current = maxSeq.get(runId) ?? -1
      const next = current + 1
      maxSeq.set(runId, next)
      return { ok: true, seq: next }
    },
    async current(runId: RunId): Promise<number | null> {
      const value = maxSeq.get(runId)
      return value === undefined ? null : value
    },
  }
}
