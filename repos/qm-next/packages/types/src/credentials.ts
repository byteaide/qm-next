/**
 * Credentials contract: P1 parity port of qm src/credentials/keychain.ts.
 *
 * The Keychain is the durable credential store: personal env/file
 * credentials, org service credentials (broker), connector OAuth tokens,
 * grants, and asks. Implementations live in @qm/credentials (memory + PG,
 * durable-by-default); consumers (harness auth, api routes, tools) program
 * against these shapes. Refresh tokens never leave a keychain record.
 */
import type { Destination } from './destination.ts'
import type { ScopeId } from './identity.ts'
import type { ProviderKeys } from './model.ts'

export type CredentialKind = 'env' | 'file' | 'broker'

export interface CredentialInjection {
  header?: string
  scheme?: string
}

export interface BrokerDelivery {
  name: string
  delivery?: 'broker' | 'env'
  envKey?: string
  injection?: CredentialInjection
  allowedMethods?: string[]
  allowedPathPrefixes?: string[]
  enabled: boolean
  updatedBy?: string
}

export interface CredentialRefresh {
  refreshTokenEnc?: string
  idTokenEnc?: string
  accountId?: string
  accountType?: string
  clientRef?: string
  grantedScopes?: string[]
  refreshFailedAt?: number
  refreshError?: string
  orgId?: string
}

export interface CredentialFile {
  path: string
  contentBase64: string
}

export interface CredentialFieldMeta {
  envKey: string
  secret: boolean
}

export interface CredentialFieldInput {
  envKey: string
  value: string
  secret?: boolean
}

export interface KeychainCredential {
  id: string
  ownerId: string
  orgId?: string
  service: string
  kind: CredentialKind
  envKey?: string
  target?: string
  targets?: string[]
  host?: string
  accountLabel?: string
  fields?: CredentialFieldMeta[]
  broker?: BrokerDelivery
  refresh?: CredentialRefresh
  managed?: 'connector'
  secretEnc: string
  fingerprint: string
  origin?: string
  expiresAt?: number
  createdAt: number
  updatedAt: number
}

export type KeychainCredentialMeta = Omit<KeychainCredential, 'secretEnc'>

export type GrantMode = 'once' | 'standing'

export interface KeychainGrant {
  id: string
  credentialId: string
  ownerId: string
  orgId?: string
  audienceScopeId: ScopeId
  mode: GrantMode
  purpose: string
  status: 'active' | 'revoked' | 'used'
  createdAt: number
  expiresAt?: number
  revokedAt?: number
  usedAt?: number
  usedBy?: string
  askId?: string
}

export type AskStatus = 'pending' | 'approved' | 'declined' | 'expired'

export interface KeychainAsk {
  id: string
  credentialId: string
  ownerId: string
  requesterId: string
  orgId?: string
  requesterScopeId: ScopeId
  requesterDestination?: Destination
  requesterThreadRef?: string
  purpose: string
  requestedMode?: GrantMode
  status: AskStatus
  createdAt: number
  expiresAt: number
  resolvedAt?: number
  grantId?: string
  note?: string
  notifiedAt?: number
}

export interface ServiceCredentialInput {
  slug: string
  name: string
  secret?: string
  delivery?: 'broker' | 'env'
  envKey?: string
  host: string
  injection?: CredentialInjection
  allowedMethods?: string[]
  allowedPathPrefixes?: string[]
  enabled?: boolean
  updatedBy?: string
}

export interface PublicServiceCredential {
  slug: string
  name: string
  delivery: 'broker' | 'env'
  envKey?: string
  host: string
  injection?: CredentialInjection
  allowedMethods?: string[]
  allowedPathPrefixes?: string[]
  enabled: boolean
  hasSecret: boolean
  updatedBy?: string
  updatedAt: number
}

export interface DecryptedServiceCredential {
  slug: string
  name: string
  secret: string
  delivery: 'broker' | 'env'
  envKey?: string
  host: string
  injection?: CredentialInjection
  allowedMethods?: string[]
  allowedPathPrefixes?: string[]
  enabled: boolean
}

export function isValidCredentialSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)
}

export function isValidServiceCredentialEnvKey(envKey: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(envKey) && !envKey.startsWith('AGENT_')
}

export interface ServiceCredentialReader {
  getServiceCredentialSecret(orgScopeId: ScopeId, slug: string): Promise<DecryptedServiceCredential | null>
}

export interface ServiceCredentialStore extends ServiceCredentialReader {
  setServiceCredential(orgScopeId: ScopeId, input: ServiceCredentialInput): Promise<void>
  setServiceCredentialIfAbsent(orgScopeId: ScopeId, input: ServiceCredentialInput): Promise<number | null>
  setServiceCredentialIfCurrent(
    orgScopeId: ScopeId,
    input: ServiceCredentialInput,
    expectedUpdatedAt: number,
  ): Promise<number | null>
  listServiceCredentials(orgScopeId: ScopeId): Promise<PublicServiceCredential[]>
  deleteServiceCredential(orgScopeId: ScopeId, slug: string): Promise<void>
  deleteServiceCredentialIfCurrent(orgScopeId: ScopeId, slug: string, expectedUpdatedAt: number): Promise<boolean>
}

export interface OAuthToken {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  grantedScopes?: string[]
  clientRef?: string
  accountType?: string
  orgId?: string
  idToken?: string
  accountId?: string
}

export interface DerivedOAuthAuth {
  accessToken: string
  idToken?: string
  accountId?: string
  expiresAt?: number
}

export interface OAuthTokenStatus {
  connected: boolean
  expiresAt?: number
  hasRefreshToken?: boolean
  needsReconnect?: boolean
  refreshFailedAt?: number
  refreshError?: string
  accountType?: string
  grantedScopes?: string[]
}

export type OAuthRefresh = (
  host: string,
  token: OAuthToken,
  ctx?: { accountType?: string; clientRef?: string },
) => Promise<OAuthToken>

export interface ConnectorMeta {
  credentialId: string
  ownerId: string
  host: string
  accountType?: string
  expiresAt?: number
  connected: boolean
  needsReconnect?: boolean
}

export interface ConnectorTokenStore {
  setConnectorToken(host: string, principalId: string, token: OAuthToken, accountType?: string): Promise<void>
  deleteConnectorToken(host: string, principalId: string, accountType?: string): Promise<void>
  connectorTokenStatus(host: string, principalId: string, accountType?: string): Promise<OAuthTokenStatus>
  connectorAccessToken(host: string, principalId: string, accountType?: string): Promise<string | null>
  connectorDerivedAuth(host: string, principalId: string, accountType?: string): Promise<DerivedOAuthAuth | null>
}

export interface MaterializedEnvCred {
  credentialId: string
  ownerId: string
  service: string
  env: Array<{ key: string; value: string }>
  grantId?: string
  purpose?: string
}

export interface MaterializedFileCred {
  credentialId: string
  ownerId: string
  service: string
  files: CredentialFile[]
  origin?: string
  grantId?: string
  purpose?: string
}

export type MaterializedCred =
  | ({ kind: 'env' } & MaterializedEnvCred)
  | ({ kind: 'file' } & MaterializedFileCred)

export class KeychainError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'KeychainError'
    this.status = status
  }
}

export interface SaveCredentialInput {
  ownerId: string
  service: string
  secret?: string
  envKey?: string
  fields?: CredentialFieldInput[]
  target?: string
  files?: CredentialFile[]
  host?: string
  accountLabel?: string
  origin?: string
  expiresAt?: number
}

export interface CreateGrantInput {
  credentialId: string
  ownerId: string
  audienceScopeId: ScopeId
  mode: GrantMode
  purpose: string
  expiresAt?: number
  askId?: string
}

export interface CreateAskInput {
  credentialId: string
  requesterId: string
  requesterScopeId: ScopeId
  requesterDestination?: Destination
  requesterThreadRef?: string
  purpose: string
  requestedMode?: GrantMode
  expiresAt?: number
}

export interface ApproveAskInput {
  askId: string
  ownerId: string
  mode: GrantMode
  purpose: string
  expiresAt?: number
}

export interface AskListFilter {
  requesterId?: string
  ownerId?: string
  requesterScopeId?: ScopeId
}

export interface GrantListFilter {
  ownerId?: string
  audienceScopeId?: ScopeId
}

export interface Keychain extends ServiceCredentialStore, ConnectorTokenStore {
  save(input: SaveCredentialInput): Promise<KeychainCredentialMeta>
  listAllMetadata(): Promise<KeychainCredentialMeta[]>
  listByOwner(ownerId: string): Promise<KeychainCredentialMeta[]>
  listByOwners(ownerIds: string[]): Promise<Map<string, KeychainCredentialMeta[]>>
  listConnectorsByOwners(ownerIds: string[]): Promise<Map<string, ConnectorMeta[]>>
  getCredential(id: string): Promise<KeychainCredentialMeta | null>
  readOwnSecret(ownerId: string, credentialId: string): Promise<string | null>
  remove(ownerId: string, id: string): Promise<boolean>

  createGrant(input: CreateGrantInput): Promise<KeychainGrant>
  grantConnectorToScope(input: {
    host: string
    principalId: string
    accountType?: string
    audienceScopeId: ScopeId
    purpose: string
  }): Promise<KeychainGrant | null>
  getGrant(id: string): Promise<KeychainGrant | null>
  listGrants(filter: GrantListFilter): Promise<KeychainGrant[]>
  revokeGrant(ownerId: string, grantId: string): Promise<boolean>
  grantsForScope(scopeId: ScopeId): Promise<Array<{ grant: KeychainGrant; credential: KeychainCredentialMeta }>>

  createAsk(input: CreateAskInput): Promise<{ ask: KeychainAsk; existing: boolean }>
  getAsk(id: string): Promise<KeychainAsk | null>
  listAsks(filter: AskListFilter): Promise<KeychainAsk[]>
  approveAsk(input: ApproveAskInput): Promise<{ ask: KeychainAsk; grant: KeychainGrant }>
  declineAsk(input: { askId: string; ownerId: string; note?: string }): Promise<KeychainAsk>
  unnotifiedResolvedAsks(now: number): Promise<KeychainAsk[]>
  markAskNotified(id: string): Promise<void>
  resolveAsksForGrant(grant: KeychainGrant): Promise<KeychainAsk[]>

  materialize(grantId: string, scopeId: ScopeId, usedBy: string): Promise<MaterializedCred>
  materializeOwnById(ownerId: string, credentialId: string, scopeId: ScopeId): Promise<MaterializedCred>
  materializeOwn(ownerId: string): Promise<MaterializedEnvCred[]>
  materializeOwnFiles(ownerId: string): Promise<MaterializedFileCred[]>

  materializeStanding(scopeId: ScopeId): Promise<MaterializedEnvCred[]>
}

export type HarnessAuthEnvFactory = () => Promise<Record<string, string>>

export interface CredentialResolver {
  keychain: Keychain
  resolveProviderKeys(): Promise<ProviderKeys>
  harnessAuthEnv(credentialId: string, allowedEnvKeys: readonly string[]): HarnessAuthEnvFactory
}
