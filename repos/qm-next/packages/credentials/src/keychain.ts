/**
 * Keychain: the durable credential store — personal env/file credentials,
 * org service credentials (broker), connector OAuth tokens with single-
 * flight refresh and compare-and-set rotation, grants, and asks.
 * Faithful translation of qm's createKeychain onto @qm/types contracts and
 * @qm/store DurableMap; org identity is injected instead of read from a
 * global config.
 */
import { randomBytes } from 'node:crypto'
import type { DurableMap } from '@qm/store'
import {
  isValidServiceCredentialEnvKey,
  KeychainError,
  personalScope,
  type ConnectorMeta,
  type CreateGrantInput,
  type CredentialFile,
  type CredentialKind,
  type Keychain,
  type KeychainAsk,
  type KeychainCredential,
  type KeychainCredentialMeta,
  type KeychainGrant,
  type MaterializedCred,
  type MaterializedEnvCred,
  type MaterializedFileCred,
  type OAuthRefresh,
  type OAuthToken,
  type PublicServiceCredential,
  type SaveCredentialInput,
  type ScopeId,
  type ServiceCredentialInput,
} from '@qm/types'
import { decryptSecret, encryptSecret, type SecretKey } from './secret-cipher.ts'
import { personKey, samePerson } from './person.ts'
import { hashId } from './crypto.ts'
import { homeRelativePath } from './paths.ts'
import { envKey } from './connector-token.ts'
import { shq } from './shell.ts'
import { errMessage } from './errors.ts'

export const ASK_TTL_MS = 24 * 60 * 60_000
export const ASK_PRUNE_AFTER_MS = 14 * 24 * 60 * 60_000

export function fileCredentialFingerprint(files: CredentialFile[]): string {
  return hashId([JSON.stringify(files.map((f) => ({ ...f, path: homeRelativePath(f.path) })))])
}

function fingerprintOf(secret: string): string {
  return hashId([secret])
}

function credId(ownerId: string, service: string, slot: string): string {
  return hashId([ownerId, service, slot])
}

function defaultEnvKey(service: string): string {
  return `${service.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TOKEN`
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function legacyUsernameEnvKey(passwordEnvKey: string): string {
  const base = passwordEnvKey.replace(/_(PASSWORD|PASS|TOKEN|SECRET|API_KEY|KEY)$/i, '')
  return `${base || passwordEnvKey}_USERNAME`
}

function expired(rec: { expiresAt?: number }, now: number): boolean {
  return typeof rec.expiresAt === 'number' && rec.expiresAt < now
}

function credExpired(rec: { kind: CredentialKind; expiresAt?: number }, now: number): boolean {
  return rec.kind !== 'file' && expired(rec, now)
}

function toMeta(rec: KeychainCredential): KeychainCredentialMeta {
  const { secretEnc: _, ...meta } = rec
  return meta
}

function bucketByOwner<T>(
  creds: Iterable<KeychainCredential>,
  ownerIds: string[],
  include: (c: KeychainCredential) => boolean,
  item: (c: KeychainCredential) => T,
): Map<string, T[]> {
  const byKey = new Map(ownerIds.map((id) => [personKey(id), id]))
  const out = new Map<string, T[]>()
  for (const c of creds) {
    if (!include(c)) continue
    const owner = byKey.get(personKey(c.ownerId))
    if (owner === undefined) continue
    const list = out.get(owner) ?? []
    list.push(item(c))
    out.set(owner, list)
  }
  return out
}

export function createKeychain(deps: {
  creds: DurableMap<KeychainCredential>
  grants: DurableMap<KeychainGrant>
  asks: DurableMap<KeychainAsk>
  key: SecretKey
  refreshConnector?: OAuthRefresh
  oauthSkewMs?: number
  oauthRefreshMarginMs?: number
  now?: () => number
  orgId?: () => string
}): Keychain {
  const now = deps.now ?? Date.now
  const oauthSkew = deps.oauthSkewMs ?? 60_000
  const oauthRefreshMargin = Math.max(deps.oauthRefreshMarginMs ?? 10 * 60_000, oauthSkew)
  const orgIdOf = () => deps.orgId?.()

  async function getOwned(ownerId: string, id: string): Promise<KeychainCredential | null> {
    const rec = await deps.creds.get(id)
    return rec && samePerson(rec.ownerId, ownerId) ? rec : null
  }

  function decryptToEnv(rec: KeychainCredential, extra?: { grantId: string; purpose: string }): MaterializedEnvCred {
    const raw = decryptSecret(rec.secretEnc, deps.key)
    let env: Array<{ key: string; value: string }>
    if (rec.fields) {
      const values = JSON.parse(raw) as Record<string, string>
      env = rec.fields.map((f) => ({ key: f.envKey, value: values[f.envKey] ?? '' }))
    } else {
      const envKey = rec.envKey ?? defaultEnvKey(rec.service)
      env = [{ key: envKey, value: raw }]
      const legacyUsername = (rec as { username?: string }).username
      if (legacyUsername) env.push({ key: legacyUsernameEnvKey(envKey), value: legacyUsername })
    }
    return {
      credentialId: rec.id,
      ownerId: rec.ownerId,
      service: rec.service,
      env,
      ...extra,
    }
  }

  function decryptToFiles(rec: KeychainCredential, extra?: { grantId: string; purpose: string }): MaterializedFileCred {
    const raw = decryptSecret(rec.secretEnc, deps.key)
    const files: CredentialFile[] = rec.targets
      ? (JSON.parse(raw) as CredentialFile[])
      : [{ path: homeRelativePath(rec.target ?? ''), contentBase64: Buffer.from(raw, 'utf8').toString('base64') }]
    return {
      credentialId: rec.id,
      ownerId: rec.ownerId,
      service: rec.service,
      files,
      ...(rec.origin ? { origin: rec.origin } : {}),
      ...extra,
    }
  }

  function tryDecrypt<T>(rec: KeychainCredential, fn: (rec: KeychainCredential) => T): T | null {
    try {
      return fn(rec)
    } catch (err) {
      console.error(
        `[keychain] credential ${rec.id} (${rec.service}, owner ${rec.ownerId}) does not decrypt under the current key — skipped: ${errMessage(err)}`,
      )
      return null
    }
  }

  async function activeGrantsFor(scopeId: ScopeId): Promise<KeychainGrant[]> {
    const t = now()
    return (await deps.grants.all()).filter(
      (g) => g.audienceScopeId === scopeId && g.status === 'active' && !expired(g, t),
    )
  }

  async function freshAsk(rec: KeychainAsk, t: number): Promise<KeychainAsk> {
    if (rec.status !== 'pending' || rec.expiresAt >= t) return rec
    const patch = { status: 'expired' as const, resolvedAt: t }
    await deps.asks.merge(rec.id, patch)
    return { ...rec, ...patch }
  }

  const brokerId = (orgScopeId: string, slug: string) => credId(orgScopeId, slug, 'broker')
  const orgIdOfScope = (orgScopeId: string) => orgScopeId.replace(/^org:/, '')

  function brokerToPublic(rec: KeychainCredential): PublicServiceCredential {
    const b = rec.broker ?? { name: rec.service, enabled: true }
    return {
      slug: rec.service,
      name: b.name,
      delivery: b.delivery ?? 'broker',
      ...(b.envKey ? { envKey: b.envKey } : {}),
      host: rec.host ?? '',
      ...(b.injection ? { injection: b.injection } : {}),
      ...(b.allowedMethods ? { allowedMethods: b.allowedMethods } : {}),
      ...(b.allowedPathPrefixes ? { allowedPathPrefixes: b.allowedPathPrefixes } : {}),
      enabled: b.enabled,
      hasSecret: Boolean(rec.secretEnc),
      ...(b.updatedBy ? { updatedBy: b.updatedBy } : {}),
      updatedAt: rec.updatedAt,
    }
  }

  async function brokerRecord(orgScopeId: string, slug: string): Promise<KeychainCredential | null> {
    return deps.creds.get(brokerId(orgScopeId, slug))
  }

  function serviceCredentialRecord(
    orgScopeId: string,
    input: ServiceCredentialInput,
    prior: KeychainCredential | null,
  ): KeychainCredential {
    const trimmedSecret = input.secret?.trim()
    const t = Math.max(now(), (prior?.updatedAt ?? 0) + 1)
    const delivery = input.delivery ?? 'broker'
    if (delivery === 'env') {
      if (!input.envKey || !isValidServiceCredentialEnvKey(input.envKey)) {
        throw new Error(
          `env-delivery credential ${input.slug} needs an UPPER_SNAKE_CASE envKey outside AGENT_* (got ${JSON.stringify(input.envKey ?? null)})`,
        )
      }
    } else if (input.envKey) {
      throw new Error(`broker-delivery credential ${input.slug} must not carry an envKey`)
    }
    return {
      id: brokerId(orgScopeId, input.slug),
      ownerId: orgScopeId,
      orgId: orgIdOfScope(orgScopeId),
      service: input.slug,
      kind: 'broker',
      host: input.host,
      broker: {
        name: input.name,
        ...(delivery === 'env' ? { delivery, envKey: input.envKey! } : {}),
        ...(input.injection ? { injection: input.injection } : {}),
        ...(input.allowedMethods ? { allowedMethods: input.allowedMethods.map((m) => m.toUpperCase()) } : {}),
        ...(input.allowedPathPrefixes ? { allowedPathPrefixes: input.allowedPathPrefixes } : {}),
        enabled: input.enabled !== false,
        ...(input.updatedBy ? { updatedBy: input.updatedBy } : {}),
      },
      secretEnc: trimmedSecret ? encryptSecret(trimmedSecret, deps.key) : (prior?.secretEnc ?? ''),
      fingerprint: trimmedSecret ? fingerprintOf(trimmedSecret) : (prior?.fingerprint ?? ''),
      createdAt: prior?.createdAt ?? t,
      updatedAt: t,
    }
  }

  const oauthSlot = (accountType?: string) => `oauth:${accountType && accountType !== 'default' ? accountType : ''}`
  const oauthId = (host: string, principalId: string, accountType?: string) =>
    credId(principalId, host.toLowerCase(), oauthSlot(accountType))
  const inflightRefreshes = new Map<string, Promise<string | null>>()

  async function putConnectorToken(
    host: string,
    principalId: string,
    token: OAuthToken,
    accountType?: string,
  ): Promise<KeychainCredential> {
    const t = now()
    const id = oauthId(host, principalId, accountType)
    const prior = await deps.creds.get(id)
    const at = token.accountType ?? accountType
    const recOrgId = token.orgId ?? orgIdOf()
    const rec: KeychainCredential = {
      id,
      ownerId: principalId,
      ...(recOrgId !== undefined ? { orgId: recOrgId } : {}),
      service: host.toLowerCase(),
      kind: 'env',
      host: host.toLowerCase(),
      managed: 'connector',
      secretEnc: encryptSecret(token.accessToken, deps.key),
      fingerprint: fingerprintOf(token.accessToken),
      origin: 'connector-oauth',
      ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
      refresh: {
        ...(token.refreshToken ? { refreshTokenEnc: encryptSecret(token.refreshToken, deps.key) } : {}),
        ...(token.idToken ? { idTokenEnc: encryptSecret(token.idToken, deps.key) } : {}),
        ...(token.accountId ? { accountId: token.accountId } : {}),
        ...(at ? { accountType: at } : {}),
        ...(token.clientRef ? { clientRef: token.clientRef } : {}),
        ...(token.grantedScopes ? { grantedScopes: token.grantedScopes } : {}),
        ...(token.orgId ? { orgId: token.orgId } : {}),
      },
      createdAt: prior?.createdAt ?? t,
      updatedAt: t,
    }
    await deps.creds.put(id, rec)
    return rec
  }

  async function connectorRecord(
    host: string,
    principalId: string,
    accountType?: string,
  ): Promise<KeychainCredential | null> {
    return deps.creds.get(oauthId(host, principalId, accountType))
  }

  function recToOAuthToken(rec: KeychainCredential): OAuthToken {
    return {
      accessToken: decryptSecret(rec.secretEnc, deps.key),
      ...(rec.refresh?.refreshTokenEnc ? { refreshToken: decryptSecret(rec.refresh.refreshTokenEnc, deps.key) } : {}),
      ...(rec.refresh?.idTokenEnc ? { idToken: decryptSecret(rec.refresh.idTokenEnc, deps.key) } : {}),
      ...(rec.refresh?.accountId ? { accountId: rec.refresh.accountId } : {}),
      ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}),
      ...(rec.refresh?.grantedScopes ? { grantedScopes: rec.refresh.grantedScopes } : {}),
      ...(rec.refresh?.clientRef ? { clientRef: rec.refresh.clientRef } : {}),
      ...(rec.refresh?.accountType ? { accountType: rec.refresh.accountType } : {}),
      ...(rec.refresh?.orgId ? { orgId: rec.refresh.orgId } : {}),
    }
  }

  function storedRefreshError(e: unknown): string {
    const msg = errMessage(e).replace(/\s+/g, ' ').trim()
    return msg.length > 500 ? `${msg.slice(0, 497)}...` : msg
  }

  async function markConnectorRefreshFailure(rec: KeychainCredential, message: string): Promise<void> {
    const t = now()
    const current = await deps.creds.get(rec.id)
    if (!current || current.updatedAt !== rec.updatedAt || current.fingerprint !== rec.fingerprint) return
    await deps.creds.merge(rec.id, {
      refresh: { ...current.refresh, refreshFailedAt: t, refreshError: message },
      updatedAt: t,
    })
  }

  async function refreshAndStore(
    host: string,
    principalId: string,
    accountType: string | undefined,
    rec: KeychainCredential,
  ): Promise<string | null> {
    if (!deps.refreshConnector) return null
    const stored = tryDecrypt(rec, recToOAuthToken)
    if (!stored) return null
    try {
      const fresh = await deps.refreshConnector(host, stored, {
        ...(stored.accountType ? { accountType: stored.accountType } : {}),
        ...(stored.clientRef ? { clientRef: stored.clientRef } : {}),
      })
      if (!fresh.accessToken) throw new Error('refresh returned an empty access token')
      const merged: OAuthToken = {
        ...(stored.clientRef ? { clientRef: stored.clientRef } : {}),
        ...(stored.accountType ? { accountType: stored.accountType } : {}),
        ...(stored.orgId ? { orgId: stored.orgId } : {}),
        ...(stored.idToken ? { idToken: stored.idToken } : {}),
        ...(stored.accountId ? { accountId: stored.accountId } : {}),
        ...fresh,
      }
      const current = await deps.creds.get(rec.id)
      if (current && (current.updatedAt !== rec.updatedAt || current.fingerprint !== rec.fingerprint)) {
        const latest = tryDecrypt(current, recToOAuthToken)
        return latest?.accessToken ?? null
      }
      await putConnectorToken(host, principalId, merged, accountType)
      return merged.accessToken
    } catch (e) {
      const message = storedRefreshError(e)
      console.error(`[keychain] connector token refresh failed for ${host}: ${message}`)
      try {
        await markConnectorRefreshFailure(rec, message)
      } catch (writeErr) {
        console.error(
          `[keychain] connector token refresh failure metadata write failed for ${host}: ${errMessage(writeErr)}`,
        )
      }
      return null
    }
  }

  const oauthExpired = (rec: KeychainCredential, t: number) =>
    rec.expiresAt !== undefined && t >= rec.expiresAt - oauthSkew

  async function connectorTokenForRecord(rec: KeychainCredential): Promise<string | null> {
    const t = now()
    const refreshable = rec.refresh?.refreshTokenEnc && deps.refreshConnector && rec.host ? rec.host : null
    if (refreshable && rec.expiresAt !== undefined && t >= rec.expiresAt - oauthRefreshMargin) {
      let pending = inflightRefreshes.get(rec.id)
      if (!pending) {
        pending = refreshAndStore(refreshable, rec.ownerId, rec.refresh?.accountType, rec)
        inflightRefreshes.set(rec.id, pending)
        void pending.finally(() => inflightRefreshes.delete(rec.id))
      }
      return pending
    }
    if (oauthExpired(rec, t) && !refreshable) return null
    return tryDecrypt(rec, (r) => decryptSecret(r.secretEnc, deps.key))
  }

  function connectorMeta(rec: KeychainCredential, t: number): ConnectorMeta {
    const hasRefresh = !!rec.refresh?.refreshTokenEnc
    const refreshFailed = typeof rec.refresh?.refreshFailedAt === 'number'
    const tokenExpired = oauthExpired(rec, t)
    return {
      credentialId: rec.id,
      ownerId: rec.ownerId,
      host: rec.host ?? rec.service,
      ...(rec.refresh?.accountType ? { accountType: rec.refresh.accountType } : {}),
      ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}),
      connected: true,
      ...(tokenExpired && (!hasRefresh || refreshFailed) ? { needsReconnect: true } : {}),
    }
  }

  async function saveCredential(input: SaveCredentialInput): Promise<KeychainCredentialMeta> {
    const service = input.service.trim().toLowerCase()
    if (!service) throw new KeychainError(400, 'service required')
    let files: CredentialFile[] | undefined
    if (input.files?.length) {
      files = input.files.map((f) => ({ ...f, path: homeRelativePath(f.path) }))
    } else if (input.target && input.secret) {
      files = [
        {
          path: homeRelativePath(input.target),
          contentBase64: Buffer.from(input.secret, 'utf8').toString('base64'),
        },
      ]
    }
    const kind: CredentialKind = files ? 'file' : 'env'
    const fields =
      !files && input.fields?.length
        ? input.fields.map((f) => ({ envKey: f.envKey.trim(), value: f.value, secret: f.secret !== false }))
        : undefined
    if (fields) {
      if (fields.some((f) => !ENV_KEY_RE.test(f.envKey)))
        throw new KeychainError(400, 'each credential field needs a valid environment-variable envKey')
      if (fields.some((f) => !f.value || !f.value.trim()))
        throw new KeychainError(400, 'each credential field needs a value')
      if (new Set(fields.map((f) => f.envKey)).size !== fields.length)
        throw new KeychainError(400, 'credential field envKeys must be unique')
    }
    let secret: string | undefined
    if (files) secret = JSON.stringify(files)
    else if (fields) secret = JSON.stringify(Object.fromEntries(fields.map((f) => [f.envKey, f.value])))
    else secret = input.secret
    if (!secret || !secret.trim()) throw new KeychainError(400, 'empty secret')
    const envKey = kind === 'env' && !fields ? input.envKey?.trim() || defaultEnvKey(service) : undefined
    if (envKey && !ENV_KEY_RE.test(envKey)) throw new KeychainError(400, 'envKey must be a valid environment-variable name')
    const fieldsMeta = fields?.map((f) => ({ envKey: f.envKey, secret: f.secret !== false }))
    const targets = files?.map((f) => f.path)
    const t = now()
    let slot = `env:${envKey}`
    if (kind === 'file') slot = 'file'
    else if (fields)
      slot = `env:${fields
        .map((f) => f.envKey)
        .sort()
        .join(',')}`
    const id = credId(input.ownerId, service, slot)
    const prior = await deps.creds.get(id)
    const recOrgId = orgIdOf()
    const rec: KeychainCredential = {
      id,
      ownerId: input.ownerId,
      ...(recOrgId !== undefined ? { orgId: recOrgId } : {}),
      service,
      kind,
      ...(envKey ? { envKey } : {}),
      ...(fieldsMeta ? { fields: fieldsMeta } : {}),
      ...(targets ? { targets } : {}),
      ...(input.host ? { host: input.host } : {}),
      ...(input.accountLabel ? { accountLabel: input.accountLabel } : {}),
      secretEnc: encryptSecret(secret, deps.key),
      fingerprint: fingerprintOf(secret),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      createdAt: prior?.createdAt ?? t,
      updatedAt: t,
    }
    await deps.creds.put(id, rec)
    return toMeta(rec)
  }

  async function materializeConnectorEnv(
    cred: KeychainCredential,
    extra?: { grantId: string; purpose: string },
  ): Promise<MaterializedCred> {
    const value = cred.host ? await connectorTokenForRecord(cred) : null
    if (!value || !cred.host) {
      throw new KeychainError(
        410,
        'connector token expired and could not be refreshed — its owner must reconnect the app',
      )
    }
    return {
      kind: 'env',
      credentialId: cred.id,
      ownerId: cred.ownerId,
      service: cred.service,
      env: [{ key: envKey(cred.host), value }],
      ...extra,
    }
  }

  function materializeDecrypted(
    cred: KeychainCredential,
    extra?: { grantId: string; purpose: string },
  ): MaterializedCred {
    const materialized = tryDecrypt(cred, (c) =>
      c.kind === 'file'
        ? { kind: 'file' as const, ...decryptToFiles(c, extra) }
        : { kind: 'env' as const, ...decryptToEnv(c, extra) },
    )
    if (!materialized) {
      throw new KeychainError(422, 'credential does not decrypt under the current key')
    }
    return materialized
  }

  async function claimOnceGrant(grant: KeychainGrant, scopeId: ScopeId, usedBy: string): Promise<void> {
    if (grant.mode !== 'once') return
    if (!deps.grants.update) throw new KeychainError(503, 'grant store does not support atomic one-time use')
    const usedAt = now()
    const claimed = await deps.grants.update(grant.id, (current) => {
      if (current.audienceScopeId !== scopeId) throw new KeychainError(403, 'grant is for a different conversation')
      if (current.status === 'revoked') throw new KeychainError(410, 'grant was revoked')
      if (current.status === 'used') throw new KeychainError(410, 'one-time grant already used')
      if (expired(current, usedAt)) throw new KeychainError(410, 'grant is expired')
      return { ...current, status: 'used', usedAt, usedBy }
    })
    if (!claimed) throw new KeychainError(404, 'unknown grant')
  }

  async function mintGrant(input: CreateGrantInput): Promise<KeychainGrant> {
    const cred = await deps.creds.get(input.credentialId)
    if (!cred) throw new KeychainError(404, 'unknown credential')
    if (cred.kind === 'broker') {
      throw new KeychainError(400, 'broker credentials are org-owned and used via the credential broker, not grants')
    }
    if (!samePerson(cred.ownerId, input.ownerId)) {
      throw new KeychainError(
        403,
        'only the credential\'s owner can grant it — and only on a turn the owner themself sent',
      )
    }
    const purpose = input.purpose.trim()
    if (!purpose) throw new KeychainError(400, 'purpose required — record the owner\'s approval verbatim')
    const t = now()
    if (!cred.managed && credExpired(cred, t)) throw new KeychainError(410, 'credential is expired')
    const grant: KeychainGrant = {
      id: hashId([cred.id, input.audienceScopeId, String(t), purpose]),
      credentialId: cred.id,
      ownerId: cred.ownerId,
      ...(cred.orgId !== undefined ? { orgId: cred.orgId } : {}),
      audienceScopeId: input.audienceScopeId,
      mode: input.mode,
      purpose,
      status: 'active',
      createdAt: t,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.askId ? { askId: input.askId } : {}),
    }
    await deps.grants.put(grant.id, grant)
    return grant
  }

  async function deleteCredential(id: string): Promise<void> {
    for (const grant of await deps.grants.all()) {
      if (grant.credentialId === id && grant.status === 'active') {
        await deps.grants.merge(grant.id, { status: 'revoked', revokedAt: now() })
      }
    }
    await deps.creds.delete(id)
  }

  return {
    save: saveCredential,

    async listAllMetadata() {
      return (await deps.creds.all()).filter((c) => !c.managed && c.kind !== 'broker').map(toMeta)
    },

    async listByOwner(ownerId) {
      return (await deps.creds.all())
        .filter((c) => samePerson(c.ownerId, ownerId) && !c.managed && c.kind !== 'broker')
        .map(toMeta)
    },

    async listByOwners(ownerIds) {
      return bucketByOwner(await deps.creds.all(), ownerIds, (c) => !c.managed && c.kind !== 'broker', toMeta)
    },

    async getCredential(id) {
      const rec = await deps.creds.get(id)
      return rec ? toMeta(rec) : null
    },

    async readOwnSecret(ownerId, id) {
      const rec = await getOwned(ownerId, id)
      if (!rec || rec.kind !== 'env') return null
      return tryDecrypt(rec, (r) => decryptSecret(r.secretEnc, deps.key))
    },

    async remove(ownerId, id) {
      const rec = await getOwned(ownerId, id)
      if (!rec) return false
      if (rec.managed || rec.kind === 'broker') return false
      await deleteCredential(id)
      return true
    },

    createGrant: mintGrant,

    async grantConnectorToScope({ host, principalId, accountType, audienceScopeId, purpose }) {
      const id = oauthId(host, principalId, accountType)
      const cred = await deps.creds.get(id)
      if (!cred) return null
      for (const g of await deps.grants.all()) {
        if (
          g.credentialId === id &&
          g.audienceScopeId === audienceScopeId &&
          g.mode === 'standing' &&
          g.status === 'active'
        ) {
          return g
        }
      }
      return mintGrant({ credentialId: id, ownerId: principalId, audienceScopeId, mode: 'standing', purpose })
    },

    async getGrant(id) {
      return (await deps.grants.get(id)) ?? null
    },

    async listGrants(filter) {
      return (await deps.grants.all()).filter(
        (g) =>
          (filter.ownerId === undefined || samePerson(g.ownerId, filter.ownerId)) &&
          (filter.audienceScopeId === undefined || g.audienceScopeId === filter.audienceScopeId),
      )
    },

    async revokeGrant(ownerId, grantId) {
      const g = await deps.grants.get(grantId)
      if (!g || !samePerson(g.ownerId, ownerId)) return false
      if (g.status === 'active') await deps.grants.merge(grantId, { status: 'revoked', revokedAt: now() })
      return true
    },

    async grantsForScope(scopeId) {
      const out: Array<{ grant: KeychainGrant; credential: KeychainCredentialMeta }> = []
      for (const grant of await activeGrantsFor(scopeId)) {
        const cred = await deps.creds.get(grant.credentialId)
        if (cred && (cred.managed === 'connector' || !credExpired(cred, now())))
          out.push({ grant, credential: toMeta(cred) })
      }
      return out
    },

    async createAsk(input) {
      const purpose = input.purpose.trim()
      if (!purpose) throw new KeychainError(400, 'purpose required — record the requester\'s words verbatim')
      const cred = await deps.creds.get(input.credentialId)
      if (!cred || cred.kind === 'broker') throw new KeychainError(404, 'unknown credential')
      const t = now()
      if (!cred.managed && credExpired(cred, t))
        throw new KeychainError(410, 'credential is expired — its owner must re-auth before it can be asked for')
      if (samePerson(cred.ownerId, input.requesterId)) {
        throw new KeychainError(400, 'you own this credential — grant it directly instead of asking yourself')
      }
      for (const rec of await deps.asks.all()) {
        const a = await freshAsk(rec, t)
        if (a.status === 'pending' && a.credentialId === cred.id && a.requesterScopeId === input.requesterScopeId) {
          return { ask: a, existing: true }
        }
      }
      const ask: KeychainAsk = {
        id: randomBytes(6).toString('hex'),
        credentialId: cred.id,
        ownerId: cred.ownerId,
        requesterId: input.requesterId,
        ...(orgIdOf() !== undefined ? { orgId: orgIdOf() as string } : {}),
        requesterScopeId: input.requesterScopeId,
        ...(input.requesterDestination ? { requesterDestination: input.requesterDestination } : {}),
        ...(input.requesterThreadRef ? { requesterThreadRef: input.requesterThreadRef } : {}),
        purpose,
        ...(input.requestedMode ? { requestedMode: input.requestedMode } : {}),
        status: 'pending',
        createdAt: t,
        expiresAt: input.expiresAt ?? t + ASK_TTL_MS,
      }
      await deps.asks.put(ask.id, ask)
      return { ask, existing: false }
    },

    async getAsk(id) {
      const rec = await deps.asks.get(id)
      return rec ? freshAsk(rec, now()) : null
    },

    async listAsks(filter) {
      const t = now()
      const out: KeychainAsk[] = []
      for (const rec of await deps.asks.all()) {
        const a = await freshAsk(rec, t)
        if (filter.requesterId !== undefined && !samePerson(a.requesterId, filter.requesterId)) continue
        if (filter.ownerId !== undefined && !samePerson(a.ownerId, filter.ownerId)) continue
        if (filter.requesterScopeId !== undefined && a.requesterScopeId !== filter.requesterScopeId) continue
        out.push(a)
      }
      return out.sort((x, y) => x.createdAt - y.createdAt)
    },

    async approveAsk(input) {
      const rec = await deps.asks.get(input.askId)
      if (!rec) throw new KeychainError(404, 'unknown ask')
      const t = now()
      const ask = await freshAsk(rec, t)
      if (ask.status !== 'pending') throw new KeychainError(410, `ask already ${ask.status}`)
      const grant = await mintGrant({
        credentialId: ask.credentialId,
        ownerId: input.ownerId,
        audienceScopeId: ask.requesterScopeId,
        mode: input.mode,
        purpose: input.purpose,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        askId: ask.id,
      })
      const patch = { status: 'approved' as const, resolvedAt: t, grantId: grant.id }
      await deps.asks.merge(ask.id, patch)
      return { ask: { ...ask, ...patch }, grant }
    },

    async declineAsk(input) {
      const rec = await deps.asks.get(input.askId)
      if (!rec) throw new KeychainError(404, 'unknown ask')
      if (!samePerson(rec.ownerId, input.ownerId))
        throw new KeychainError(403, 'only the credential\'s owner can decline an ask')
      const t = now()
      const ask = await freshAsk(rec, t)
      if (ask.status !== 'pending') throw new KeychainError(410, `ask already ${ask.status}`)
      const note = input.note?.trim()
      const patch = { status: 'declined' as const, resolvedAt: t, ...(note ? { note } : {}) }
      await deps.asks.merge(ask.id, patch)
      return { ...ask, ...patch }
    },

    async unnotifiedResolvedAsks(nowAt) {
      const out: KeychainAsk[] = []
      for (const rec of await deps.asks.all()) {
        const a = await freshAsk(rec, nowAt)
        if (a.status === 'pending') continue
        if (a.notifiedAt === undefined) out.push(a)
        else if (a.notifiedAt < nowAt - ASK_PRUNE_AFTER_MS) await deps.asks.delete(a.id)
      }
      return out
    },

    async markAskNotified(id) {
      await deps.asks.merge(id, { notifiedAt: now() })
    },

    async resolveAsksForGrant(grant) {
      const t = now()
      const adopted: KeychainAsk[] = []
      for (const rec of await deps.asks.all()) {
        const a = await freshAsk(rec, t)
        if (
          a.status !== 'pending' ||
          a.credentialId !== grant.credentialId ||
          a.requesterScopeId !== grant.audienceScopeId
        )
          continue
        const patch = { status: 'approved' as const, resolvedAt: t, grantId: grant.id, notifiedAt: t }
        await deps.asks.merge(a.id, patch)
        await deps.grants.merge(grant.id, { askId: a.id })
        adopted.push({ ...a, ...patch })
      }
      return adopted
    },

    async setServiceCredential(orgScopeId, input) {
      const prior = await brokerRecord(orgScopeId, input.slug)
      const rec = serviceCredentialRecord(orgScopeId, input, prior)
      await deps.creds.put(rec.id, rec)
    },

    async setServiceCredentialIfAbsent(orgScopeId, input) {
      if (!deps.creds.insertIfAbsent) throw new Error('credential store does not support atomic inserts')
      const rec = serviceCredentialRecord(orgScopeId, input, null)
      return (await deps.creds.insertIfAbsent(rec.id, rec)) ? rec.updatedAt : null
    },

    async setServiceCredentialIfCurrent(orgScopeId, input, expectedUpdatedAt) {
      if (!deps.creds.update) throw new Error('credential store does not support atomic updates')
      let updatedAt: number | null = null
      await deps.creds.update(brokerId(orgScopeId, input.slug), (prior) => {
        if (prior.kind !== 'broker' || prior.ownerId !== orgScopeId || prior.updatedAt !== expectedUpdatedAt)
          return prior
        const next = serviceCredentialRecord(orgScopeId, input, prior)
        updatedAt = next.updatedAt
        return next
      })
      return updatedAt
    },

    async listServiceCredentials(orgScopeId) {
      return (await deps.creds.all())
        .filter((c) => c.kind === 'broker' && c.ownerId === orgScopeId)
        .map(brokerToPublic)
    },

    async deleteServiceCredential(orgScopeId, slug) {
      await deps.creds.delete(brokerId(orgScopeId, slug))
    },

    async deleteServiceCredentialIfCurrent(orgScopeId, slug, expectedUpdatedAt) {
      if (!deps.creds.deleteIf) throw new Error('credential store does not support atomic deletes')
      return deps.creds.deleteIf(
        brokerId(orgScopeId, slug),
        (prior) => prior.kind === 'broker' && prior.ownerId === orgScopeId && prior.updatedAt === expectedUpdatedAt,
      )
    },

    async getServiceCredentialSecret(orgScopeId, slug) {
      const rec = await brokerRecord(orgScopeId, slug)
      if (!rec?.secretEnc) return null
      const b = rec.broker ?? { name: rec.service, enabled: true }
      return {
        slug: rec.service,
        name: b.name,
        secret: decryptSecret(rec.secretEnc, deps.key),
        delivery: b.delivery ?? 'broker',
        ...(b.envKey ? { envKey: b.envKey } : {}),
        host: rec.host ?? '',
        ...(b.injection ? { injection: b.injection } : {}),
        ...(b.allowedMethods ? { allowedMethods: b.allowedMethods } : {}),
        ...(b.allowedPathPrefixes ? { allowedPathPrefixes: b.allowedPathPrefixes } : {}),
        enabled: b.enabled,
      }
    },

    async setConnectorToken(host, principalId, token, accountType) {
      await putConnectorToken(host, principalId, token, accountType)
    },

    async deleteConnectorToken(host, principalId, accountType) {
      await deleteCredential(oauthId(host, principalId, accountType))
    },

    async connectorTokenStatus(host, principalId, accountType) {
      const rec = await connectorRecord(host, principalId, accountType)
      if (!rec) return { connected: false }
      const hasRefresh = !!rec.refresh?.refreshTokenEnc
      const refreshFailedAt = rec.refresh?.refreshFailedAt
      const refreshFailed = typeof refreshFailedAt === 'number'
      const tokenExpired = oauthExpired(rec, now())
      return {
        connected: true,
        ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}),
        ...(hasRefresh ? { hasRefreshToken: true } : {}),
        ...(tokenExpired && (!hasRefresh || refreshFailed) ? { needsReconnect: true } : {}),
        ...(refreshFailed ? { refreshFailedAt } : {}),
        ...(refreshFailed && rec.refresh?.refreshError ? { refreshError: rec.refresh.refreshError } : {}),
        ...(rec.refresh?.accountType ? { accountType: rec.refresh.accountType } : {}),
        ...(rec.refresh?.grantedScopes ? { grantedScopes: rec.refresh.grantedScopes } : {}),
      }
    },

    async connectorAccessToken(host, principalId, accountType) {
      const rec = await connectorRecord(host, principalId, accountType)
      if (!rec) return null
      return connectorTokenForRecord(rec)
    },

    async connectorDerivedAuth(host, principalId, accountType) {
      const rec = await connectorRecord(host, principalId, accountType)
      if (!rec) return null
      const accessToken = await connectorTokenForRecord(rec)
      if (accessToken === null) return null
      const fresh = (await connectorRecord(host, principalId, accountType)) ?? rec
      const token = tryDecrypt(fresh, recToOAuthToken)
      if (!token) return null
      return {
        accessToken,
        ...(token.idToken ? { idToken: token.idToken } : {}),
        ...(token.accountId ? { accountId: token.accountId } : {}),
        ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
      }
    },

    async listConnectorsByOwners(ownerIds) {
      const t = now()
      return bucketByOwner(
        await deps.creds.all(),
        ownerIds,
        (c) => c.managed === 'connector',
        (c) => connectorMeta(c, t),
      )
    },

    async materialize(grantId, scopeId, usedBy) {
      const grant = await deps.grants.get(grantId)
      if (!grant) throw new KeychainError(404, 'unknown grant')
      if (grant.audienceScopeId !== scopeId) throw new KeychainError(403, 'grant is for a different conversation')
      if (grant.status === 'revoked') throw new KeychainError(410, 'grant was revoked')
      if (grant.status === 'used') throw new KeychainError(410, 'one-time grant already used')
      if (expired(grant, now())) throw new KeychainError(410, 'grant is expired')
      const cred = await deps.creds.get(grant.credentialId)
      if (!cred) throw new KeychainError(404, 'credential no longer exists')
      if (cred.kind === 'broker') {
        throw new KeychainError(403, 'broker credentials are not grantable — they are used via the credential broker')
      }
      const extra = { grantId: grant.id, purpose: grant.purpose }
      if (cred.managed === 'connector') {
        const m = await materializeConnectorEnv(cred, extra)
        await claimOnceGrant(grant, scopeId, usedBy)
        return m
      }
      if (credExpired(cred, now())) throw new KeychainError(410, 'credential is expired')
      const materialized = materializeDecrypted(cred, extra)
      await claimOnceGrant(grant, scopeId, usedBy)
      return materialized
    },

    async materializeOwnById(ownerId, credentialId, scopeId) {
      if (scopeId !== personalScope(ownerId)) {
        throw new KeychainError(
          403,
          'a credential id loads only in its owner\'s own personal conversation — anywhere else needs a grant from the owner',
        )
      }
      const cred = await deps.creds.get(credentialId)
      if (!cred || !samePerson(cred.ownerId, ownerId)) throw new KeychainError(404, 'unknown credential')
      if (cred.kind === 'broker') {
        throw new KeychainError(403, 'broker credentials are used via the credential broker, never materialized')
      }
      if (cred.managed === 'connector') return materializeConnectorEnv(cred)
      if (credExpired(cred, now())) throw new KeychainError(410, 'credential is expired')
      return materializeDecrypted(cred)
    },

    async materializeOwn(ownerId) {
      const t = now()
      return (await deps.creds.all())
        .filter((c) => samePerson(c.ownerId, ownerId) && c.kind === 'env' && !c.managed && !expired(c, t))
        .map((c) => tryDecrypt(c, decryptToEnv))
        .filter((c): c is MaterializedEnvCred => c !== null)
    },

    async materializeOwnFiles(ownerId) {
      return (await deps.creds.all())
        .filter((c) => samePerson(c.ownerId, ownerId) && c.kind === 'file' && !c.managed)
        .map((c) => tryDecrypt(c, decryptToFiles))
        .filter((c): c is MaterializedFileCred => c !== null)
    },

    async materializeStanding(scopeId) {
      const out: MaterializedEnvCred[] = []
      for (const grant of await activeGrantsFor(scopeId)) {
        if (grant.mode !== 'standing') continue
        const cred = await deps.creds.get(grant.credentialId)
        if (!cred || cred.kind !== 'env') continue
        if (cred.managed === 'connector') {
          const value = cred.host ? await connectorTokenForRecord(cred) : null
          if (value && cred.host) {
            out.push({
              credentialId: cred.id,
              ownerId: cred.ownerId,
              service: cred.service,
              env: [{ key: envKey(cred.host), value }],
              grantId: grant.id,
              purpose: grant.purpose,
            })
          }
          continue
        }
        if (cred.managed || credExpired(cred, now())) continue
        const mat = tryDecrypt(cred, (c) => decryptToEnv(c, { grantId: grant.id, purpose: grant.purpose }))
        if (mat) out.push(mat)
      }
      return out
    },
  }
}

const tempCredentialPath = (rel: string): string =>
  /^[A-Za-z0-9._@+ /-]+$/.test(rel) ? `"$__kc_dir/${rel}"` : `"$__kc_dir"${shq(`/${rel}`)}`

const FILE_ENV_POINTERS: Array<[RegExp, (rel: string) => string]> = [
  [/(^|\/)\.aws\/credentials$/, (rel) => `export AWS_SHARED_CREDENTIALS_FILE=${tempCredentialPath(rel)}`],
  [/(^|\/)\.aws\/config$/, (rel) => `export AWS_CONFIG_FILE=${tempCredentialPath(rel)}`],
  [/(^|\/)\.kube\/config$/, (rel) => `export KUBECONFIG=${tempCredentialPath(rel)}`],
  [
    /(^|\/)\.config\/gh\/hosts\.yml$/,
    (rel) => `export GH_CONFIG_DIR=${tempCredentialPath(rel.replace(/\/hosts\.yml$/, ''))}`,
  ],
  [
    /(^|\/)(?:\.config\/(?:glab-cli|glab)|Library\/Application Support\/glab-cli)\/config\.yml$/,
    (rel) => `export GLAB_CONFIG_DIR=${tempCredentialPath(rel.replace(/\/config\.yml$/, ''))}`,
  ],
  [
    /(^|\/)\.docker\/config\.json$/,
    (rel) => `export DOCKER_CONFIG=${tempCredentialPath(rel.replace(/\/config\.json$/, ''))}`,
  ],
  [/(^|\/)\.npmrc$/, (rel) => `export NPM_CONFIG_USERCONFIG=${tempCredentialPath(rel)}`],
  [/(^|\/)\.netrc$/, (rel) => `export NETRC=${tempCredentialPath(rel)}`],
  [
    /(^|\/)\.ssh\/[^/]*(id_|key)[^/]*$/,
    (rel) =>
      /^[A-Za-z0-9._@+ /-]+$/.test(rel)
        ? `export GIT_SSH_COMMAND="ssh -i $__kc_dir/${rel} -o IdentitiesOnly=yes"`
        : `export GIT_SSH_COMMAND="ssh -i $__kc_dir"${shq(`/${rel}`)}" -o IdentitiesOnly=yes"`,
  ],
]

export function renderUseScript(m: MaterializedCred): string {
  if (m.kind === 'env') return m.env.map((e) => `export ${e.key}=${shq(e.value)}`).join('\n') + '\n'
  const files = m.files.map((f) => ({ ...f, path: homeRelativePath(f.path) }))
  const lines = [`__kc_dir="$(mktemp -d "\${TMPDIR:-/tmp}/keychain.XXXXXX")"`, `umask 077`]
  for (const f of files) {
    const parent = f.path.includes('/') ? f.path.replace(/\/[^/]*$/, '') : ''
    if (parent) lines.push(`mkdir -p ${tempCredentialPath(parent)}`)
    const path = tempCredentialPath(f.path)
    lines.push(`printf '%s' ${shq(f.contentBase64)} | base64 -d > ${path}`, `chmod 600 ${path}`)
  }
  const pointed = new Set<RegExp>()
  for (const f of files) {
    for (const [re, render] of FILE_ENV_POINTERS) {
      if (re.test(f.path) && !pointed.has(re)) {
        pointed.add(re)
        lines.push(render(f.path))
      }
    }
  }
  if (files.some((f) => !FILE_ENV_POINTERS.some(([re]) => re.test(f.path)))) {
    lines.push(
      `for __e in "$HOME"/.[!.]* "$HOME"/*; do [ -e "$__e" ] || continue; __b=\${__e##*/}; [ -e "$__kc_dir/$__b" ] || ln -s "$__e" "$__kc_dir/$__b"; done`,
      `export HOME="$__kc_dir"`,
    )
  }
  return lines.join('\n') + '\n'
}
