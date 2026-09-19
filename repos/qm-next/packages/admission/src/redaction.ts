/**
 * Phase 3 — Secret-shaped redaction for Admission Records.
 *
 * Admission Records must not leak tokens, API keys, or bearer credentials
 * (ADR-0016 §3 lists Run Events, Observation, and Admission Records as
 * token-free surfaces). The scanner mirrors the Phase 1 run-event
 * redaction shape so operators see the same patterns across records.
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  // `Bearer …` / `Token …` / `Basic …`
  /(bearer|token|basic)\s+[a-zA-Z0-9._\-+/=]{16,}/gi,
  // Common API-key prefixes (Anthropic, OpenAI, GitHub, Google, Stripe, AWS, Slack).
  /\b(sk-[a-zA-Z0-9_\-]{16,}|sk-ant-[a-zA-Z0-9_\-]{16,}|sk-or-[a-zA-Z0-9_\-]{16,}|ghp_[a-zA-Z0-9]{16,}|gho_[a-zA-Z0-9]{16,}|AIza[a-zA-Z0-9_\-]{16,}|sk_live_[a-zA-Z0-9]{16,}|sk_test_[a-zA-Z0-9]{16,}|AKIA[A-Z0-9]{16}|xox[abprs]-[a-zA-Z0-9\-]{10,})\b/gi,
  // PEM blocks.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Long random base64 segments (>=40 chars) inside obvious credential contexts.
  /(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?[a-zA-Z0-9._\-+/=]{20,}["']?/gi,
]

const REDACTED = '[redacted-credential]'

export function redactSecrets(input: string): string {
  let out = input
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, REDACTED)
  }
  return out
}

export function redactAdmissionStageReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  return redactSecrets(reason)
}

export function redactAdmissionReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  return redactSecrets(reason)
}

export function redactExcerpt(excerpt: string | undefined): string | undefined {
  if (excerpt === undefined) return undefined
  return redactSecrets(excerpt)
}

/** Internal: exposed for tests. */
export const __testing__ = { TOKEN_PATTERNS, REDACTED }