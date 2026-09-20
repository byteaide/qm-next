/**
 * Consent link store (qm `src/connectors/consent-link.ts`): a single-use
 * token that lets a delegated user authorize a connector on someone
 * else's behalf. The token is a 64-char hex id (two UUIDs concatenated);
 * it expires 24h after minting and is consumed by `redeem`.
 */
import { randomUUID } from 'node:crypto'
import type { DurableMap } from '@qm/store'

export type AccountType = 'user' | 'workspace' | 'project'

export interface ConsentLinkRecord {
  principalId: string
  orgId?: string
  provider: string
  accountType: AccountType
  redirectUri: string
  returnTo?: string
  /** Phase 6 (ADR-0009): provider host + OAuth state born at mint so
   *  redeem can attach the issued code to the durable flow. */
  host?: string
  state?: string
  createdAt: number
}

type ConsentRedeemResult = { ok: true; rec: ConsentLinkRecord } | { ok: false; reason: 'not_found' | 'expired' }

export interface ConsentLinkStore {
  mint(rec: Omit<ConsentLinkRecord, 'createdAt'>, now?: number): Promise<{ linkId: string }>
  peek(linkId: string, now?: number): Promise<ConsentRedeemResult>
  redeem(linkId: string, now?: number): Promise<ConsentRedeemResult>
  /** Phase 6 (ADR-0009): attach the OAuth state born at mint so a
   *  redeem — possibly on another instance — can attach the issued
   *  code to the durable flow. */
  attachState(linkId: string, state: string): Promise<boolean>
}

const CONSENT_LINK_TTL_MS = 24 * 60 * 60_000

export function createConsentLinkStore(
  backing: DurableMap<ConsentLinkRecord>,
  opts: { ttlMs?: number; now?: () => number } = {},
): ConsentLinkStore {
  const ttl = opts.ttlMs ?? CONSENT_LINK_TTL_MS
  const clock = opts.now ?? (() => Date.now())
  return {
    async mint(rec, now) {
      const linkId = `${randomUUID()}${randomUUID().replace(/-/g, '')}`
      await backing.put(linkId, { ...rec, createdAt: now ?? clock() })
      return { linkId }
    },
    async peek(linkId, now) {
      const rec = await backing.get(linkId)
      if (!rec) return { ok: false, reason: 'not_found' }
      if ((now ?? clock()) - rec.createdAt > ttl) return { ok: false, reason: 'expired' }
      return { ok: true, rec }
    },
    async redeem(linkId, now) {
      const rec = await backing.take(linkId)
      if (!rec) return { ok: false, reason: 'not_found' }
      if ((now ?? clock()) - rec.createdAt > ttl) return { ok: false, reason: 'expired' }
      return { ok: true, rec }
    },
    async attachState(linkId, state) {
      if (!backing.update) return false
      const next = await backing.update(linkId, (rec) => ({ ...rec, state }))
      return next != null
    },
  }
}