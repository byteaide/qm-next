/**
 * `@qm/security` — security posture resolution, screening rubric, and
 * screener-proxy client.
 *
 * The posture module is pure data: posture types, policy resolver,
 * composition across org-floor + scope override, the rubric and output
 * contract, the verdict parser, the payload assembler, and the rendered
 * policy prompt. The screener module owns the chunking, retry, and
 * reduction logic for a single security-screen call against a remote
 * proxy. Phase 3 adds the Security Screen Adapter (off/shadow/enforce)
 * and the Shadow Record store (ADR-0004, plan §3.2).
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