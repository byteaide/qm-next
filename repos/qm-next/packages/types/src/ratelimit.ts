/**
 * Admission control contracts: per-principal rate limiting and spend budget.
 * Semantics match qm's ratelimit module so implementations translate as-is.
 */
export interface RateDecision {
  allowed: boolean
  retryAfterMs?: number
}

export interface RateLimiter {
  check(principalId: string): Promise<RateDecision>
}

export interface BudgetCheck {
  allowed: boolean
  spentUsd: number
  limitUsd: number
}

export interface BudgetTracker {
  check(principalId: string, now?: number): Promise<BudgetCheck>
  record(principalId: string, costUsd: number, now?: number): Promise<void>
}
