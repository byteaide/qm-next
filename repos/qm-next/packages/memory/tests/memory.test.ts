/**
 * Memory suite (14.0): ScopeMemory parity across the in-process and
 * Postgres implementations (revision conflict detection, fold/dedup/cap,
 * recall, query, history/restore) plus the resolution seam. Postgres cases
 * skip when QM_NEXT_PG_URL is unreachable; memory cases always run.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScopeId } from '@qm/types'
import type { ScopeMemory } from '../src/index.ts'
import {
  MEMORY_MAX_FACTS,
  createMemoryScopeMemory,
  createPostgresScopeMemory,
  dateStr,
  foldCapture,
  memoryRecallBlock,
  normalize,
  wrapResolutionWithMemory,
} from '../src/index.ts'
import { MEMORY_SCHEMA_STATEMENTS } from '../src/postgres-store.ts'
import { Pool } from 'pg'

const T0 = 1_757_000_000_000
const SCOPE: ScopeId = 'org:default'
const pgUrl = process.env.QM_NEXT_PG_URL

interface Harness {
  memory: ScopeMemory
  close(): Promise<void>
}

function memoryHarness(): () => Promise<Harness> {
  return async () => ({ memory: createMemoryScopeMemory(), close: async () => undefined })
}

async function resetMemoryTables(): Promise<boolean> {
  if (!pgUrl) return false
  const probe = new Pool({ connectionString: pgUrl, connectionTimeoutMillis: 3000 })
  try {
    await probe.query('SELECT 1')
  } catch {
    return false
  } finally {
    await probe.end().catch(() => undefined)
  }
  const { createPgPool } = await import('@qm/store')
  const pool = createPgPool(pgUrl, MEMORY_SCHEMA_STATEMENTS)
  await pool.query('SELECT 1')
  await pool.q('DROP TABLE IF EXISTS memory_revisions')
  await pool.close()
  return true
}

function pgHarness(): () => Promise<Harness> {
  return async () => {
    await resetMemoryTables()
    const memory = createPostgresScopeMemory(pgUrl!)
    return { memory, close: async () => memory.close?.() }
  }
}

async function scopeMemoryCases(t: import('node:test').TestContext, make: () => Promise<Harness>): Promise<void> {
  await t.test('append folds dated bullets under the header and dedupes by normalized text', async () => {
    const h = await make()
    try {
      const added = await h.memory.append(SCOPE, ['deploys happen on tuesdays'], T0)
      assert.equal(added, 1)
      const body = await h.memory.get(SCOPE)
      assert.equal(body, `# Memory\n\n- (${dateStr(T0)}) deploys happen on tuesdays\n`)
      assert.equal(await h.memory.append(SCOPE, ['deploys happen on TUESDAYS'], T0 + 1), 0)
      assert.equal(await h.memory.append(SCOPE, [], T0 + 2), 0)
      const head = await h.memory.head(SCOPE)
      assert.equal(head.revision, '1')
      assert.ok(head.updatedAt)
    } finally {
      await h.close()
    }
  })

  await t.test('untrusted provenance is rewritten; cc: authors keep their words', async () => {
    const h = await make()
    try {
      await h.memory.append(SCOPE, ['(2026-01-02) the launch is on Friday (said in #eng)'], T0)
      const body = await h.memory.get(SCOPE)
      assert.match(body, /on 2026-01-02: the launch is on Friday \[claimed source: #eng\]/)
      await h.memory.append('personal:u1', ['the launch is on Friday (said in #eng)'], T0, 'cc:org:default')
      const trusted = await h.memory.get('personal:u1')
      assert.match(trusted, /\(said in #eng\)/)
      assert.equal(foldCapture('', ['keep (said in x)'], T0, true).body, `# Memory\n\n- (${dateStr(T0)}) keep (said in x)`)
    } finally {
      await h.close()
    }
  })

  await t.test('notebook caps facts at 300 and drops the oldest first', async () => {
    const h = await make()
    try {
      const facts = Array.from({ length: MEMORY_MAX_FACTS + 10 }, (_, i) => `fact number ${i}`)
      assert.equal(await h.memory.append(SCOPE, facts, T0), MEMORY_MAX_FACTS + 10)
      const body = await h.memory.get(SCOPE)
      const lines = body.split('\n').filter((l) => l.startsWith('- '))
      assert.equal(lines.length, MEMORY_MAX_FACTS)
      assert.equal(lines[0], `- (${dateStr(T0)}) fact number 10`)
      assert.match(body, /fact number 309/)
      assert.doesNotMatch(body, /fact number 0\n/)
      assert.equal(await h.memory.append(SCOPE, [`fact number ${MEMORY_MAX_FACTS + 10}`], T0 + 1), 1)
      const after = await h.memory.get(SCOPE)
      assert.equal(after.split('\n').filter((l) => l.startsWith('- ')).length, MEMORY_MAX_FACTS)
      assert.doesNotMatch(after, new RegExp(`fact number 10\\n`))
    } finally {
      await h.close()
    }
  })

  await t.test('recall trims and caps to the tail; empty scopes recall empty', async () => {
    const h = await make()
    try {
      assert.equal(await h.memory.recall(SCOPE), '')
      await h.memory.append(SCOPE, ['alpha fact', 'beta fact'], T0)
      const recalled = await h.memory.recall(SCOPE)
      assert.match(recalled, /alpha fact/)
      assert.ok(recalled.length <= 6_000)
      const capped = await h.memory.recall(SCOPE, { maxChars: 30 })
      assert.ok(capped.length <= 30)
      assert.match(capped, /beta fact/)
      assert.ok(await h.memory.recall('personal:nobody') === '')
    } finally {
      await h.close()
    }
  })

  await t.test('query AND-matches terms across bullets with a limit', async () => {
    const h = await make()
    try {
      await h.memory.append(SCOPE, ['deploy runs on Tuesdays', 'deploys need a green build', 'lunch is at noon'], T0)
      assert.deepEqual(await h.memory.query(SCOPE, 'deploys green'), [`(${dateStr(T0)}) deploys need a green build`])
      assert.deepEqual(await h.memory.query(SCOPE, 'deploy', 1), [`(${dateStr(T0)}) deploy runs on Tuesdays`])
      assert.deepEqual(await h.memory.query(SCOPE, ''), [])
      assert.deepEqual(await h.memory.query(SCOPE, 'nonexistent-term'), [])
    } finally {
      await h.close()
    }
  })

  await t.test('replace normalizes trailing whitespace, clears on empty, and skips no-op writes', async () => {
    const h = await make()
    try {
      await h.memory.replace(SCOPE, '# Memory\n\n- (2026-01-02) handwritten note   \n\n')
      assert.equal(await h.memory.get(SCOPE), '# Memory\n\n- (2026-01-02) handwritten note\n')
      const head = await h.memory.head(SCOPE)
      await h.memory.replace(SCOPE, '# Memory\n\n- (2026-01-02) handwritten note\n')
      assert.equal((await h.memory.head(SCOPE)).revision, head.revision)
      await h.memory.replace(SCOPE, '   ')
      assert.equal(await h.memory.get(SCOPE), '')
      assert.equal((await h.memory.head(SCOPE)).content, '')
      assert.equal(await h.memory.replaceIfRevision(SCOPE, 'x', '999'), false)
    } finally {
      await h.close()
    }
  })

  await t.test('replaceIfRevision is a compare-and-swap on the head revision', async () => {
    const h = await make()
    try {
      const empty = await h.memory.head(SCOPE)
      assert.equal(empty.revision, '0')
      await h.memory.append(SCOPE, ['first fact'], T0)
      const head = await h.memory.head(SCOPE)
      assert.equal(await h.memory.replaceIfRevision(SCOPE, '# Memory\n\nreplaced once', empty.revision), false)
      assert.equal(await h.memory.replaceIfRevision(SCOPE, '# Memory\n\nreplaced once', head.revision), true)
      assert.equal(await h.memory.replaceIfRevision(SCOPE, '# Memory\n\nreplaced twice', head.revision), false)
      assert.match(await h.memory.get(SCOPE), /replaced once/)
      assert.equal(await h.memory.replaceIfRevision(SCOPE, 'not-a-revision-content', 'abc'), false)
    } finally {
      await h.close()
    }
  })

  await t.test('history lists revisions newest-first and restore is guarded by the expected revision', async () => {
    const h = await make()
    try {
      await h.memory.append(SCOPE, ['fact one'], T0)
      await h.memory.replace(SCOPE, '# Memory\n\nrewritten')
      const history = (await h.memory.history?.(SCOPE)) ?? []
      assert.equal(history.length, 2)
      assert.equal(history[0]!.operation, 'replace')
      assert.equal(history[1]!.operation, 'capture')
      assert.match(history[1]!.content, /fact one/)
      const head = await h.memory.head(SCOPE)
      assert.equal(await h.memory.restore?.(SCOPE, history[1]!.revision, head.revision, 'restorer'), true)
      assert.match(await h.memory.get(SCOPE), /fact one/)
      assert.equal(await h.memory.restore?.(SCOPE, history[1]!.revision, head.revision), false)
      assert.equal(await h.memory.restore?.(SCOPE, '404', head.revision), false)
      const capped = (await h.memory.history?.(SCOPE, 1)) ?? []
      assert.equal(capped.length, 1)
    } finally {
      await h.close()
    }
  })

  await t.test('updatedAt and metadata reflect the latest revision', async () => {
    const h = await make()
    try {
      assert.equal(await h.memory.updatedAt?.(SCOPE), undefined)
      await h.memory.append(SCOPE, ['métadonnées fact'], T0)
      assert.equal(await h.memory.updatedAt?.(SCOPE), T0)
      const meta = (await h.memory.metadata?.()) ?? new Map()
      const entry = meta.get(SCOPE)
      assert.ok(entry)
      assert.equal(entry!.bytes, Buffer.byteLength(await h.memory.get(SCOPE), 'utf8'))
      assert.equal(entry!.updatedAt, T0)
      assert.equal(meta.has('personal:nobody'), false)
    } finally {
      await h.close()
    }
  })
}

test('scope memory (in-process)', async (t) => {
  await scopeMemoryCases(t, memoryHarness())
})

if (pgUrl) {
  const pgReady = await resetMemoryTables()
  if (pgReady) {
    test('scope memory (postgres parity)', async (t) => {
      await scopeMemoryCases(t, pgHarness())
    })
  } else {
    test('scope memory (postgres parity) — server unreachable, skipped', async () => {
      assert.equal(pgReady, false)
    })
  }
}

test('postgres memory parity: identical op sequences converge to identical notebooks', async (t) => {
  if (!pgUrl || !(await resetMemoryTables())) return t.skip('no postgres')
  const mem = createMemoryScopeMemory()
  const pg = createPostgresScopeMemory(pgUrl!)
  try {
    const ops: Array<{ scope: ScopeId; facts: string[] }> = [
      { scope: SCOPE, facts: ['shared fact one', 'shared fact two'] },
      { scope: SCOPE, facts: ['shared fact one'] },
      { scope: 'personal:u2', facts: ['personal note'] },
    ]
    for (const [i, op] of ops.entries()) {
      assert.equal(await mem.append(op.scope, op.facts, T0 + i), await pg.append(op.scope, op.facts, T0 + i))
    }
    await mem.replace(SCOPE, '# Memory\n\nrewritten identically')
    await pg.replace(SCOPE, '# Memory\n\nrewritten identically')
    for (const scope of [SCOPE, 'personal:u2']) {
      const memHead = await mem.head(scope)
      const pgHead = await pg.head(scope)
      assert.equal(pgHead.content, memHead.content)
      assert.equal(pgHead.revision, memHead.revision)
      const memHistory = (await mem.history?.(scope)) ?? []
      const pgHistory = (await pg.history?.(scope)) ?? []
      assert.deepEqual(
        pgHistory.map((r) => [r.revision, r.operation, r.content]),
        memHistory.map((r) => [r.revision, r.operation, r.content]),
      )
    }
  } finally {
    await pg.close?.()
  }
})

test('resolution seam appends the recall block and fails open', async (t) => {
  const inner = {
    resolve: async () => ({ systemPrompt: 'base prompt', orgScopeId: SCOPE }),
    scopeFor: () => SCOPE,
  }
  const conversation = { kind: 'channel' as const, threadRef: 't', audience: [] }
  const actor = { id: 'u1', type: 'internal' as const }

  await t.test('recalled memory lands in the system prompt with the context label', async () => {
    const memory = createMemoryScopeMemory()
    await memory.append(SCOPE, ['remember the biweekly demo'], T0)
    const wrapped = wrapResolutionWithMemory(inner, memory, () => ({ read: [SCOPE], context: '#eng' }))
    const result = await wrapped.resolve(conversation, actor)
    assert.match(result.systemPrompt, /^base prompt\n\n## What you remember\nYou're in #eng\./)
    assert.match(result.systemPrompt, /remember the biweekly demo/)
    assert.equal(result.orgScopeId, SCOPE)
  })

  await t.test('empty recall and absent selection leave the prompt untouched', async () => {
    const memory = createMemoryScopeMemory()
    const wrapped = wrapResolutionWithMemory(inner, memory, () => ({ read: [SCOPE] }))
    assert.equal((await wrapped.resolve(conversation, actor)).systemPrompt, 'base prompt')
    const off = wrapResolutionWithMemory(inner, memory, () => undefined)
    assert.equal((await off.resolve(conversation, actor)).systemPrompt, 'base prompt')
  })

  await t.test('a broken store skips the block instead of failing the turn', async () => {
    const broken: ScopeMemory = {
      ...createMemoryScopeMemory(),
      recall: async () => {
        throw new Error('storage down')
      },
    }
    const wrapped = wrapResolutionWithMemory(inner, broken, () => ({ read: [SCOPE, 'personal:u1'] }))
    assert.equal((await wrapped.resolve(conversation, actor)).systemPrompt, 'base prompt')
  })

  await t.test('block renderer matches the qm wording', () => {
    assert.equal(
      memoryRecallBlock('fact', 'a direct message'),
      `\n\n## What you remember\nYou're in a direct message. A memory tagged \`(said in …)\` was stated in another context — apply it only if that tag matches here; untagged memories are general.\n\nfact`,
    )
  })
})

test('notebook grammar: normalize strips markers, dates, and case', () => {
  assert.equal(normalize('- (2026-01-02) Mixed CASE fact'), 'mixed case fact')
  assert.equal(normalize('* another bullet'), 'another bullet')
})
