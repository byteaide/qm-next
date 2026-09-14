/**
 * Person identity keys (qm `src/directory/person.ts` core pair): email-like
 * ids normalise case, plain ids stay verbatim, so grants and attribution
 * match `alice@Org` and `alice@org` as one person.
 */
export function personKey(id: string | null | undefined): string {
  const s = (id ?? '').trim()
  return s.includes('@') ? s.toLowerCase() : s
}

export function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = personKey(a)
  return key !== '' && key === personKey(b)
}
