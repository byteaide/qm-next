/**
 * M3 reach contract (15.0, lane-opening freeze): resolve a user-stated
 * target — a recipient (teammate), a channel, or a group's participants —
 * into a `Destination`, with member checks and visibility filtering.
 * Surface-neutral port of qm's `resolveReachTarget`; the directory slice it
 * needs is structural, so tests can substitute any `DirectoryStore`.
 *
 * OUT of M3: provider write-back — an unknown group resolves to
 * `group_not_found`. Parity 15.0 restores the write-back: an adapter may
 * supply `openGroup`/`registerGroup` and the caller `mayOpenGroup`, and
 * the group flow opens the group through the provider, registers it back
 * into the directory, and resolves to it.
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
      status: 400 | 403 | 404 | 409 | 502
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
  /**
   * Provider write-back: open a group with exactly these participants
   * (including the actor). Null when the provider cannot answer; an
   * adapter that never opens groups omits it.
   */
  openGroup?(provider: string, participantIds: readonly string[]): Promise<{ spaceId: string } | { error: string } | null>
  /** Best-effort roster registration for a group the provider just opened. */
  registerGroup?(provider: string, spaceId: string, participantIds: readonly string[]): Promise<void>
}

/** Resolution options: only `mayOpenGroup` today. */
export interface ReachOpts {
  mayOpenGroup?: boolean
}

/** Adapt a full `DirectoryStore` to the structural `ReachDirectory` slice. */
export function reachDirectory(
  store: Pick<
    ReachDirectory,
    'resolvePerson' | 'resolveSpace' | 'spaceMember' | 'resolveGroupByParticipants' | 'getPerson'
  >,
): ReachDirectory {
  return {
    ...store,
    isVisible: (provider, actorProviderUserId, space) => isVisible(store, provider, actorProviderUserId, space),
  }
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
  opts: ReachOpts = {},
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
    const participants = [...new Set([...named, actorProviderUserId])]
    if (participants.length < 2) {
      return {
        ok: false,
        status: 400,
        error: 'bad_request',
        message: "a group needs someone besides you — name a `recipient` instead for a 1:1 DM",
      }
    }
    participants.sort()
    const known = await dir.resolveGroupByParticipants(provider, participants)
    if (known.kind === 'one') {
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
    if (!opts.mayOpenGroup || !dir.openGroup) {
      return {
        ok: false,
        status: 404,
        error: 'group_not_found',
        message: dir.openGroup
          ? 'no group I\'m in has exactly those participants — post to it once, which opens it, then address it here'
          : 'no group with exactly those participants (it may not have synced yet)',
      }
    }
    if (!(await dir.getPerson(provider, actorProviderUserId))) {
      return membershipDenial(false, 'group')
    }
    const opened = await dir.openGroup(provider, participants)
    if (!opened || 'error' in opened) {
      return {
        ok: false,
        status: 502,
        error: 'group_open_failed',
        message:
          opened?.error ?? 'I couldn\'t open a group with those people just now — try again in a moment',
      }
    }
    await dir.registerGroup?.(provider, opened.spaceId, participants).catch(() => {})
    return {
      ok: true,
      destination: {
        type: provider,
        target: opened.spaceId,
        audienceScopeId: `group:${provider}:${opened.spaceId}`,
      },
      group: { spaceId: opened.spaceId },
    }
  }
  return {
    ok: false,
    status: 400,
    error: 'bad_request',
    message: 'name a recipient (a teammate), a channel, or a group\'s participants',
  }
}
