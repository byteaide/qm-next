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