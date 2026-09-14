/**
 * Person identity matching, ported from qm's `src/directory/person.ts`
 * (the OUT-of-M3 heuristics, landed with parity 15.0). A person matches
 * when raw ids are equal after email normalization, or when either side's
 * directory record links the two ids (principal id / email).
 */
import type { DirectoryPersonRecord } from './contract.ts'

export function personKey(id: string | null | undefined): string {
  const s = (id ?? '').trim()
  return s.includes('@') ? s.toLowerCase() : s
}

export function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = personKey(a)
  return key !== '' && key === personKey(b)
}

/** Structural slice of a directory person relevant to identity matching. */
export interface RosterPerson {
  principalId?: string
  email?: string
}

export function personKeys(member: RosterPerson | null | undefined, rawId: string): Set<string> {
  const keys = new Set<string>()
  for (const id of [rawId, member?.principalId, member?.email]) {
    const key = personKey(id)
    if (key) keys.add(key)
  }
  return keys
}

function toRosterPerson(record: DirectoryPersonRecord | null): RosterPerson | null {
  if (!record) return null
  return { principalId: record.principalId, ...(record.email ? { email: record.email } : {}) }
}

export interface DirectoryPersonLookup {
  listPeople(provider?: string): Promise<DirectoryPersonRecord[]>
}

async function personByPrincipal(
  lookup: DirectoryPersonLookup,
  provider: string,
  principalId: string,
): Promise<RosterPerson | null> {
  const people = await lookup.listPeople(provider).catch(() => [])
  return toRosterPerson(people.find((p) => p.principalId === principalId) ?? null)
}

export async function samePersonInDirectory(
  lookup: DirectoryPersonLookup,
  provider: string,
  a: string,
  b: string,
): Promise<boolean> {
  if (samePerson(a, b)) return true
  if (!personKey(a) || !personKey(b)) return false
  const [ma, mb] = await Promise.all([
    personByPrincipal(lookup, provider, a),
    personByPrincipal(lookup, provider, b),
  ])
  const bKeys = personKeys(mb, b)
  for (const key of personKeys(ma, a)) if (bKeys.has(key)) return true
  return false
}

/**
 * Matcher for one actor: cheap key-set hits first; falls back to a
 * directory round-trip only when the actor's own record is unknown.
 */
export async function samePersonMatcher(
  lookup: DirectoryPersonLookup,
  provider: string,
  actorId: string,
): Promise<(id: string) => Promise<boolean>> {
  const row = await personByPrincipal(lookup, provider, actorId).catch(() => null)
  const keys = personKeys(row, actorId)
  return async (id) => {
    if (keys.has(personKey(id))) return true
    if (row) return false
    return samePersonInDirectory(lookup, provider, id, actorId)
  }
}
