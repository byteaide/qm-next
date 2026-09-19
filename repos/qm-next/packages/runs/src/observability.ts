/**
 * Phase 1 observability baseline — the metric families that subsequent
 * phases extend rather than introduce parallel ones.
 *
 * Counters (and the alerts that fire on them) are defined in
 * `docs/implementation-plan.md §1.6`. This module is the in-process
 * surface: production deployments wire it to whatever metrics backend
 * is configured (Phase 1 ships an in-memory implementation; the
 * Sentry/OTel wiring is part of slice 1.6).
 *
 * Linked ADRs: ADR-0001 (Run owns terminal events), ADR-0013 (state
 * and events commit together), ADR-0014 (observation redacts
 * secrets).
 */

export type CounterLabels = Record<string, string>

export interface CounterSnapshot {
  /** Counter name (e.g. `run_event_commit_total`). */
  name: string
  /** Sum of all observed label sets' values for this counter. */
  total: number
  /** Per-label-set totals. */
  byLabels: ReadonlyArray<{ labels: CounterLabels; value: number }>
}

/**
 * Tiny in-memory counter registry. Production deployments inject a
 * backend-backed implementation that exports to the metrics platform.
 * Tests use this directly to assert that the right counter ticks
 * fire on the right code paths.
 */
export interface RunMetricsRegistry {
  /** Increment a counter by 1 with the given labels. */
  inc(name: string, labels?: CounterLabels): void
  /** Increment a counter by `n` with the given labels. */
  add(name: string, n: number, labels?: CounterLabels): void
  /** Snapshot all counters. Used by tests and by the metrics scrape. */
  snapshot(): readonly CounterSnapshot[]
  /** Reset all counters. Test-only — production code MUST NOT call this. */
  reset(): void
}

export function createRunMetricsRegistry(): RunMetricsRegistry {
  const counters = new Map<string, Map<string, number>>()
  function labelsKey(labels: CounterLabels): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
    return entries.map(([k, v]) => `${k}=${v}`).join('|')
  }
  function getOrCreate(name: string): Map<string, number> {
    let c = counters.get(name)
    if (!c) {
      c = new Map()
      counters.set(name, c)
    }
    return c
  }
  return {
    inc(name, labels = {}) {
      this.add(name, 1, labels)
    },
    add(name, n, labels = {}) {
      const c = getOrCreate(name)
      const key = labelsKey(labels)
      c.set(key, (c.get(key) ?? 0) + n)
    },
    snapshot() {
      const out: CounterSnapshot[] = []
      for (const [name, byLabels] of counters.entries()) {
        let total = 0
        const labels: { labels: CounterLabels; value: number }[] = []
        for (const [key, value] of byLabels.entries()) {
          total += value
          const parsed: CounterLabels = {}
          if (key) {
            for (const part of key.split('|')) {
              const [k, v] = part.split('=')
              if (k && v !== undefined) parsed[k] = v
            }
          }
          labels.push({ labels: parsed, value })
        }
        out.push({ name, total, byLabels: labels })
      }
      return out
    },
    reset() {
      counters.clear()
    },
  }
}

/**
 * Canonical metric names from `docs/implementation-plan.md §1.6`.
 * The contract suite asserts that the right counters tick on the
 * right code paths; using string constants prevents typos.
 */
export const RUN_METRICS = {
  EVENT_COMMIT_TOTAL: 'run_event_commit_total',
  EVENT_TX_FAILURES_TOTAL: 'run_event_transaction_failures_total',
  SEQ_CONFLICT_TOTAL: 'run_seq_conflict_total',
  ATTEMPT_RETRY_TOTAL: 'run_attempt_retry_total',
  LEASE_RENEW_TOTAL: 'run_lease_renew_total',
  LEASE_REAP_TOTAL: 'run_lease_reap_total',
  LEASE_REAP_NEWER_SESSION_TOTAL: 'lease_reaper_newer_session_total',
  LEASE_OWNERSHIP_CONFLICT_TOTAL: 'run_lease_ownership_conflict_total',
  REDACTION_HIT_TOTAL: 'redaction_hit_total',
} as const

/**
 * Process-wide counter registry used by callers that do not inject
 * their own. Production deployments inject a backend-backed registry
 * via `ReaperOptions.metrics`; this default is the in-memory fallback
 * so unit tests and small-scale deployments do not have to wire one
 * up just to compile.
 */
const defaultRegistry = createRunMetricsRegistry()

/**
 * Slice 1.3 — increment the `lease_reaper_newer_session_total`
 * counter for `count` skipped Runs. Called by the reaper when no
 * `metrics` registry is injected. The `outcome` label is fixed at
 * `skipped_newer_session` because that is the only event the reaper
 * emits on this counter; other reaper outcomes (`requeued`, `parked`)
 * roll up into `LEASE_REAP_TOTAL` instead.
 */
export function bumpReaperNewerSessionCounter(count: number): void {
  if (count <= 0) return
  defaultRegistry.add(RUN_METRICS.LEASE_REAP_NEWER_SESSION_TOTAL, count, { outcome: 'skipped_newer_session' })
}

/** Exposed for tests so the in-memory registry can be reset between
 *  test cases. Production code MUST NOT use this. */
export function _resetDefaultRunMetricsRegistryForTests(): void {
  defaultRegistry.reset()
}

/**
 * Boundary helper: record a `redaction_hit` whenever a secret-shaped
 * string is detected at the observation/log boundary. The Phase 1
 * implementation is a single-line scrubber; slice 1.4 lands the typed
 * producer-schema allowlist.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  // OAuth bearer / Authorization headers
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  // Generic API keys (32+ char base64-ish tokens)
  /\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // PEM blocks
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
]

export function isSecretShaped(text: string): boolean {
  for (const p of SECRET_PATTERNS) {
    p.lastIndex = 0
    if (p.test(text)) return true
  }
  return false
}

export interface RedactionMarker {
  /** Stable redaction key — preserve that redaction occurred without
   *  leaking the original bytes. */
  marker: string
}

/**
 * Scan a string for secret-shaped content and replace matches with
 * a stable redaction marker. The marker preserves that redaction
 * occurred (so producers / consumers can detect leaks) without
 * leaking the original bytes.
 */
export function redactSecrets(text: string, sink: 'observation' | 'log' = 'observation'): string {
  let out = text
  let count = 0
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, () => {
      count += 1
      return '[redacted]'
    })
  }
  if (count > 0) {
    // The metric tick happens at the call site so the registry is
    // injectable; this helper just returns the redacted text.
    void sink
  }
  return out
}