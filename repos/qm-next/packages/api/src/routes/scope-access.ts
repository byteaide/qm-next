/**
 * Directory-backed scope access checks (S-cluster parity clearance): qm's
 * context-policy `memberScope` (deviation #44) and soul `managesScope`
 * collapsed onto the provider-scoped DirectoryStore. Principal ids are
 * `provider:userId` (`principalIdFor`); channel/group scope refs are space
 * ids. Fail-closed: unknown principals, unknown spaces, and absent
 * memberships all read as "not allowed".
 */
import { samePerson, type DirectoryStore } from '@qm/directory'
import { parseScopeId } from '@qm/types'

export type ScopeAccessCheck = (principalId: string, scopeId: string) => Promise<boolean>

function splitPrincipalId(principalId: string): { provider: string; providerUserId: string } | null {
  const sep = principalId.indexOf(':')
  if (sep <= 0) return null
  const provider = principalId.slice(0, sep)
  const providerUserId = principalId.slice(sep + 1)
  if (!provider || !providerUserId) return null
  return { provider, providerUserId }
}

function spaceRef(scopeId: string): { kind: 'channel' | 'group'; ref: string } | null {
  const { kind, ref } = parseScopeId(scopeId)
  if ((kind !== 'channel' && kind !== 'group') || !ref) return null
  return { kind, ref }
}

/**
 * qm `memberScope` (context-policy lane): the principal counts when it is a
 * member of the scope's space (qm `listContexts` contains the scope).
 */
export function directoryMemberCheck(directory: DirectoryStore): ScopeAccessCheck {
  return async (principalId, scopeId) => {
    const space = spaceRef(scopeId)
    const principal = splitPrincipalId(principalId)
    if (!space || !principal) return false
    return directory.spaceMember(principal.provider, space.ref, principal.providerUserId).catch(() => false)
  }
}

/**
 * qm `managesScope`: personal scope = own; group = member; channel = private
 * channel membership (public channels are not manageable — qm
 * `createCanManageScope`). An unknown space reads as unmanageable.
 */
export function directoryManageCheck(directory: DirectoryStore): ScopeAccessCheck {
  return async (principalId, scopeId) => {
    const { kind, ref } = parseScopeId(scopeId)
    if (kind === 'personal') return samePerson(ref, principalId)
    const space = spaceRef(scopeId)
    const principal = splitPrincipalId(principalId)
    if (!space || !principal) return false
    const record = await directory.getSpace(principal.provider, space.ref).catch(() => null)
    if (!record) return false
    if (space.kind === 'channel' && !record.isPrivate) return false
    return directory.spaceMember(principal.provider, space.ref, principal.providerUserId).catch(() => false)
  }
}
