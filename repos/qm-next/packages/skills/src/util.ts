/** Per-package copies of the shared async/error/sweeper helpers (qm util family). */

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

export interface Sweeper {
  start(intervalMs?: number): void
  stop(): void
}

export function createSweeper(
  fn: () => unknown,
  defaultIntervalMs: number,
  opts: { label?: string; immediate?: boolean } = {},
): Sweeper {
  const label = opts.label ?? 'sweeper'
  let timer: ReturnType<typeof setInterval> | null = null
  const sweep = (): void => {
    try {
      void Promise.resolve(fn()).catch(swallowAs(`${label}: sweep failed`, undefined))
    } catch (e) {
      swallow(`${label}: sweep failed`, e)
    }
  }
  return {
    start(intervalMs?: number) {
      if (timer) return
      timer = setInterval(sweep, intervalMs ?? defaultIntervalMs)
      timer.unref?.()
      if (opts.immediate) sweep()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

export function swallowAs<T>(_context: string, fallback: T): (e: unknown) => T {
  return () => fallback
}
