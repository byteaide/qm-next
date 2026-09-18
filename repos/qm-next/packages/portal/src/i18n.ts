/**
 * Portal page-copy vocabulary (i18n plan §4.4). The SPA writes a `qm.locale`
 * cookie on startup/toggle (web-ui app/src/i18n); portal pages resolve the
 * locale from that cookie, fall back to Accept-Language, then en. Only text
 * nodes are localized — the admin-login inline script stays byte-identical
 * (CSP sha256 hash), so its one embedded message remains English by design
 * (plan §4.5).
 */
import { readCookie } from './session.ts'

export type PortalLocale = 'en' | 'zh'

export const portalEn = {
  // shared card chrome
  details: 'Details',
  signIn: 'Sign in',
  // sign-in error page (/auth/callback failures)
  signInFailedTitle: 'Sign-in failed',
  signInFailedHeading: "We couldn't sign you in",
  signInFailedMsg: "Your sign-in didn't complete. This is usually temporary — trying again resolves most cases.",
  trySigningInAgain: 'Try signing in again',
  backToStart: 'Back to start',
  signInFailedHelp: "Still stuck? Make sure you're a member of the approved workspace, then contact your admin.",
  // non-admin denied page (/admin/ui gate)
  noAdminTitle: 'No admin access',
  noAdminHeading: "You don't have admin access",
  noAdminMsg: "The Admin area is limited to governance admins. Your account is signed in and verified — it just isn't granted admin rights.",
  signedInAs: 'Signed in as',
  noAdminGrantsNote: "Admin rights come from your organization's admin grants. If you need access, ask an existing admin to grant it.",
  backToSurfaces: 'Back to your surfaces',
  tryAgain: 'Try again',
  noAdminHelp: 'You can keep using every surface available to your account.',
  // admin-login link page (/auth/admin-login GET)
  adminLoginTitle: 'Admin sign-in',
  adminLoginHeading: 'Sign in as an administrator',
  adminLoginMsg: 'Only continue if you generated this link for your own admin account.',
  jsRequired: 'JavaScript is required to open this login link.',
  adminLoginHelp: 'This link expires after five minutes and can be used once. Generate another with qm admin-login.',
  // failure details (rendered under the "Details" block)
  idpReturned: 'identity provider returned: {detail}',
  loginSessionExpired: 'login session expired — please try again',
  invalidLoginState: 'invalid login state',
  loginAlreadyUsed: 'login already used — please try again',
  signInFailedGeneric: 'sign-in failed',
  adminLinkInvalid: 'This admin link is invalid, expired, or already used. Generate a new link with qm admin-login.',
  adminCheckFailed: 'Admin access could not be checked. Please try again.',
  accountNotAdmin: 'This account does not have admin access.',
} satisfies Record<string, string>

export type PortalKey = keyof typeof portalEn

export const portalZh: Record<PortalKey, string> = {
  details: '详细信息',
  signIn: '登录',
  signInFailedTitle: '登录失败',
  signInFailedHeading: '无法完成登录',
  signInFailedMsg: '登录未能完成。这通常是临时问题——重试即可解决大多数情况。',
  trySigningInAgain: '重新登录',
  backToStart: '返回首页',
  signInFailedHelp: '仍然无法登录？请确认你已加入获批的工作区，然后再联系管理员。',
  noAdminTitle: '无管理员权限',
  noAdminHeading: '你没有管理员权限',
  noAdminMsg: '管理区仅限治理管理员进入。你的账号已登录并通过验证，只是尚未被授予管理员权限。',
  signedInAs: '登录身份',
  noAdminGrantsNote: '管理员权限来自组织的管理员授权。如需访问，请找现有管理员为你授权。',
  backToSurfaces: '返回你的工作台',
  tryAgain: '重试',
  noAdminHelp: '你仍可继续使用账号权限内的所有功能。',
  adminLoginTitle: '管理员登录',
  adminLoginHeading: '以管理员身份登录',
  adminLoginMsg: '仅当你为本人管理员账号生成此链接时才可继续。',
  jsRequired: '打开此登录链接需要启用 JavaScript。',
  adminLoginHelp: '此链接五分钟后失效，且仅可使用一次。可用 qm admin-login 重新生成。',
  idpReturned: '身份提供方返回：{detail}',
  loginSessionExpired: '登录会话已过期，请重试',
  invalidLoginState: '登录状态无效',
  loginAlreadyUsed: '登录链接已被使用，请重试',
  signInFailedGeneric: '登录失败',
  adminLinkInvalid: '此管理员链接无效、已过期或已被使用。请用 qm admin-login 重新生成。',
  adminCheckFailed: '无法校验管理员权限，请重试。',
  accountNotAdmin: '该账号没有管理员权限。',
}

const TABLES: Record<PortalLocale, Record<PortalKey, string>> = { en: portalEn, zh: portalZh }

export function portalLang(locale: PortalLocale): string {
  return locale === 'zh' ? 'zh-CN' : 'en'
}

/** `{name}` placeholder interpolation, mirroring the web-ui t(). */
export function portalText(locale: PortalLocale, key: PortalKey, params?: Record<string, string>): string {
  let out = TABLES[locale][key]
  if (params) {
    out = out.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(params, name) ? (params[name] ?? match) : match))
  }
  return out
}

/** Accept-Language → locale: first zh/en prefix by q-value; anything else → en. */
export function localeFromAcceptLanguage(header: string | undefined): PortalLocale {
  if (!header) return 'en'
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';')
      let q = 1
      for (const param of params) {
        const m = param.trim().match(/^q=([0-9.]+)$/)
        if (m) {
          const v = Number.parseFloat(m[1] ?? '')
          if (Number.isFinite(v)) q = v
        }
      }
      return { tag: (tag ?? '').trim().toLowerCase(), q }
    })
    .sort((a, b) => b.q - a.q)
  for (const { tag } of ranked) {
    if (tag.startsWith('zh')) return 'zh'
    if (tag.startsWith('en')) return 'en'
  }
  return 'en'
}

/** Cookie beats Accept-Language beats en (plan §4.4 resolution order). */
export function resolvePortalLocale(cookieHeader: string | undefined, acceptLanguage: string | undefined): PortalLocale {
  const fromCookie = readCookie(cookieHeader, 'qm.locale')
  if (fromCookie === 'en' || fromCookie === 'zh') return fromCookie
  return localeFromAcceptLanguage(acceptLanguage)
}
