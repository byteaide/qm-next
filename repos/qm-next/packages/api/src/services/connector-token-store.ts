/**
 * Lane-A connector token store: per-host/per-principal OAuth tokens with
 * the qm status probe shape. The provider registry is empty in lane A
 * (deployment config lands with the real connectors integration), so
 * provider-keyed flows answer qm's unknown-provider errors while
 * host-keyed registration/status/revoke are fully functional.
 */
export type ConnectorAccountType = 'default' | 'personal' | 'org'

export const CONNECTOR_STATUS_ACCOUNT_TYPES: readonly ConnectorAccountType[] = ['default', 'personal', 'org']

export interface ConnectorToken {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  accountType: ConnectorAccountType
}

export interface OAuthTokenStatus {
  connected: boolean
  needsReconnect?: boolean
  lastError?: string
}

export interface ConnectorTokenStore {
  setConnectorToken(host: string, principalId: string, token: Omit<ConnectorToken, 'accountType'>, accountType?: ConnectorAccountType): Promise<void>
  connectorTokenStatus(host: string, principalId: string, accountType: ConnectorAccountType): Promise<OAuthTokenStatus>
  deleteConnectorToken(host: string, principalId: string, accountType: ConnectorAccountType): Promise<void>
}

export function createMemoryConnectorTokenStore(): ConnectorTokenStore {
  const tokens = new Map<string, ConnectorToken>()
  const key = (host: string, principalId: string, accountType: string) => `${accountType}:${principalId}@${host}`
  return {
    async setConnectorToken(host, principalId, token, accountType = 'default') {
      tokens.set(key(host, principalId, accountType), { ...token, accountType })
    },
    async connectorTokenStatus(host, principalId, accountType) {
      const token = tokens.get(key(host, principalId, accountType))
      if (!token) return { connected: false }
      if (token.expiresAt !== undefined && token.expiresAt <= Date.now()) {
        return token.refreshToken ? { connected: true, needsReconnect: true } : { connected: false, needsReconnect: true }
      }
      return { connected: true }
    },
    async deleteConnectorToken(host, principalId, accountType) {
      tokens.delete(key(host, principalId, accountType))
    },
  }
}
