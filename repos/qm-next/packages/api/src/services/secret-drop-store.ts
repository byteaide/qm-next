/**
 * Lane-A secret-drop store: single-use credential-request links with a
 * 7-day TTL (qm secret-drop.ts contract: mint/peek/redeem, expired vs
 * invalid-or-used peek reasons).
 */
import { randomUUID } from 'node:crypto'

export const SECRET_DROP_TTL_MS = 7 * 24 * 60 * 60_000

export interface SecretDropField {
  key: string
  label?: string
  secret?: boolean
}

export interface SecretDropRecord {
  dropId: string
  ownerId: string
  orgId?: string
  service: string
  envKey?: string
  host?: string
  fields?: SecretDropField[]
  purpose: string
  requestedBy: string
  audienceScopeId?: string
  grantMode?: 'once' | 'standing'
  destination?: Record<string, unknown>
  threadRef?: string
  requiresToken?: boolean
  createdAt: number
}

export type SecretDropResult =
  | { ok: true; rec: SecretDropRecord }
  | { ok: false; reason: 'expired' | 'invalid' }

export interface SecretDropStore {
  mint(rec: Omit<SecretDropRecord, 'dropId' | 'createdAt'>): Promise<{ dropId: string }>
  peek(dropId: string, now?: number): Promise<SecretDropResult>
  redeem(dropId: string, now?: number): Promise<SecretDropResult>
}

export function createMemorySecretDropStore(opts: { ttlMs?: number } = {}): SecretDropStore {
  const ttl = opts.ttlMs ?? SECRET_DROP_TTL_MS
  const drops = new Map<string, { rec: SecretDropRecord; redeemed: boolean }>()
  return {
    async mint(rec) {
      const dropId = randomUUID()
      drops.set(dropId, { rec: { ...rec, dropId, createdAt: Date.now() }, redeemed: false })
      return { dropId }
    },
    async peek(dropId, now = Date.now()) {
      const entry = drops.get(dropId)
      if (!entry) return { ok: false, reason: 'invalid' }
      if (now - entry.rec.createdAt > ttl) return { ok: false, reason: 'expired' }
      return { ok: true, rec: { ...entry.rec } }
    },
    async redeem(dropId, now = Date.now()) {
      const entry = drops.get(dropId)
      if (!entry || entry.redeemed) return { ok: false, reason: entry ? 'expired' : 'invalid' }
      if (now - entry.rec.createdAt > ttl) return { ok: false, reason: 'expired' }
      entry.redeemed = true
      return { ok: true, rec: { ...entry.rec } }
    },
  }
}
