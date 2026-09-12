/**
 * Principal identity and scope identifiers.
 *
 * A principal is the authenticated actor behind a turn. Scopes are the
 * authorization partitions data (sessions, credentials, directory) lives in.
 */
export type PrincipalType = 'internal' | 'guest'

export const PRINCIPAL_TYPES = ['internal', 'guest'] as const satisfies readonly PrincipalType[]

export function isPrincipalType(value: unknown): value is PrincipalType {
  return typeof value === 'string' && (PRINCIPAL_TYPES as readonly string[]).includes(value)
}

export interface Principal {
  id: string
  type: PrincipalType
  teamIds?: string[]
  displayName?: string
}

export const SCOPE_KINDS = ['personal', 'channel', 'team', 'org', 'group'] as const

export type ScopeKind = (typeof SCOPE_KINDS)[number]

export type ScopeId = string

export function scopeId(kind: ScopeKind, ref: string): ScopeId {
  return `${kind}:${ref}`
}

export function personalScope(principalId: string): ScopeId {
  return scopeId('personal', principalId)
}

export function parseScopeId(id: ScopeId): { kind: ScopeKind | null; ref: string } {
  const sep = id.indexOf(':')
  if (sep < 0) return { kind: null, ref: '' }
  const raw = id.slice(0, sep)
  return { kind: (SCOPE_KINDS as readonly string[]).includes(raw) ? (raw as ScopeKind) : null, ref: id.slice(sep + 1) }
}
