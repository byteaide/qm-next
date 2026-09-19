/**
 * `@qm/security` — security posture resolution, screening rubric, and
 * screener-proxy client.
 *
 * The posture module is pure data: posture types, policy resolver,
 * composition across org-floor + scope override, the rubric and output
 * contract, the verdict parser, the payload assembler, and the rendered
 * policy prompt. The screener module owns the chunking, retry, and
 * reduction logic for a single security-screen call against a remote
 * proxy.
 */
export {
  composeSecurityPosture,
  DEFAULT_SECURITY_SCREEN_RUBRIC,
  parseSecurityPosture,
  parseSecurityScreenVerdict,
  renderSecurityPolicyPrompt,
  resolveSecurityPolicy,
  screenPayloadFromEnvelope,
  SECURITY_SCREEN_STEP,
  SECURITY_SCREEN_SYSTEM_PROMPT,
  SECURITY_POSTURES,
  securityScreenPayload,
  securityScreenSystemPrompt,
  UNSCREENED_PREFIX,
  UNSCREENED_REASON,
  unscreenedNotice,
  type ResolvedSecurityPolicy,
  type SecurityPosture,
  type SecurityScreenPayload,
  type SecurityScreenVerdict,
} from './security-posture.ts'
export {
  createSecurityScreenProxy,
  runShadowScreen,
  type SecurityScreenHook,
  type SecurityScreenProbe,
  type SecurityScreener,
} from './security-screener.ts'

/**
 * Slice 2.1 — Command Gate runtime. See `command-policy.ts` for the
 * rules-engine interface and the production configuration contract
 * (ADR-0002). The Baseline Policy is `default-denylist` /
 * `baseline-deny`; the operator-tightened alternative is `allowlist`.
 */
export {
  CommandPolicyNotConfigured,
  createCommandPolicyRegistry,
  type CommandPolicy,
  type CommandPolicyContext,
  type CommandPolicyRegistry,
} from './command-policy.ts'
export {
  createCommandGate,
  registerDefaultPolicies,
  type CreateCommandGateOptions,
} from './command-gate.ts'
export {
  BASELINE_DENY_POLICY_ID,
  DEFAULT_DENYLIST_POLICY_ID,
  classRequiresGate,
  createDefaultDenylistPolicy,
  createDefaultDenylistPolicyAlias,
} from './policies/default-denylist.ts'
export {
  ALLOWLIST_POLICY_ID,
  createAllowlistPolicy,
  type AllowlistPolicyOptions,
  type AllowlistRule,
} from './policies/allowlist.ts'