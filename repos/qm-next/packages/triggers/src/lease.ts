/**
 * Tick leases (cron scheduler seam).
 *
 * Phase 4 §4.6 — the memory lease primitive lives in `@qm/concurrency`
 * so neither API nor Triggers needs to import the other. The Postgres
 * lease uses the `@qm/store` pg pool; it stays behind the Trigger
 * boundary because pg-pool lifecycle is Trigger-managed.
 */
import { createPgPool, errMessage, type PgPool, type PoolClient } from '@qm/store'
import type { LeaderLease } from '@qm/concurrency'
export { createMemoryLeaderLease, type LeaderLease } from '@qm/concurrency'

export function createPostgresLeaderLease(connectionString: string): LeaderLease {
  const pool: PgPool = createPgPool(connectionString, [])
  let client: PoolClient | null = null
  let connecting: Promise<PoolClient> | null = null

  function drop(dead: PoolClient): void {
    if (client !== dead) return
    client = null
    try {
      dead.release(true)
    } catch (e) {
      console.error('[leader-lease:pg] client release failed:', errMessage(e))
    }
  }

  async function acquire(): Promise<PoolClient> {
    if (client) return client
    connecting ??= (async () => {
      const c = await (await pool.pool()).connect()
      c.on('error', () => drop(c))
      client = c
      return c
    })().catch((e) => {
      connecting = null
      throw e
    })
    return connecting
  }

  return {
    async hold<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
      const c = await acquire()
      const won = await c
        .query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS won', [`leader-lease:${key}`])
        .then((res) => res.rows[0]?.won === true)
        .catch((e: unknown) => {
          drop(c)
          throw e
        })
      if (!won) return null
      try {
        return await fn()
      } finally {
        const released = await c
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released', [`leader-lease:${key}`])
          .then((res) => res.rows[0]?.released === true)
          .catch(() => false)
        if (!released) drop(c)
      }
    },
    close: () => pool.close(),
  }
}