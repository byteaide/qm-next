/**
 * M3 reach contract (15.0, lane-opening freeze): resolve a user-stated
 * target — a recipient (teammate), a channel, or a group's participants —
 * into a `Destination`, with member checks and visibility filtering.
 * De-Slack-ized port of qm's `resolveReachTarget`; the directory slice it
 * needs is structural, so tests can substitute any `DirectoryStore`.
 *
 * OUT of M3: provider write-back — an unknown group resolves to
 * `group_not_found` (qm opens it via the surface; that lands with the real
 * provider adapters).
 */
import type { Destination, ScopeId } from '@qm/types'
import type { DirectoryPersonRecord, DirectorySpaceRecord } from '@qm/directory'
import { isVisible, principalIdFor } from '@qm/directory'

export const MAX_GROUP_PARTICIPANTS = 8

/** What the caller asks reach to resolve — exactly one field at a time. */
export interface ReachTarget {
  recipient?: string
  channel?: string
  participants?: readonly string[]
}

export type ReachResolution =
  | {
      ok: true
      destination: Destination
      recipient?: { principalId: string; displayName: string }
      channel?: { spaceId: string; name: string }
      group?: { spaceId: string; name?: string }
    }
  | {
      ok: false
      status: 400 | 403 | 404 | 409
      error: string
      message: string
      candidates?: Array<Record<string, string>>
    }

/** Structural slice of `DirectoryStore` reach resolves against. */
export interface ReachDirectory {
  resolvePerson(provider: string, query: string): Promise<{
    kind: 'one'
    person: DirectoryPersonRecord
  } | { kind: 'ambiguous'; candidates: DirectoryPersonRecord[] } | { kind: 'none' }>
  resolveSpace(provider: string, query: string): Promise<{
    kind: 'one'
    space: DirectorySpaceRecord
  } | { kind: 'ambiguous'; candidates: DirectorySpaceRecord[] } | { kind: 'none' }>
  spaceMember(provider: string, spaceId: string, providerUserId: string): Promise<boolean>
  resolveGroupByParticipants(
    provider: string,
    participantIds: readonly string[],
  ): Promise<{ kind: 'one'; space: DirectorySpaceRecord } | { kind: 'none' }>
  getPerson(provider: string, providerUserId: string): Promise<DirectoryPersonRecord | null>
  isVisible(provider: string, actorProviderUserId: string, space: DirectorySpaceRecord): Promise<boolean>
}

export function principalDestination(principalId: string, onBehalfOf: string): Destination {
  return { type: 'principal', target: principalId, audienceScopeId: personalScopeOf(principalId), onBehalfOf }
}

function personalScopeOf(principalId: string): ScopeId {
  return `personal:${principalId}`
}

function membershipDenial(
  dirPersonKnown: boolean,
  room: 'channel' | 'group',
): ReachResolution {
  if (!dirPersonKnown) {
    return {
      ok: false,
      status: 403,
      error: 'identity_unverified',
      message:
        "I can't confirm your membership here — your account isn't in this workspace's directory, so it may not have synced yet.",
    }
  }
  return {
    ok: false,
    status: 403,
    error: 'not_a_member',
    message:
      room === 'channel' ? "I can only post to a private channel you're in" : "I can only post to a group you're in",
  }
}

/**
 * Resolve one reach target. `actorProviderUserId` is the requesting
 * user's provider-native id; visibility and membership are checked against
 * them. Recipient destinations are surface-neutral (`type: 'principal'`)
 * that provider adapters translate into native DMs.
 */
export async function resolveReachTarget(
  dir: ReachDirectory,
  provider: string,
  target: ReachTarget,
  actorProviderUserId: string,
): Promise<ReachResolution> {
  const wantsRecipient = typeof target.recipient === 'string'
  const wantsChannel = typeof target.channel === 'string'
  const wantsGroup = Array.isArray(target.participants)
  if ([wantsRecipient, wantsChannel, wantsGroup].filter(Boolean).length > 1) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message: 'specify exactly one of recipient (a teammate), channel, or participants (a group)',
    }
  }
  if (wantsRecipient) {
    const r = await dir.resolvePerson(provider, target.recipient!)
    if (r.kind === 'none') {
      return { ok: false, status: 404, error: 'recipient_not_found', message: `no teammate matches "${target.recipient}"` }
    }
    if (r.kind === 'ambiguous') {
      return {
        ok: false,
        status: 409,
        error: 'ambiguous_recipient',
        message: `"${target.recipient}" matches multiple teammates — pass an exact name or id`,
        candidates: r.candidates.map((c) => ({ principalId: c.principalId, displayName: c.displayName ?? '' })),
      }
    }
    const principalId = r.person.principalId
    return {
      ok: true,
      destination: principalDestination(principalId, principalIdFor(provider, actorProviderUserId)),
      recipient: { principalId, displayName: r.person.displayName ?? principalId },
    }
  }
  if (wantsChannel) {
    const r = await dir.resolveSpace(provider, target.channel!)
    if (r.kind === 'none') {
      return { ok: false, status: 404, error: 'channel_not_found', message: `no channel matches "${target.channel}"` }
    }
    if (r.kind === 'ambiguous') {
      return {
        ok: false,
        status: 409,
        error: 'ambiguous_channel',
        message: `"${target.channel}" matches multiple channels — pass an exact name or id`,
        candidates: r.candidates.map((c) => ({ spaceId: c.spaceId, name: c.name ?? '' })),
      }
    }
    if (!(await isVisible(dir, provider, actorProviderUserId, r.space))) {
      return membershipDenial(!!(await dir.getPerson(provider, actorProviderUserId)), 'channel')
    }
    return {
      ok: true,
      destination: { type: provider, target: r.space.spaceId, audienceScopeId: `channel:${provider}:${r.space.spaceId}` },
      channel: { spaceId: r.space.spaceId, name: r.space.name ?? r.space.spaceId },
    }
  }
  if (wantsGroup) {
    const asked = [...new Set(target.participants!)]
    if (asked.length === 0) {
      return {
        ok: false,
        status: 400,
        error: 'bad_request',
        message: "participants must list the group's other members (at least one)",
      }
    }
    if (asked.length > MAX_GROUP_PARTICIPANTS) {
      return {
        ok: false,
        status: 400,
        error: 'group_too_large',
        message: `a group holds at most ${MAX_GROUP_PARTICIPANTS} people including you — use a channel instead`,
      }
    }
    const named: string[] = []
    for (const query of asked) {
      const p = await dir.resolvePerson(provider, query)
      if (p.kind === 'none') {
        return { ok: false, status: 404, error: 'recipient_not_found', message: `no teammate matches "${query}"` }
      }
      if (p.kind === 'ambiguous') {
        return {
          ok: false,
          status: 409,
          error: 'ambiguous_recipient',
          message: `"${query}" matches multiple teammates — pass an exact name or id`,
          candidates: p.candidates.map((c) => ({ principalId: c.principalId, displayName: c.displayName ?? '' })),
        }
      }
      named.push(p.person.providerUserId)
    }
    const participants = [...new Set([...named, actorProviderUserId])].sort()
    const known = await dir.resolveGroupByParticipants(provider, participants)
    if (known.kind === 'none') {
      return {
        ok: false,
        status: 404,
        error: 'group_not_found',
        message: 'no group with exactly those participants (it may not have synced yet)',
      }
    }
    if (!(await isVisible(dir, provider, actorProviderUserId, known.space))) {
      return membershipDenial(!!(await dir.getPerson(provider, actorProviderUserId)), 'group')
    }
    return {
      ok: true,
      destination: {
        type: provider,
        target: known.space.spaceId,
        audienceScopeId: `group:${provider}:${known.space.spaceId}`,
      },
      group: { spaceId: known.space.spaceId, ...(known.space.name ? { name: known.space.name } : {}) },
    }
  }
  return {
    ok: false,
    status: 400,
    error: 'bad_request',
    message: 'name a recipient (a teammate), a channel, or a group\'s participants',
  }
}
