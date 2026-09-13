import { errMessage } from '@qm/credentials'

export { errMessage }

export const sleep = (ms: number, opts?: { unref?: boolean }): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (opts?.unref) timer.unref?.()
  })

export function createKeyedQueue<K = string>(): <T>(key: K, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<K, Promise<void>>()
  return (key, fn) => {
    const prev = tails.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return run
  }
}

export function swallow(context: string, e: unknown): void {
  console.warn(`[swallowed] ${context}: ${errMessage(e)}`)
}

export function swallowAs<T>(context: string, fallback: T): (e: unknown) => T {
  return (e) => {
    swallow(context, e)
    return fallback
  }
}
