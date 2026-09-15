/**
 * Browser session store (qm `src/connectors/browser-session-store.ts`):
 * encrypts Playwright `storageState` JSON per principal at rest with
 * the same AES-256-GCM envelope the connector secrets use. A failed
 * decrypt surfaces as `null` so the browser launcher can fall back
 * to a fresh login without leaking the cause.
 */
import { errMessage } from '@qm/store'
import type { DurableMap } from '@qm/store'
import { decryptSecret, encryptSecret, type SecretKey } from './secret-envelope.ts'

export interface BrowserSessionStore {
  get(principalId: string): Promise<string | null>
  put(principalId: string, storageStateJson: string): Promise<void>
}

export interface StoredBrowserSession {
  principalId: string
  stateEnc: string
  updatedAt: number
}

export function createBrowserSessionStore(deps: {
  sessions: DurableMap<StoredBrowserSession>
  key: SecretKey
  now?: () => number
}): BrowserSessionStore {
  const now = deps.now ?? Date.now
  return {
    async get(principalId): Promise<string | null> {
      const rec = await deps.sessions.get(principalId)
      if (!rec) return null
      try {
        return decryptSecret(rec.stateEnc, deps.key)
      } catch (e) {
        errMessage(e)
        return null
      }
    },
    async put(principalId, storageStateJson): Promise<void> {
      await deps.sessions.put(principalId, {
        principalId,
        stateEnc: encryptSecret(storageStateJson, deps.key),
        updatedAt: now(),
      })
    },
  }
}