/**
 * Phase 3 — Security Screen configuration.
 *
 * Resolves the Security Screen mode at startup. The configuration is
 * deliberately minimal: missing mode defaults to `off` (the safe
 * starting point); invalid mode fails startup (deterministic per plan
 * §3.2 Configuration tests). Enforce Mode without explicit operator
 * cutover is the responsibility of `createSecurityScreenAdapter`
 * (ADR-0004 §3, plan §3.2).
 */
import type { ScreenMode } from './screen-adapter.ts'

export const SCREEN_MODE_VALUES = ['off', 'shadow', 'enforce'] as const

export function isScreenMode(value: unknown): value is ScreenMode {
  return typeof value === 'string' && (SCREEN_MODE_VALUES as readonly string[]).includes(value)
}

export function parseScreenMode(value: unknown): ScreenMode | undefined {
  return isScreenMode(value) ? value : undefined
}

export interface SecurityScreenConfig {
  mode: ScreenMode
  cutoverDeclared: boolean
  /** Default retention for Shadow Records. */
  retentionMs?: number
}

export interface ResolveScreenConfigOptions {
  /** Raw config input (env var or programmatic override). */
  raw: { mode?: unknown; cutoverDeclared?: unknown; retentionMs?: unknown }
  /** Required: the operator-process declaration of Enforce criteria. */
  operatorDeclaration?: {
    sampleSize: number
    falsePositiveReview: boolean
    latencyMs: number
    availabilityPercent: number
    securityReview: boolean
  }
}

export interface ResolvedScreenConfig {
  ok: true
  config: SecurityScreenConfig
}

export interface RejectedScreenConfig {
  ok: false
  reason: string
}

export type ScreenConfigResult = ResolvedScreenConfig | RejectedScreenConfig

/**
 * Resolves a Security Screen config. Behavior:
 *  - missing mode        → `off` (deterministic default per plan §3.2 Configuration tests)
 *  - invalid mode        → startup error (`{ok:false, reason}`)
 *  - enforce + no operator declaration → startup error (no auto-escalation)
 *  - enforce + declared  → returns `{ok:true, config}` with cutoverDeclared:true
 *  - shadow              → returns `{ok:true, config}`; Shadow Records are persisted
 *                          in the store wired at adapter construction.
 */
export function resolveScreenConfig(opts: ResolveScreenConfigOptions): ScreenConfigResult {
  if (opts.raw.mode === undefined) {
    return { ok: true, config: { mode: 'off', cutoverDeclared: false } }
  }
  const mode = parseScreenMode(opts.raw.mode)
  if (mode === undefined) {
    return {
      ok: false,
      reason: `invalid Security Screen mode: ${JSON.stringify(opts.raw.mode)}; expected one of ${SCREEN_MODE_VALUES.join(', ')}`,
    }
  }
  if (mode === 'enforce') {
    if (opts.raw.cutoverDeclared !== true) {
      return {
        ok: false,
        reason: 'Security Screen Enforce Mode requires cutoverDeclared: true (ADR-0004 §3)',
      }
    }
    if (!opts.operatorDeclaration) {
      return {
        ok: false,
        reason:
          'Security Screen Enforce Mode requires an operator declaration of sample size, false-positive review, latency, availability, and security-review criteria (ADR-0004 §3, plan §3.2 Configuration tests).',
      }
    }
    const d = opts.operatorDeclaration
    if (!d.securityReview) {
      return { ok: false, reason: 'operator declaration.securityReview must be true' }
    }
    return {
      ok: true,
      config: { mode: 'enforce', cutoverDeclared: true },
    }
  }
  if (mode === 'shadow') {
    return {
      ok: true,
      config: { mode: 'shadow', cutoverDeclared: false },
      ...(typeof opts.raw.retentionMs === 'number' ? { retentionMs: opts.raw.retentionMs as number } : {}),
    } as ResolvedScreenConfig
  }
  return {
    ok: true,
    config: { mode: 'off', cutoverDeclared: false },
  }
}