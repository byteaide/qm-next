/**
 * `@qm/connectors` — connector core surfaces.
 *
 * `createBackgroundBroker` starts and reattaches to background
 * processes registered with `@qm/processes`; `createOAuthFlowStore`
 * and `createConsentLinkStore` keep round-trip state behind a fixed
 * `state` parameter; `createBrowserSessionStore` encrypts Playwright
 * storage states per principal; `encryptSecret`/`decryptSecret` plus
 * `deriveConnectorKey` provide the shared AES-256-GCM envelope used
 * by the connector client store.
 *
 * The connector client store itself stays out of this package: it
 * binds to the full `oauth.ts` resolver set (PROVIDERS, providers'
 * well-known endpoints, etc.) and is not portable until that lands.
 */
export {
  createBackgroundBroker,
  type BackgroundExecBroker,
  type BackgroundExecBrokerDeps,
  type BackgroundJobSummary,
  type BackgroundPollResult,
  type BackgroundStartResult,
  type BackgroundStopResult,
  type BackgroundWriteResult,
} from './background-exec-broker.ts'
export {
  createConsentLinkStore,
  type AccountType,
  type ConsentLinkRecord,
  type ConsentLinkStore,
} from './consent-link.ts'
export { createOAuthFlowStore, type OAuthFlow, type OAuthFlowStore } from './oauth-flow-store.ts'
export {
  createBrowserSessionStore,
  type BrowserSessionStore,
  type StoredBrowserSession,
} from './browser-session-store.ts'
export {
  decryptSecret,
  deriveConnectorKey,
  encryptSecret,
  type SecretKey,
} from './secret-envelope.ts'
export {
  createConnectorTokenVault,
  deriveConnectorTokenKeks,
  CONNECTOR_ACCOUNT_TYPES,
  type ConnectorAccountType,
  type ConnectorKek,
  type ConnectorTokenVault,
  type OpenedConnectorToken,
  type SealedConnectorToken,
  type TokenAuditEntry,
} from './token-vault.ts'
export {
  createConnectorOAuthService,
  defaultMockExchanger,
  defaultTokenExchanger,
  type CallbackOutcome,
  type ConnectorOAuthService,
  type ConnectorOAuthServiceOptions,
  type OAuthProviderSpec,
  type TokenExchangeResult,
  type TokenExchanger,
} from './oauth-flow-service.ts'