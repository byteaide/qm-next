/** Per-package copies of the shared async/error helpers (qm util family). */

export function createKeyedQueue<K = string>(): <T>(key: K, fn: () => Promise<T>) => Promise<T> {
  const chains = new Map<K, Promise<unknown>>()
  return <T>(key: K, fn: () => Promise<T>): Promise<T> => {
    const prior = chains.get(key) ?? Promise.resolve()
    const next = prior.then(fn, fn)
    chains.set(
      key,
      next.catch(() => undefined),
    )
    return next
  }
}

export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return typeof e === 'string' ? e : JSON.stringify(e)
}

export function swallow(context: string, e: unknown): void {
  console.error(`[swallowed] ${context}:`, errMessage(e))
}
