/**
 * Phase 3I security routes — screener surface (qm `src/security/` parity,
 * lane-opening freeze). `POST /v1/security/screen` accepts a payload +
 * hook and returns the classifier verdict (`{decision, reason, score,
 * threshold, outcome?}`). When no screener is wired (production without
 * the security plugin, or fresh boot before late injection), the route
 * answers 503 so callers can distinguish "service not configured" from
 * an `auto` verdict.
 *
 * Why a fresh route and not the existing `auto-flagger/test` admin route:
 * `auto-flagger/test` is org-scoped admin territory (it tests the
 * org-wide auto-flagger policy). The screener is a *per-payload* judgment
 * that the IM bridge / turn handler consults on every message — it's a
 * different surface (per-actor source auth, not admin), and conflating
 * the two would obscure the contract. We leave the existing 501 admin
 * route untouched.
 */
import type { ApiRouteContext, Route } from './framework.ts'
import { isObj, notFound, sendJson } from './framework.ts'
import type { SecurityScreenHook, SecurityScreener } from '@qm/security'

const MAX_SCREEN_PAYLOAD_CHARS = 16_000
const VALID_HOOKS: ReadonlySet<SecurityScreenHook> = new Set(['user_input', 'tool_response'])

export interface SecurityRoutesDeps {
  /** Returns the live screener (post-boot injection safe). `undefined` while the security plugin hasn't booted. */
  screener: () => SecurityScreener | undefined
}

function parseHook(value: unknown): SecurityScreenHook | null {
  if (typeof value !== 'string') return null
  return VALID_HOOKS.has(value as SecurityScreenHook) ? (value as SecurityScreenHook) : null
}

export function securityRoutes(deps: SecurityRoutesDeps): ReadonlyArray<Route> {
  return [
    {
      method: 'POST',
      path: '/v1/security/screen',
      auth: 'source',
      handle: async (ctx: ApiRouteContext) => {
        const body = isObj(ctx.body) ? ctx.body : {}
        const payload = typeof body.payload === 'string' ? body.payload : ''
        if (!payload) {
          return sendJson(ctx, 400, { error: 'bad_request', message: 'payload (string) required' })
        }
        if (payload.length > MAX_SCREEN_PAYLOAD_CHARS) {
          return sendJson(ctx, 400, {
            error: 'bad_request',
            message: `payload exceeds the screener limit (${MAX_SCREEN_PAYLOAD_CHARS} chars)`,
          })
        }
        const hook = parseHook(body.hook)
        if (!hook) {
          return sendJson(ctx, 400, { error: 'bad_request', message: "hook must be 'user_input' or 'tool_response'" })
        }
        const screener = deps.screener()
        if (!screener) {
          return sendJson(ctx, 503, {
            error: 'not_wired',
            message: 'no security screener is wired; configure the security plugin or inject a mock',
          })
        }
        const classification = await screener.classify({
          payload,
          hook,
          ...(body.requestId !== undefined ? { requestId: String(body.requestId) } : {}),
        })
        return sendJson(ctx, 200, {
          verdict: classification.verdict,
          score: classification.score,
          threshold: classification.threshold,
          ...(classification.outcome !== undefined ? { outcome: classification.outcome } : {}),
          provider: screener.provider,
          shadow: screener.shadow,
        })
      },
    },
    {
      method: 'GET',
      path: '/v1/security/screen',
      auth: 'source',
      handle: async (ctx: ApiRouteContext) => {
        // Probe endpoint so test harnesses can distinguish "screener
        // wired but verdict depends on payload" from "screener not wired
        // at all" without POSTing a payload.
        const screener = deps.screener()
        if (!screener) return notFound(ctx)
        return sendJson(ctx, 200, { wired: true, provider: screener.provider, shadow: screener.shadow })
      },
    },
  ]
}