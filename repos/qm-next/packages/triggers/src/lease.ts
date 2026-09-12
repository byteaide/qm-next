/**
 * Tick leases. Memory: single-process holder set (one holder per key).
 * Postgres: `pg_try_advisory_lock` on a dedicated connection, dropped when
 * the connection dies (its locks auto-release). Both back the scheduler
 * tick; the durable once-per-slot gate remains `CronStore.claimSlot`.
 */
import { createPgPool, errMessage, type PgPool, type PoolClient } from '@qm/store'
import type { LeaderLease } from './contract.ts'

export function createMemoryLeaderLease(): LeaderLease {
  const held = new Set<string>()
  return {
    async hold<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
      if (held.has(key)) return null
      held.add(key)
      try {
        return await fn()
      } finally {
        held.delete(key)
      }
    },
    async close() {},
  }
}

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
