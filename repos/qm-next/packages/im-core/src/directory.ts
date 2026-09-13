/**
 * Directory sync: provider → core push of people and space rosters.
 * Generalized from qm's provider directory push (members / channels / groups
 * triple) with platform-neutral naming: people, spaces, space members.
 */
import type { PrincipalType, ScopeId } from '@qm/types'
import type { ImInstanceId, ImProviderId } from './types.ts'

/** One directory person as the provider observes them. */
export interface DirectoryPerson {
  /** Provider-native user id. */
  providerUserId: string
  displayName?: string
  /** Email when the platform exposes it; identity mode "email" needs this. */
  email?: string
  type: PrincipalType
  /** Timezone identifier (IANA) when known. */
  timezone?: string
}

/** One space (channel / group chat) as the provider observes it. */
export interface DirectorySpace {
  /** Provider-native space id; matches `Destination.target`. */
  spaceId: string
  name?: string
  kind: 'channel' | 'group' | 'dm'
  isPrivate?: boolean
  isExternal?: boolean
}

export interface DirectorySpaceMember {
  spaceId: string
  providerUserId: string
}

export interface DirectorySyncPush {
  provider: ImProviderId
  instanceId: ImInstanceId
  /** Scope the snapshot belongs to (org/channel scope of the instance). */
  scopeId?: ScopeId
  people?: DirectoryPerson[]
  spaces?: DirectorySpace[]
  spaceMembers?: DirectorySpaceMember[]
  /**
   * Full-roster semantics per section: when `replace` names a section,
   * memberships absent from this push were revoked platform-side.
   */
  replace?: Array<'people' | 'spaces' | 'spaceMembers'>
  syncedAt: number
}
