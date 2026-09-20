/**
 * Connector token store port (api surface, plan §Phase 6 slice 4):
 * routes persist and probe connector tokens through this interface;
 * composition (service.ts) wires the vault-backed implementation
 * (ADR-0017 envelope encryption, durable by default) instead of a
 * process-local Map. Account types are owned by @qm/connectors.
 */
import { createMemoryMap } from '@qm/store'
import {
  createConsentLinkStore,
  createConnectorOAuthService,
  createConnectorTokenVault,
  createOAuthFlowStore,
  deriveConnectorTokenKeks,
  type ConnectorOAuthService,
  type OAuthProviderSpec,
} from '@qm/connectors'
import { CONNECTOR_ACCOUNT_TYPES } from '@qm/connectors'
import type { ConnectorAccountType, ConnectorTokenVault } from '@qm/connectors'

export type { ConnectorAccountType }

export const CONNECTOR_STATUS_ACCOUNT_TYPES: readonly ConnectorAccountType[] = CONNECTOR_ACCOUNT_TYPES

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

/**
 * Phase 6 (ADR-0009/0017): token persistence lives in the Connector
 * vault — sealed with the AES-256-GCM envelope before any durable
 * write, decrypted only for short-lived provider calls. The api-side
 * port is a thin adapter over the vault.
 */
export function createVaultConnectorTokenStore(vault: ConnectorTokenVault): ConnectorTokenStore {
  return {
    async setConnectorToken(host, principalId, token, accountType = 'default') {
      await vault.seal({
        host,
        principalId,
        accessToken: token.accessToken,
        ...(token.refreshToken !== undefined ? { refreshToken: token.refreshToken } : {}),
        ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
        accountType,
      })
    },
    async connectorTokenStatus(host, principalId, accountType) {
      return vault.status(host, principalId, accountType)
    },
    async deleteConnectorToken(host, principalId, accountType) {
      await vault.delete(host, principalId, accountType)
    },
  }
}

/**
 * Memory-backed connector surface over the Connector-owned OAuth
 * service (Phase 6 composition shape). Tests and memory-mode
 * deployments inject this as the `connectors` dep; production
 * composition (service.ts) builds the same shape over Postgres maps.
 */
export function createMemoryConnectorSurface(
  providers: readonly OAuthProviderSpec[] = [],
): { tokens: ConnectorTokenStore; oauth: ConnectorOAuthService } {
  const vault = createConnectorTokenVault({
    backing: createMemoryMap(),
    keks: deriveConnectorTokenKeks(['memory-surface-master']),
  })
  return {
    tokens: createVaultConnectorTokenStore(vault),
    oauth: createConnectorOAuthService({
      flows: createOAuthFlowStore(createMemoryMap()),
      consentLinks: createConsentLinkStore(createMemoryMap()),
      vault,
      providers,
    }),
  }
}
