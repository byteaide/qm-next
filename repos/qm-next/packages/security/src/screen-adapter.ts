/**
 * Phase 3 — Security Screen Adapter.
 *
 * Wraps the existing `SecurityScreener` with mode-aware behavior so the
 * orchestrator can consume a single port per ADR-0007 (orchestrator owns
 * stage order, not screening algorithms).
 *
 * Modes (ADR-0004):
 *   - off:       screener is not invoked. Returns `{mode:'off', decision:'allow'}`.
 *   - shadow:    screener is invoked. Records Shadow Record on every decision
 *                (allow/deny/unavailable). NEVER blocks the Turn. Unavailable
 *                screener records `screen_unavailable` and allows the Turn.
 *   - enforce:   screener is invoked. Denial rejects the Turn (orchestrator
 *                turns this into a refused Admission Record). Unavailable
 *                screener fails closed — rejects the Turn.
 *
 * Cutover gate (ADR-0004 §3): `enforce` mode requires `cutoverDeclared: true`.
 * If absent, the adapter refuses to start and throws at construction time;
 * this is the explicit, non-time-based cutover (plan §3.2).
 */
import { randomUUID } from 'node:crypto'
import type { SecurityScreenOutcome } from '@qm/types'
import type { AdmissionInput } from '@qm/types'
import { redactSecrets } from '@qm/admission'
import type { SecurityScreener } from './security-screener.ts'
import type {
  ShadowRecord,
  ShadowRecordStore,
} from './shadow-record-store.ts'

export type ScreenMode = 'off' | 'shadow' | 'enforce'

export interface ScreenAdapterOptions {
  screener?: SecurityScreener
  mode: ScreenMode
  /** Required when mode === 'enforce'. Default false; missing or false = startup error. */
  cutoverDeclared?: boolean
  /** Optional Shadow Record store; required when mode === 'shadow'. */
  shadowStore?: ShadowRecordStore
  /** Custom clock for tests. */
  now?: () => number
  /** Optional sampler: returns the excerpt sent to the screener. */
  buildExcerpt?: (input: AdmissionInput) => string
}

export class SecurityScreenAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecurityScreenAdapterError'
  }
}

const NO_OP_EXCERPT = (): string => ''

export function createSecurityScreenAdapter(opts: ScreenAdapterOptions): {
  screen(input: AdmissionInput): Promise<SecurityScreenOutcome>
  readonly mode: ScreenMode
  readonly cutoverDeclared: boolean
} {
  const mode = opts.mode
  const now = opts.now ?? Date.now
  const buildExcerpt = opts.buildExcerpt ?? NO_OP_EXCERPT

  // ADR-0004 cutover gate: enforce requires explicit declaration.
  if (mode === 'enforce' && opts.cutoverDeclared !== true) {
    throw new SecurityScreenAdapterError(
      'Security Screen Enforce Mode requires `cutoverDeclared: true`. ' +
        'Enforcement is a deliberate operator transition; auto-escalation is forbidden (plan §3.2, ADR-0004).',
    )
  }
  if (mode === 'shadow' && !opts.shadowStore) {
    throw new SecurityScreenAdapterError(
      'Security Screen Shadow Mode requires `shadowStore` to retain Shadow Records.',
    )
  }

  return {
    mode,
    cutoverDeclared: opts.cutoverDeclared === true,
    async screen(input: AdmissionInput): Promise<SecurityScreenOutcome> {
      const ts = now()
      // Off mode: skip the screener entirely.
      if (mode === 'off') {
        return { mode: 'off', decision: 'allow', ts }
      }
      if (!opts.screener) {
        // No screener wired — fail closed for enforce, allow + record for shadow.
        if (mode === 'enforce') {
          const outcome: SecurityScreenOutcome = {
            mode: 'enforce',
            decision: 'unavailable',
            reason: 'no screener wired',
            ts,
          }
          return outcome
        }
        // shadow
        if (opts.shadowStore) {
          await opts.shadowStore.create({
            id: allocateShadowId(),
            mode: 'shadow',
            decision: 'unavailable',
            reason: 'no screener wired',
            actor: input.actor,
            ...(input.scopeId !== undefined ? { scopeId: input.scopeId } : {}),
            redactedExcerpt: redactSecrets(buildExcerpt(input)) || undefined,
            latencyMs: 0,
            ts,
          })
        }
        return { mode: 'shadow', decision: 'unavailable', reason: 'no screener wired', ts }
      }

      const start = now()
      const rawExcerpt = buildExcerpt(input)
      const redactedExcerpt = redactSecrets(rawExcerpt)
      let outcome: SecurityScreenOutcome
      try {
        const classification = await opts.screener.classify({
          payload: redactedExcerpt,
          hook: 'user_input',
          ...(input.actor.id !== undefined ? { metadata: { actorId: input.actor.id, surface: input.surface } } : {}),
        })
        const verdict = classification.verdict
        if (verdict.unscreened === true) {
          outcome = { mode, decision: 'unavailable', reason: verdict.reason ?? 'screener unavailable', ts }
        } else if (verdict.decision === 'deny') {
          outcome = {
            mode,
            decision: 'deny',
            ...(verdict.ruleId !== undefined ? { ruleId: verdict.ruleId } : {}),
            reason: verdict.reason,
            ts,
          }
        } else {
          outcome = { mode, decision: 'allow', ts }
        }
      } catch (err) {
        outcome = { mode, decision: 'unavailable', reason: errMessage(err), ts }
      }
      const latencyMs = now() - start

      if (mode === 'shadow' && opts.shadowStore) {
        const record: ShadowRecord = {
          id: allocateShadowId(),
          mode: 'shadow',
          decision: outcome.decision,
          ...(outcome.reason !== undefined ? { reason: redactSecrets(outcome.reason) } : {}),
          ...(outcome.ruleId !== undefined ? { ruleId: outcome.ruleId } : {}),
          ...(redactedExcerpt.length > 0 ? { redactedExcerpt } : {}),
          actor: input.actor,
          ...(input.scopeId !== undefined ? { scopeId: input.scopeId } : {}),
          latencyMs,
          ts,
        }
        await opts.shadowStore.create(record)
      }

      // Enforce mode post-processing: if screener was unavailable, fail closed.
      if (mode === 'enforce' && outcome.decision === 'unavailable') {
        // No-op here; the waterfall rejects on `decision !== 'allow'` for
        // enforce mode. Returning the outcome keeps the contract uniform.
      }

      return outcome
    },
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function allocateShadowId(): string {
  return randomUUID()
}