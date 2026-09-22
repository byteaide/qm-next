/**
 * `@qm/security` — security posture resolution, screening rubric, and
 * screener-proxy client.
 *
 * The posture module is pure data: posture types, policy resolver,
 * composition across org-floor + scope override, the rubric and output
 * contract, the verdict parser, the payload assembler, and the rendered
 * policy prompt. The screener module owns the chunking, retry, and
 * reduction logic for a single security-screen call against a remote
 * proxy. Phase 2 adds the Command Gate runtime (ADR-0002, plan §2.1).
 * Phase 3 adds the Security Screen Adapter (off/shadow/enforce) and the
 * Shadow Record store (ADR-0004, plan §3.2).
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
  configureProductionCommandPolicy,
  PRODUCTION_DEFAULT_POLICY_ID,
  QM_COMMAND_POLICY_ENV,
  type ConfigureProductionCommandPolicyOptions,
} from './command-policy-config.ts'
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
export {
  RULE_ENGINE_POLICY_ID,
  commandTextOf,
  createRuleEnginePolicy,
  type CreateRuleEnginePolicyOptions,
} from './policies/rule-engine.ts'

/**
 * Slice 3.2 — Security Screen Adapter (off/shadow/enforce modes) + the
 * Shadow Record store (ADR-0004, plan §3.2). Cutover to Enforce Mode
 * requires an explicit operator declaration; auto-escalation is forbidden.
 */
export {
  createMemoryShadowRecordStore,
  allocateShadowRecordId,
  type ShadowRecord,
  type ShadowRecordStore,
  type ShadowScreenMode,
  type ShadowScreenDecision,
  type MemoryShadowRecordStoreOptions,
} from './shadow-record-store.ts'
export {
  createSecurityScreenAdapter,
  SecurityScreenAdapterError,
  type ScreenAdapterOptions,
  type ScreenMode,
} from './screen-adapter.ts'
export {
  resolveScreenConfig,
  isScreenMode,
  parseScreenMode,
  SCREEN_MODE_VALUES,
  type SecurityScreenConfig,
  type ResolveScreenConfigOptions,
  type ScreenConfigResult,
  type ResolvedScreenConfig,
  type RejectedScreenConfig,
} from './screen-config.ts'
