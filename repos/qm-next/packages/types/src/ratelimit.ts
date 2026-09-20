/**
 * Admission control contracts: per-principal rate limiting and spend budget.
 * Semantics match qm's ratelimit module so implementations translate as-is.
 */
export interface RateDecision {
  allowed: boolean
  retryAfterMs?: number
  /** Optional rate-limit context for Admission Records (plan §3.1); absent when the limiter does not expose it. */
  limit?: number
  remaining?: number
  resetMs?: number
}

export interface RateLimiter {
  check(principalId: string): Promise<RateDecision>
}

export interface BudgetCheck {
  allowed: boolean
  spentUsd: number
  limitUsd: number
  /** Optional budget context for Admission Records (plan §3.1); absent when the tracker does not expose it. */
  remaining?: number
  unit?: string
}

export interface BudgetTracker {
  check(principalId: string, now?: number): Promise<BudgetCheck>
  record(principalId: string, costUsd: number, now?: number): Promise<void>
}
