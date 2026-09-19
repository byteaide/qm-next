/**
 * Target Trigger Runtime contract — implements ADR-0003 (Runtime contracts
 * decouple Trigger and API).
 *
 * Phase 0 freeze: types compile. Triggers may NOT depend on `@qm/api`
 * (`pnpm test:architecture` enforces it). Phase 4 migrates trigger
 * dispatch onto this port and removes the `api.cronsRuntime` late-write.
 *
 * Minimal surface: submit, health, identity. Anything Triggers need beyond
 * this list is itself a Phase 0 architecture violation (§Phase 4 boundary
 * tests).
 */
import type { Principal, ScopeId } from './identity.ts'

/** Result of a single Trigger submission. The Run is the only identity that crosses the boundary. */
export interface TriggerSubmitResult {
  runId: string
  sessionId: string
  /** When the trigger accepted the submission (epoch ms). */
  acceptedAt: number
}

/** Identity response for `TriggerRuntime.identity()` — opaque to Triggers. */
export interface TriggerIdentity {
  instanceId: string
  /** Runtime version (semver). */
  version: string
  /** Allowed Trigger origins (Phase 5 will refine this list). */
  supportedTriggers: readonly string[]
}

/** Health response — minimal liveness/readiness for Trigger callers. */
export interface TriggerHealth {
  ok: boolean
  /** When `false`, the reason is opaque to triggers but human-readable. */
  reason?: string
}

/** Input Triggers pass when submitting work. Runtime resolves Session/run. */
export interface TriggerSubmitInput {
  /** Surface key the trigger submits on behalf of (e.g. `cron`, `webhook`). */
  triggerKind: string
  /** The actor whose consent the work runs under. */
  actor: Principal
  scopeId: ScopeId
  /** Free-form text payload; runtime wraps in a `TurnInput`. */
  text: string
  /** Idempotency key — Trigger guarantees uniqueness within its lease window. */
  fireKey: string
  /** Optional override for the harness (otherwise the default is used). */
  harness?: string
}

/**
 * Minimal Trigger Runtime contract. `packages/triggers` MUST NOT import
 * `@qm/api`; this interface is the only dependency it may hold against
 * the runtime core.
 */
export interface TriggerRuntime {
  /** Submit a Trigger fire. Returns the resulting Run identity. */
  submit(input: TriggerSubmitInput): Promise<TriggerSubmitResult>
  /** Report runtime identity to Trigger callers (drained version, instance id). */
  identity(): TriggerIdentity
  /** Report health. Triggers MUST NOT block on this for normal scheduling. */
  health(): Promise<TriggerHealth>
}
