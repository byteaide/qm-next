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
  /**
   * Set a gauge to `value` with the given labels (Phase 5 §5.5 —
   * `im_subscriber_lag`). Replaces the previous value for this label
   * set instead of accumulating; snapshots report the current value.
   */
  set(name: string, value: number, labels?: CounterLabels): void
  /** Snapshot all counters and gauges. Used by tests and the metrics scrape. */
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
    set(name, value, labels = {}) {
      const c = getOrCreate(name)
      const key = labelsKey(labels)
      c.set(key, value)
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
  /** Slice 2.6 — increment when a Session Reservation is released
   *  before its terminal Run Event is durable. Must always be 0; any
   *  non-zero value is an incident (plan §2.7 alerts). */
  SESSION_RESERVATION_RELEASE_ORDER_VIOLATION_TOTAL: 'session_reservation_release_order_violation_total',
  /** Slice 2.7 — Command Gate decision counter. */
  COMMAND_GATE_DECISION_TOTAL: 'command_gate_decision_total',
  /** Slice 2.7 — Approval Request outcome counter. */
  APPROVAL_REQUEST_TOTAL: 'approval_request_total',
  /** Slice 2.7 — Approval renewal outcome counter. */
  APPROVAL_RENEWAL_TOTAL: 'approval_renewal_total',
  /** Slice 2.7 — TTL sweep outcome counter. */
  APPROVAL_TTL_SWEEP_TOTAL: 'approval_ttl_sweep_total',
  REDACTION_HIT_TOTAL: 'redaction_hit_total',
  // Phase 3 — Turn Admission + Security Screen (plan §3.3).
  ADMISSION_DECISION_TOTAL: 'admission_decision_total',
  ADMISSION_RECORD_TOTAL: 'admission_record_total',
  SECURITY_SCREEN_DECISION_TOTAL: 'security_screen_decision_total',
  SECURITY_SCREEN_UNAVAILABLE_TOTAL: 'security_screen_unavailable_total',
  // Phase 4 — Trigger Runtime (plan §4 observability).
  TRIGGER_SUBMIT_TOTAL: 'trigger_submit_total',
  // Phase 5 — Durable IM intake and fan-out (plan §5.5, ADR-0008/0015).
  IM_INTAKE_DEDUP_TOTAL: 'im_intake_dedup_total',
  IM_SUBSCRIBER_LAG: 'im_subscriber_lag',
  IM_SUBSCRIBER_RETRY_TOTAL: 'im_subscriber_retry_total',
  IM_SUBSCRIBER_DEAD_LETTER_TOTAL: 'im_subscriber_dead_letter_total',
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

/**
 * Slice 2.6 — increment the release-order violation counter. The
 * boundary rule is durable transition → event → release; this counter
 * MUST stay at zero in production. Any non-zero value pages on-call.
 */
export function bumpReservationReleaseOrderViolation(count = 1): void {
  if (count <= 0) return
  defaultRegistry.add(RUN_METRICS.SESSION_RESERVATION_RELEASE_ORDER_VIOLATION_TOTAL, count)
}

/** Slice 2.7 — Command Gate decision increments. */
export function bumpCommandGateDecision(decision: 'allow' | 'deny' | 'require_approval'): void {
  defaultRegistry.inc(RUN_METRICS.COMMAND_GATE_DECISION_TOTAL, { decision })
}

/** Slice 2.7 — Approval Request outcome increments. */
export function bumpApprovalRequestOutcome(outcome: 'requested' | 'approved' | 'rejected' | 'expired'): void {
  defaultRegistry.inc(RUN_METRICS.APPROVAL_REQUEST_TOTAL, { outcome })
}

/** Slice 2.7 — Approval renewal outcome increments. */
export function bumpApprovalRenewal(outcome: 'accepted' | 'rejected'): void {
  defaultRegistry.inc(RUN_METRICS.APPROVAL_RENEWAL_TOTAL, { outcome })
}

/** Slice 2.7 — TTL sweep outcome increments. */
export function bumpApprovalTtlSweep(outcome: 'expired' | 'no_op'): void {
  defaultRegistry.inc(RUN_METRICS.APPROVAL_TTL_SWEEP_TOTAL, { outcome })
}

/** Exposed for tests so the in-memory registry can be reset between
 *  test cases. Production code MUST NOT use this. */
export function _resetDefaultRunMetricsRegistryForTests(): void {
  defaultRegistry.reset()
}

/**
 * Phase 3 §3.3 — Admission stage decision bumpers. The labels are
 * `stage` and `decision`. Plan §3.3 enumerates `stage` ∈ {identity,
 * rate_limit, budget, screen, session, dispatch} and `decision` ∈
 * {allow, deny, error, skipped}.
 *
 * `metrics` is optional: when omitted, the call goes to the default
 * in-memory registry. Production deployments inject a Prometheus /
 * OTel / Sentry backend via `ReaperOptions.metrics` or service
 * composition.
 */
export function bumpAdmissionDecision(
  metrics: RunMetricsRegistry | undefined,
  stage: 'identity' | 'rate_limit' | 'budget' | 'screen' | 'session' | 'dispatch',
  decision: 'allow' | 'deny' | 'error' | 'skipped',
): void {
  if (metrics) {
    metrics.inc(RUN_METRICS.ADMISSION_DECISION_TOTAL, { stage, decision })
    return
  }
  defaultRegistry.inc(RUN_METRICS.ADMISSION_DECISION_TOTAL, { stage, decision })
}

export function bumpAdmissionRecord(
  metrics: RunMetricsRegistry | undefined,
  outcome: 'accepted' | 'rejected',
): void {
  if (metrics) {
    metrics.inc(RUN_METRICS.ADMISSION_RECORD_TOTAL, { outcome })
    return
  }
  defaultRegistry.inc(RUN_METRICS.ADMISSION_RECORD_TOTAL, { outcome })
}

export function bumpSecurityScreenDecision(
  metrics: RunMetricsRegistry | undefined,
  mode: 'off' | 'shadow' | 'enforce',
  decision: 'allow' | 'deny' | 'unavailable',
): void {
  if (metrics) {
    metrics.inc(RUN_METRICS.SECURITY_SCREEN_DECISION_TOTAL, { mode, decision })
    return
  }
  defaultRegistry.inc(RUN_METRICS.SECURITY_SCREEN_DECISION_TOTAL, { mode, decision })
}

export function bumpSecurityScreenUnavailable(
  metrics: RunMetricsRegistry | undefined,
  mode: 'shadow' | 'enforce',
): void {
  if (metrics) {
    metrics.inc(RUN_METRICS.SECURITY_SCREEN_UNAVAILABLE_TOTAL, { mode })
    return
  }
  defaultRegistry.inc(RUN_METRICS.SECURITY_SCREEN_UNAVAILABLE_TOTAL, { mode })
}

/**
 * Phase 4 §4 observability — Trigger submit outcome.
 * Labels: `outcome={accepted,rejected,unavailable}`. The runtime ticks
 * `accepted` on successful enqueue, `rejected` on validation errors,
 * and `unavailable` on connection / health failures.
 */
export function bumpTriggerSubmit(
  metrics: RunMetricsRegistry | undefined,
  outcome: 'accepted' | 'rejected' | 'unavailable',
): void {
  if (metrics) {
    metrics.inc(RUN_METRICS.TRIGGER_SUBMIT_TOTAL, { outcome })
    return
  }
  defaultRegistry.inc(RUN_METRICS.TRIGGER_SUBMIT_TOTAL, { outcome })
}

/**
 * Phase 5 §5.5 observability — durable IM intake and fan-out
 * (ADR-0008, ADR-0015). `bumpImIntakeDedup` ticks the dedup counter per
 * accepted delivery (`new` or `duplicate`); `bumpImSubscriberRetry`
 * ticks per subscriber attempt (`ok` or `fail`);
 * `bumpImSubscriberDeadLetter` ticks when a subscriber exhausts its
 * attempts (must page on-call); `setImSubscriberLag` sets the per-
 * subscriber lag gauge (in events). All accept an injectable registry
 * and fall back to the process-wide in-memory default.
 */
export function bumpImIntakeDedup(
  metrics: RunMetricsRegistry | undefined,
  result: 'new' | 'duplicate',
): void {
  const target = metrics ?? defaultRegistry
  target.inc(RUN_METRICS.IM_INTAKE_DEDUP_TOTAL, { result })
}

export function bumpImSubscriberRetry(
  metrics: RunMetricsRegistry | undefined,
  subscriber: string,
  outcome: 'ok' | 'fail',
): void {
  const target = metrics ?? defaultRegistry
  target.inc(RUN_METRICS.IM_SUBSCRIBER_RETRY_TOTAL, { subscriber, outcome })
}

export function bumpImSubscriberDeadLetter(
  metrics: RunMetricsRegistry | undefined,
  subscriber: string,
): void {
  const target = metrics ?? defaultRegistry
  target.inc(RUN_METRICS.IM_SUBSCRIBER_DEAD_LETTER_TOTAL, { subscriber })
}

export function setImSubscriberLag(
  metrics: RunMetricsRegistry | undefined,
  subscriber: string,
  lag: number,
): void {
  const target = metrics ?? defaultRegistry
  target.set(RUN_METRICS.IM_SUBSCRIBER_LAG, lag, { subscriber })
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