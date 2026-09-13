import { createHash, randomBytes } from 'node:crypto'
import type { UserOAuthTokens } from './user-model-credential-store.ts'

const CHATGPT_OAUTH_ISSUER = 'https://auth.openai.com'
const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CHATGPT_SCOPE = 'openid profile email offline_access'

const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CLAUDE_AUTHORIZE = 'https://claude.ai/oauth/authorize'
const CLAUDE_REDIRECT = 'https://platform.claude.com/oauth/code/callback'
const CLAUDE_SCOPE = 'org:create_api_key user:profile user:inference'

export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function codexOAuthJwtAccountIdFromToken(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.split('.').length !== 3) return undefined
  const part = value.split('.')[1]
  if (!part) return undefined
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
    const claims = (payload as Record<string, unknown>)['https://api.openai.com/auth']
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return undefined
    const accountId = (claims as Record<string, unknown>).chatgpt_account_id
    return typeof accountId === 'string' && accountId ? accountId : undefined
  } catch {
    return undefined
  }
}

function tokenExpiry(raw: { expires_in?: number; access_token?: string }): number | undefined {
  if (typeof raw.expires_in === 'number') return Date.now() + raw.expires_in * 1000
  const token = raw.access_token
  if (typeof token !== 'string' || token.split('.').length !== 3) return undefined
  const part = token.split('.')[1]
  if (!part) return undefined
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

export interface ClaudeAuthStart {
  authorizeUrl: string
  verifier: string
}

export interface SubscriptionOAuth {
  refreshChatGPTTokens(refreshToken: string): Promise<UserOAuthTokens>
  startClaudeLogin(): ClaudeAuthStart
  completeClaudeLogin(pastedCode: string, verifier: string): Promise<UserOAuthTokens>
  refreshClaudeTokens(refreshToken: string): Promise<UserOAuthTokens>
}

export interface SubscriptionOAuthOptions {
  claudeTokenUrl: string
  fetchImpl?: typeof fetch
}

export function createSubscriptionOAuth(options: SubscriptionOAuthOptions): SubscriptionOAuth {
  const { claudeTokenUrl, fetchImpl = fetch } = options

  async function postJson(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`subscription oauth request failed (${res.status})`)
    return (await res.json()) as Record<string, unknown>
  }

  function chatgptAccountId(tokens: { idToken?: string; accessToken?: string }): string | undefined {
    return codexOAuthJwtAccountIdFromToken(tokens.idToken) ?? codexOAuthJwtAccountIdFromToken(tokens.accessToken)
  }

  return {
    async refreshChatGPTTokens(refreshToken) {
      const raw = await postJson(`${CHATGPT_OAUTH_ISSUER}/oauth/token`, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CHATGPT_CLIENT_ID,
        scope: CHATGPT_SCOPE,
      })
      const accessToken = typeof raw.access_token === 'string' ? raw.access_token : undefined
      if (!accessToken) throw new Error('chatgpt refresh missing access_token')
      const idToken = typeof raw.id_token === 'string' ? raw.id_token : undefined
      const accountId = chatgptAccountId({ ...(idToken !== undefined ? { idToken } : {}), accessToken })
      const expiresAt = tokenExpiry(raw)
      return {
        accessToken,
        refreshToken: typeof raw.refresh_token === 'string' ? raw.refresh_token : refreshToken,
        ...(idToken !== undefined ? { idToken } : {}),
        ...(accountId !== undefined ? { accountId } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      }
    },

    startClaudeLogin() {
      const verifier = generateCodeVerifier()
      const challenge = codeChallengeS256(verifier)
      const url = new URL(CLAUDE_AUTHORIZE)
      url.searchParams.set('code', 'true')
      url.searchParams.set('client_id', CLAUDE_CLIENT_ID)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('redirect_uri', CLAUDE_REDIRECT)
      url.searchParams.set('scope', CLAUDE_SCOPE)
      url.searchParams.set('code_challenge', challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('state', verifier)
      return { authorizeUrl: url.toString(), verifier }
    },

    async completeClaudeLogin(pastedCode, verifier) {
      const [code, state] = pastedCode.trim().split('#')
      const raw = await postJson(claudeTokenUrl, {
        grant_type: 'authorization_code',
        client_id: CLAUDE_CLIENT_ID,
        code,
        state: state ?? verifier,
        code_verifier: verifier,
        redirect_uri: CLAUDE_REDIRECT,
      })
      const accessToken = typeof raw.access_token === 'string' ? raw.access_token : undefined
      if (!accessToken) throw new Error('claude token response missing access_token')
      const refreshToken = typeof raw.refresh_token === 'string' ? raw.refresh_token : undefined
      const expiresAt = tokenExpiry(raw)
      return {
        accessToken,
        ...(refreshToken !== undefined ? { refreshToken } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      }
    },

    async refreshClaudeTokens(refreshToken) {
      const raw = await postJson(claudeTokenUrl, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      })
      const accessToken = typeof raw.access_token === 'string' ? raw.access_token : undefined
      if (!accessToken) throw new Error('claude refresh missing access_token')
      const expiresAt = tokenExpiry(raw)
      return {
        accessToken,
        refreshToken: typeof raw.refresh_token === 'string' ? raw.refresh_token : refreshToken,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      }
    },
  }
}
