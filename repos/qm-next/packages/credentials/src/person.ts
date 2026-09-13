export function personKey(id: string | null | undefined): string {
  const s = (id ?? '').trim()
  return s.includes('@') ? s.toLowerCase() : s
}

export function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = personKey(a)
  return key !== '' && key === personKey(b)
}
