/**
 * Lane-A user model credentials: per-principal API keys and OAuth
 * connections (qm user-model-credentials contract).
 */
export type UserModelProvider = 'anthropic' | 'openai'

export interface UserConnection {
  provider: UserModelProvider
  kind: 'api-key' | 'oauth'
  connectedAt: number
}

export interface UserModelCredentialsStore {
  setApiKey(principalId: string, provider: UserModelProvider, apiKey: string): Promise<void>
  setOAuth(principalId: string, provider: UserModelProvider, token: Record<string, unknown>): Promise<void>
  delete(principalId: string, provider: UserModelProvider): Promise<void>
  connections(principalId: string): Promise<UserConnection[]>
}

export function createMemoryUserModelCredentialsStore(): UserModelCredentialsStore {
  const byPrincipal = new Map<string, Map<UserModelProvider, { kind: 'api-key' | 'oauth'; connectedAt: number }>>()
  return {
    async setApiKey(principalId, provider) {
      const map = byPrincipal.get(principalId) ?? new Map()
      map.set(provider, { kind: 'api-key', connectedAt: Date.now() })
      byPrincipal.set(principalId, map)
    },
    async setOAuth(principalId, provider) {
      const map = byPrincipal.get(principalId) ?? new Map()
      map.set(provider, { kind: 'oauth', connectedAt: Date.now() })
      byPrincipal.set(principalId, map)
    },
    async delete(principalId, provider) {
      byPrincipal.get(principalId)?.delete(provider)
    },
    async connections(principalId) {
      const map = byPrincipal.get(principalId)
      if (!map) return []
      return [...map.entries()].map(([provider, info]) => ({ provider, ...info }))
    },
  }
}
