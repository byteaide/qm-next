/**
 * Minimal Postgres pool with advisory-locked schema application.
 *
 * Trimmed translation of qm's `src/persistence/pg-pool.ts`: keeps the
 * single-statement DDL discipline, the schema-init advisory lock and the
 * transaction helper; CA trust and abort-signal plumbing stay out of M1.
 */
import type { Pool, PoolClient } from 'pg'

export type { Pool, PoolClient }

export type Rows = Record<string, unknown>[]

export interface PgPool {
  pool(): Promise<Pool>
  q(text: string, params?: unknown[]): Promise<Rows>
  query(text: string, params?: unknown[]): Promise<{ rows: Rows; rowCount: number }>
  close(): Promise<void>
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function withPgTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export function assertOneStatement(stmt: string): void {
  const bare = stmt
    .replace(/--[^\n]*/g, '')
    .replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '')
    .replace(/'(?:[^']|'')*'/g, '')
    .replace(/;\s*$/, '')
  if (bare.includes(';')) {
    throw new Error(`pg-pool: each schema element must be a single statement (found ';' in: ${stmt.slice(0, 80)}…)`)
  }
}

/**
 * Run schema statements under the shared `qm-next:schema-init` advisory
 * lock. Concurrent boot DDL races CREATE TABLE IF NOT EXISTS on
 * pg_catalog.pg_type (duplicate key 23505, pg_type_typname_nsp_index):
 * two sessions pass the existence check before either commits the type
 * row. Holding the session-level lock across the whole batch serializes
 * every schema creator — the eager createPgPool applyDdl and the lazy
 * DurableMap ensures alike — so the IF NOT EXISTS re-check stays safe.
 */
export async function withSchemaLock<T>(
  pool: Pool,
  run: (q: (text: string) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock(hashtext(\'qm-next:schema-init\'))')
    try {
      return await run((text) => client.query(text))
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext(\'qm-next:schema-init\'))').catch(() => undefined)
    }
  } finally {
    client.release()
  }
}

async function applyDdl(pool: Pool, statements: string[]): Promise<void> {
  await withSchemaLock(pool, async (q) => {
    for (const stmt of statements) await q(stmt)
  })
}

export function createPgPool(connectionString: string, statements: string[]): PgPool {
  const schema = statements.map((s) => s.trim()).filter((s) => s.length > 0)
  for (const stmt of schema) assertOneStatement(stmt)
  let poolP: Promise<Pool> | null = null
  function pool(): Promise<Pool> {
    if (!poolP) {
      poolP = (async () => {
        const pg = (await import('pg')).default
        const p = new pg.Pool({ connectionString })
        p.on('error', (err) => console.error('[pg] idle client error:', errMessage(err)))
        try {
          await applyDdl(p, schema)
        } catch (e) {
          await p.end().catch(() => undefined)
          throw e
        }
        return p
      })().catch((e) => {
        poolP = null
        throw e
      })
      return poolP
    }
    return poolP
  }
  async function query(text: string, params: unknown[] = []): Promise<{ rows: Rows; rowCount: number }> {
    const p = await pool()
    const res = await p.query(text, params)
    return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 }
  }
  async function q(text: string, params: unknown[] = []): Promise<Rows> {
    return (await query(text, params)).rows
  }
  async function close(): Promise<void> {
    if (poolP) await (await poolP).end()
  }
  // Schema ownership fires at construction (20.0): "start once against an
  // empty database" must land the DDL without waiting for a first query.
  // A failed build stays retryable — poolP resets and the first real query
  // surfaces the error.
  pool().catch(() => undefined)
  return { pool, q, query, close }
}
