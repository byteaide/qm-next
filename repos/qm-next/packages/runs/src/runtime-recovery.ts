/**
 * Runtime handoff recovery (M-Tape-2, 2026-09-26).
 *
 * qm-verbatim port of qm `src/harness/runtime-recovery.ts` (33L). Walks the
 * session entry log in reverse, returns the most recent `tool='runtime'`
 * `tool_result` whose `runId` + `actorId` match the current Run, provided
 * its `runtimeHandoff.choice` validates against `RuntimeChoice`. Used by
 * the orchestrator before its configured router resolution so a previous
 * turn's engine/model selection survives a reaped-run resume.
 *
 * Source-of-truth (qm, 2026-09-26): `repos/qm/src/harness/runtime-recovery.ts:1-33`.
 *
 * Independence from `@qm/orchestrator`: the function needs `RuntimeChoice`
 * (now in `@qm/types/runtime-choice.ts`) and `isHarnessId` (from
 * `@qm/model/pi-models.ts`). It does NOT depend on the orchestrator's
 * resolve ladder, so `@qm/runs` stays below the orchestrator in the
 * dependency graph.
 *
 * qm-next `RuntimeChoice` discipline: qm's contract carries `effortLevel`
 * and `fastMode` on the wire (`repos/qm/src/harness/harness.ts`); qm-next
 * propagates those via `HarnessTurnInput.harness` and resolves them in
 * the harness layer, so the qm-next `RuntimeChoice` is narrower
 * (`{ harnessId, modelId }` only). The validation accordingly drops the
 * qm `effortLevel`/`fastMode` type guards — the orchestrator's
 * `resolveRuntimeChoice` ladder is the source of truth for effort/fast
 * policy; this function only recovers the engine/model pair.
 */
import type { RuntimeChoice, SessionEntry } from '@qm/types'
import { isHarnessId } from '@qm/model'

/** Narrow object guard — keeps `payload`/`runtimeHandoff`/`choice`
 *  probing honest without `as any`. Mirrors qm `src/util/objects.ts`
 *  `isObj` (this package doesn't share qm's util layer; the guard is
 *  three lines). */
function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function recoveredRuntime(
  entries: readonly SessionEntry[],
  runId: string,
  actorId: string,
): RuntimeChoice | undefined {
  for (const entry of [...entries].reverse()) {
    const p = entry.payload
    if (
      entry.type !== 'tool_result' ||
      !isObj(p) ||
      p.tool !== 'runtime' ||
      p.runId !== runId ||
      p.actorId !== actorId ||
      !isObj(p.runtimeHandoff)
    ) {
      continue
    }
    const choice = p.runtimeHandoff.choice
    if (
      isObj(choice) &&
      isHarnessId(choice.harnessId) &&
      typeof choice.modelId === 'string'
    ) {
      return choice as unknown as RuntimeChoice
    }
  }
  return undefined
}