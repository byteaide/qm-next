/**
 * Runtime choice contract — which engine + model a turn uses.
 *
 * Lives in `@qm/types` (not in `@qm/orchestrator`) so runtime consumers
 * outside the orchestrator (e.g. `@qm/runs/runtime-recovery.ts` for the
 * M-Tape-2 runtime handoff recovery) can depend on the type without
 * creating a circular dependency back through the orchestrator. The
 * orchestrator's `resolveRuntimeChoice` ladder continues to live in
 * `@qm/orchestrator/src/runtime-choice.ts` and re-exports this type for
 * backward compatibility.
 *
 * Source-of-truth (qm, 2026-09-26): `repos/qm/src/harness/harness.ts`
 * `RuntimeChoice` (qm-next's narrower shape — qm carries `effortLevel`
 * and `fastMode` on the wire; qm-next propagates those through
 * `HarnessTurnInput.harness` and resolves them in the harness layer,
 * not on this contract).
 */
export interface RuntimeChoice {
  harnessId: string
  modelId: string
}