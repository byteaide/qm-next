/**
 * Connector token vault (plan §Phase 6 slices 5–7, ADR-0016, ADR-0017):
 * seals OAuth tokens with the shared AES-256-GCM envelope before any
 * durable write and opens them only for a short-lived Connector
 * provider call. The KEK is purpose-derived from the deployment's
 * signing secret (`deriveConnectorKey(material, 'connector-tokens')`);
 * the KEK chain follows `config.secrets` rotation semantics — entry 0
 * encrypts, every entry decrypts — so online rotation is append +
 * restart + `resealAll()`. Construction is fail-closed: no key
 * material, no vault (mirrors the missing production policy case,
 * plan §2.2). Decryption events are counted (`oauth_token_decrypt_total`)
 * and audited payload-free; durable rows carry only envelope
 * ciphertext plus non-secret metadata.
 */
import { createHash } from 'node:crypto'
import { errMessage } from '@qm/store'
import type { DurableMap } from '@qm/store'
import { bumpOAuthTokenDecrypt, type RunMetricsRegistry } from '@qm/runs'
import { decryptSecret, deriveConnectorKey, encryptSecret, type SecretKey } from './secret-envelope.ts'

export type ConnectorAccountType = 'default' | 'personal' | 'org'

export const CONNECTOR_ACCOUNT_TYPES: readonly ConnectorAccountType[] = ['default', 'personal', 'org']

/** The durable row: envelope ciphertext plus non-secret metadata only. */
export interface SealedConnectorToken {
  principalId: string
  host: string
  accountType: ConnectorAccountType
  /** AES-256-GCM envelope (`v2:...`) over the JSON `{accessToken, refreshToken?}`. */
  tokenEnc: string
  /** KEK chain entry the record was sealed under (`k0` = current). */
  keyId: string
  expiresAt?: number
  updatedAt: number
}

/** Decrypted view — exists only in memory inside a Connector operation. */
export interface OpenedConnectorToken {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
}

/** Payload-free decrypt audit record (ADR-0017: never the token value,
 *  ciphertext, or decrypted payload). */
export interface TokenAuditEntry {
  principalId: string
  host: string
  provider?: string
  accountType: ConnectorAccountType
  purpose: 'seal' | 'open' | 'status' | 'delete' | 'reseal'
  outcome: 'ok' | 'error' | 'missing'
  at: number
  /** Secret-free reason — redacted by the caller before it gets here. */
  error?: string
}

export interface ConnectorTokenVault {
  seal(input: {
    host: string
    principalId: string
    accessToken: string
    refreshToken?: string
    expiresAt?: number
    accountType?: ConnectorAccountType
    provider?: string
  }): Promise<void>
  /** Decrypt for one short-lived provider call (ADR-0017). Returns
   *  `null` when no token exists; throws never — decrypt failures come
   *  back as `{ ok: false }` so callers can surface needs-reconnect
   *  without leaking the crypto cause. */
  open(host: string, principalId: string, accountType?: ConnectorAccountType, provider?: string): Promise<OpenedConnectorToken | null>
  /** Metadata-only status probe — no decryption on the happy path. */
  status(host: string, principalId: string, accountType?: ConnectorAccountType): Promise<{ connected: boolean; needsReconnect?: boolean; lastError?: string }>
  delete(host: string, principalId: string, accountType?: ConnectorAccountType): Promise<void>
  /** Rotation sweep (ADR-0017): re-seal every record under the current
   *  KEK. Returns the number of records re-sealed. */
  resealAll(): Promise<{ total: number; resealed: number }>
}

export interface ConnectorTokenVaultOptions {
  backing: DurableMap<SealedConnectorToken>
  /** KEK chain: entry 0 encrypts; every entry decrypts (rotation). */
  keks: readonly ConnectorKek[]
  now?: () => number
  audit?: (entry: TokenAuditEntry) => void
  metrics?: RunMetricsRegistry
}

/** One key-encryption key in the chain, identified by a digest of its
 *  material (stable across chain reordering, unlike index-based ids). */
export interface ConnectorKek {
  kid: string
  key: SecretKey
}

/** Purpose-derive the KEK chain from deployment key material (ADR-0017). */
export function deriveConnectorTokenKeks(materials: readonly (Buffer | string)[]): ConnectorKek[] {
  return materials.map((m) => ({
    kid: createHash('sha256').update(m).digest('hex').slice(0, 12),
    key: deriveConnectorKey(m, 'connector-tokens'),
  }))
}

const vaultKey = (host: string, principalId: string, accountType: string) => `${accountType}:${principalId}@${host}`

export function createConnectorTokenVault(opts: ConnectorTokenVaultOptions): ConnectorTokenVault {
  if (!opts.keks || opts.keks.length === 0) {
    // Fail-closed (ADR-0017): the vault refuses to exist without key
    // material, the same way production refuses to boot without a
    // policy (plan §2.2). There is no plaintext fallback mode.
    throw new Error('connector token vault requires key material (fail-closed, ADR-0017)')
  }
  const now = opts.now ?? Date.now
  const audit = (entry: TokenAuditEntry) => opts.audit?.(entry)

  function kekFor(keyId: string): ConnectorKek {
    return opts.keks.find((k) => k.kid === keyId) ?? opts.keks[0]!
  }

  return {
    async seal(input) {
      const accountType = input.accountType ?? 'default'
      const payload = JSON.stringify({ accessToken: input.accessToken, ...(input.refreshToken !== undefined ? { refreshToken: input.refreshToken } : {}) })
      const rec: SealedConnectorToken = {
        principalId: input.principalId,
        host: input.host,
        accountType,
        tokenEnc: encryptSecret(payload, opts.keks[0]!.key),
        keyId: opts.keks[0]!.kid,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        updatedAt: now(),
      }
      await opts.backing.put(vaultKey(input.host, input.principalId, accountType), rec)
      audit({ principalId: input.principalId, host: input.host, ...(input.provider !== undefined ? { provider: input.provider } : {}), accountType, purpose: 'seal', outcome: 'ok', at: now() })
    },

    async open(host, principalId, accountType = 'default', provider) {
      const rec = await opts.backing.get(vaultKey(host, principalId, accountType))
      if (!rec) {
        audit({ principalId, host, ...(provider !== undefined ? { provider } : {}), accountType, purpose: 'open', outcome: 'missing', at: now() })
        return null
      }
      const label = provider ?? host
      let lastErr: unknown = null
      // Try the record's KEK first, then the rest of the chain (rotation
      // windows where the kid ordering moved under us).
      const ordered = [kekFor(rec.keyId), ...opts.keks.filter((_, i) => `k${i}` !== rec.keyId)]
      for (const kek of ordered) {
        try {
          const payload = decryptSecret(rec.tokenEnc, kek.key)
          const parsed = JSON.parse(payload) as { accessToken: string; refreshToken?: string }
          bumpOAuthTokenDecrypt(opts.metrics, label, 'ok')
          audit({ principalId, host, ...(provider !== undefined ? { provider } : {}), accountType, purpose: 'open', outcome: 'ok', at: now() })
          return {
            accessToken: parsed.accessToken,
            ...(parsed.refreshToken !== undefined ? { refreshToken: parsed.refreshToken } : {}),
            ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}),
          }
        } catch (e) {
          lastErr = e
        }
      }
      bumpOAuthTokenDecrypt(opts.metrics, label, 'error')
      audit({ principalId, host, ...(provider !== undefined ? { provider } : {}), accountType, purpose: 'open', outcome: 'error', at: now(), ...(lastErr ? { error: errMessage(lastErr) } : {}) })
      return null
    },

    async status(host, principalId, accountType = 'default') {
      const rec = await opts.backing.get(vaultKey(host, principalId, accountType))
      if (!rec) {
        audit({ principalId, host, accountType, purpose: 'status', outcome: 'missing', at: now() })
        return { connected: false }
      }
      audit({ principalId, host, accountType, purpose: 'status', outcome: 'ok', at: now() })
      if (rec.expiresAt !== undefined && rec.expiresAt <= now()) {
        // needs-reconnect is derivable from metadata only (refresh-token
        // presence is non-secret) — no decrypt, per ADR-0016.
        return { connected: true, needsReconnect: true }
      }
      return { connected: true }
    },

    async delete(host, principalId, accountType = 'default') {
      await opts.backing.delete(vaultKey(host, principalId, accountType))
      audit({ principalId, host, accountType, purpose: 'delete', outcome: 'ok', at: now() })
    },

    async resealAll() {
      const entries = await opts.backing.entries()
      let resealed = 0
      for (const [id, rec] of entries) {
        if (rec.keyId === opts.keks[0]!.kid) continue
        const ordered = [kekFor(rec.keyId), ...opts.keks.filter((k) => k.kid !== rec.keyId)]
        let payload: string | null = null
        for (const kek of ordered) {
          try {
            payload = decryptSecret(rec.tokenEnc, kek.key)
            break
          } catch {
            // try next KEK in the chain
          }
        }
        if (payload === null) {
          audit({ principalId: rec.principalId, host: rec.host, accountType: rec.accountType, purpose: 'reseal', outcome: 'error', at: now(), error: 'no KEK in the chain could decrypt this record' })
          continue
        }
        await opts.backing.put(id, { ...rec, tokenEnc: encryptSecret(payload, opts.keks[0]!.key), keyId: opts.keks[0]!.kid, updatedAt: now() })
        audit({ principalId: rec.principalId, host: rec.host, accountType: rec.accountType, purpose: 'reseal', outcome: 'ok', at: now() })
        resealed += 1
      }
      return { total: entries.length, resealed }
    },
  }
}
