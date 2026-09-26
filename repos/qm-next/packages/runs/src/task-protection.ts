import { errMessage } from './errors.ts'
import type { Ownership, OwnershipLease, TransferToken } from '@qm/types'
import {
  acceptHandover as _acceptHandover,
  OWNERSHIP_NOT_IMPLEMENTED,
  tryHandoverOwnership as _tryHandoverOwnership,
} from './ownership.ts'

export interface TaskProtection {
  set(enabled: boolean): Promise<void>
}

/**
 * Hand over a background-work ownership lease from this process to a
 * successor deployment. See `docs/adr/0020-background-ownership-types.md`
 * for the full protocol. **Stub today** — throws
 * `Error(OWNERSHIP_NOT_IMPLEMENTED)` per M-Soul-3 (2026-09-26) deferral
 * until P5 21.0's worker split lands. Re-exported from `ownership.ts`
 * so the composition root has a single entry-point for both the
 * ECS-protection and ownership-stub concerns.
 */
export function tryHandoverOwnership(
  lease: OwnershipLease,
  token: TransferToken,
): Ownership | undefined {
  return _tryHandoverOwnership(lease, token)
}

/**
 * Accept a transfer token issued by a relinquishing process. Symmetric
 * to `tryHandoverOwnership` — **stub today** per M-Soul-3 (2026-09-26).
 */
export function acceptHandover(token: TransferToken): Ownership | undefined {
  return _acceptHandover(token)
}

/** Reason surfaced by every stub. Pinned string for observability
 *  dashboards (P5 21.0 regression detection). */
export { OWNERSHIP_NOT_IMPLEMENTED }

const PROTECTION_EXPIRES_MINUTES = 60

export function createEcsTaskProtection(agentUri: string, opts?: { fetchFn?: typeof fetch }): TaskProtection {
  const fetchFn = opts?.fetchFn ?? fetch
  let lastFailure: string | null = null
  return {
    async set(enabled: boolean): Promise<void> {
      try {
        const res = await fetchFn(`${agentUri.replace(/\/$/, '')}/task-protection/v1/state`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            enabled
              ? { ProtectionEnabled: true, ExpiresInMinutes: PROTECTION_EXPIRES_MINUTES }
              : { ProtectionEnabled: false },
          ),
        })
        if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.trim())
        lastFailure = null
      } catch (e) {
        const msg = errMessage(e)
        if (msg !== lastFailure) {
          lastFailure = msg
          console.error(`[task-protection] set(${enabled}) failed (turns fall back to drain+resume): ${msg}`)
        }
      }
    },
  }
}
