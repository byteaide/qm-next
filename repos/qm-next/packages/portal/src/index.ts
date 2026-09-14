/**
 * @qm/portal — portal SSO control plane ported from qm `plugins/portal/`:
 * sealed session cookies, the OIDC authorization-code + PKCE client,
 * admin-login links and the in-process identity issuer for the admin console.
 */
export {
  ADMIN_LOGIN_SCRIPT,
  ADMIN_LOGIN_SCRIPT_HASH,
  openAdminLogin,
} from './admin-login.ts'
export {
  deriveKey,
  seal,
  open,
  openSession,
  openImpersonation,
  openTmp,
  setCookie,
  clearCookie,
  readCookie,
  randomToken,
  safeEqual,
  sanitizeReturnTo,
  type SessionClaims,
  type ImpersonationClaims,
  type TmpClaims,
  type CookieOpts,
} from './session.ts'
export {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserinfo,
  pkcePair,
  resolvePrincipal,
  verifyIdToken,
  type OidcConfig,
  type PrincipalRule,
  type TokenResponse,
} from './oidc.ts'
export {
  createPortalState,
  derivedCookieDomain,
  isLocalPortalUrl,
  isLoopbackAddress,
  nonAdminDeniedHtml,
  portalBootProblems,
  registerPortal,
  signInErrorHtml,
  type PortalDeps,
} from './portal-routes.ts'
