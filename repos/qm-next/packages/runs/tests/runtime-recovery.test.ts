/**
 * Runtime handoff recovery contract suite (M-Tape-2, 2026-09-26).
 *
 * Asserts `recoveredRuntime` walks the session entry log in reverse,
 * returns the most recent matching `tool_result` for `tool='runtime'`
 * whose `runtimeHandoff.choice` validates against `RuntimeChoice`,
 * and returns `undefined` when nothing matches. The recovery is the
 * orchestrator's fallback path for reaped-run resumes (M-Tape-2 wires
 * it into `resolveChoice` so a previous turn's engine/model pair
 * survives the resume — see A.2.2 in `todo/tasks/tasks-qm-post-soul.md`).
 *
 * Source-of-truth (qm, 2026-09-26):
 * - `repos/qm/src/harness/runtime-recovery.ts:1-33`
 * - `repos/qm/src/harness/harness.ts` `RuntimeChoice` (qm-next's narrower
 *   shape — see `docs/session-tape-spec.md` §What this buys).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ScopeId, SessionEntry } from '@qm/types'
import { recoveredRuntime } from '../src/runtime-recovery.ts'

const SCOPE: ScopeId = 'scope:test:runtime-recovery' as ScopeId

function entry(seq: number, type: SessionEntry['type'], payload: unknown): SessionEntry {
  return {
    sessionId: 'sess-1',
    seq,
    parentSeq: seq === 0 ? null : seq - 1,
    type,
    payload,
    scopeLabel: SCOPE,
    createdAt: 1_700_000_000_000 + seq,
  }
}

function runtimeEntry(seq: number, runId: string, actorId: string, choice: { harnessId: string; modelId: string }): SessionEntry {
  return entry(seq, 'tool_result', {
    tool: 'runtime',
    runId,
    actorId,
    runtimeHandoff: { choice },
  })
}

test('returns the most recent of three consecutive runtime tool_results', () => {
  const entries: SessionEntry[] = [
    entry(0, 'user', { text: 'first' }),
    runtimeEntry(1, 'run-A', 'alice', { harnessId: 'pi', modelId: 'sonnet-1' }),
    runtimeEntry(2, 'run-A', 'alice', { harnessId: 'pi', modelId: 'sonnet-2' }),
    runtimeEntry(3, 'run-A', 'alice', { harnessId: 'pi', modelId: 'sonnet-3' }),
  ]
  const choice = recoveredRuntime(entries, 'run-A', 'alice')
  assert.ok(choice)
  assert.equal(choice.harnessId, 'pi')
  assert.equal(choice.modelId, 'sonnet-3')
})

test('returns undefined when no entry matches runId', () => {
  const entries: SessionEntry[] = [
    runtimeEntry(0, 'run-A', 'alice', { harnessId: 'pi', modelId: 'sonnet-1' }),
    runtimeEntry(1, 'run-A', 'alice', { harnessId: 'pi', modelId: 'sonnet-2' }),
  ]
  const choice = recoveredRuntime(entries, 'run-B', 'alice')
  assert.equal(choice, undefined)
})

test('returns undefined when no entry matches actorId', () => {
  const entries: SessionEntry[] = [
    runtimeEntry(0, 'run-A', 'alice', { harnessId: 'pi', modelId: 'sonnet-1' }),
    runtimeEntry(1, 'run-A', 'alice', { harnessId: 'pi', modelId: 'sonnet-2' }),
  ]
  const choice = recoveredRuntime(entries, 'run-A', 'bob')
  assert.equal(choice, undefined)
})

test('skips unrelated tool_result entries and finds the runtime one', () => {
  const entries: SessionEntry[] = [
    entry(0, 'tool_result', { tool: 'exec', callId: 'c1', result: 'ls' }),
    runtimeEntry(1, 'run-A', 'alice', { harnessId: 'pi', modelId: 'sonnet-1' }),
    entry(2, 'tool_result', { tool: 'memory', callId: 'c2', result: 'fact' }),
    runtimeEntry(3, 'run-A', 'alice', { harnessId: 'pi', modelId: 'sonnet-2' }),
  ]
  const choice = recoveredRuntime(entries, 'run-A', 'alice')
  assert.ok(choice)
  assert.equal(choice.modelId, 'sonnet-2')
})

test('rejects runtime tool_result with non-runtime handoff shape', () => {
  const entries: SessionEntry[] = [
    entry(0, 'tool_result', { tool: 'runtime', runId: 'run-A', actorId: 'alice', runtimeHandoff: 'not-an-object' }),
    runtimeEntry(1, 'run-A', 'alice', { harnessId: 'pi', modelId: 'sonnet-2' }),
  ]
  const choice = recoveredRuntime(entries, 'run-A', 'alice')
  assert.ok(choice)
  assert.equal(choice.modelId, 'sonnet-2')
})

test('rejects runtime tool_result with invalid choice harnessId', () => {
  const entries: SessionEntry[] = [
    entry(0, 'tool_result', {
      tool: 'runtime',
      runId: 'run-A',
      actorId: 'alice',
      runtimeHandoff: { choice: { harnessId: 123, modelId: 'sonnet-1' } },
    }),
    runtimeEntry(1, 'run-A', 'alice', { harnessId: 'pi', modelId: 'sonnet-2' }),
  ]
  const choice = recoveredRuntime(entries, 'run-A', 'alice')
  assert.ok(choice)
  assert.equal(choice.modelId, 'sonnet-2')
})

test('rejects runtime tool_result with non-string modelId', () => {
  const entries: SessionEntry[] = [
    entry(0, 'tool_result', {
      tool: 'runtime',
      runId: 'run-A',
      actorId: 'alice',
      runtimeHandoff: { choice: { harnessId: 'pi', modelId: 42 } },
    }),
    runtimeEntry(1, 'run-A', 'alice', { harnessId: 'pi', modelId: 'sonnet-2' }),
  ]
  const choice = recoveredRuntime(entries, 'run-A', 'alice')
  assert.ok(choice)
  assert.equal(choice.modelId, 'sonnet-2')
})

test('returns undefined when the only runtime entry has an invalid choice and nothing else matches', () => {
  const entries: SessionEntry[] = [
    entry(0, 'tool_result', {
      tool: 'runtime',
      runId: 'run-A',
      actorId: 'alice',
      runtimeHandoff: { choice: { harnessId: 42 } },
    }),
  ]
  const choice = recoveredRuntime(entries, 'run-A', 'alice')
  assert.equal(choice, undefined)
})

test('ignores harness mismatch on a foreign-harness runtime entry', () => {
  const entries: SessionEntry[] = [
    runtimeEntry(0, 'run-A', 'alice', { harnessId: 'unknown-engine', modelId: 'sonnet-1' }),
  ]
  const choice = recoveredRuntime(entries, 'run-A', 'alice')
  assert.equal(choice, undefined)
})

test('walks in reverse so the latest matching runtime entry wins', () => {
  const entries: SessionEntry[] = [
    runtimeEntry(0, 'run-A', 'alice', { harnessId: 'pi', modelId: 'sonnet-1' }),
    entry(1, 'user', { text: 'mid' }),
    runtimeEntry(2, 'run-A', 'alice', { harnessId: 'pi', modelId: 'sonnet-2' }),
    entry(3, 'assistant', { text: 'reply' }),
    runtimeEntry(4, 'run-A', 'alice', { harnessId: 'pi', modelId: 'sonnet-3' }),
  ]
  const choice = recoveredRuntime(entries, 'run-A', 'alice')
  assert.ok(choice)
  assert.equal(choice.modelId, 'sonnet-3')
})

test('returns undefined when the only runtime entry is for a different run', () => {
  const entries: SessionEntry[] = [
    runtimeEntry(0, 'run-A', 'alice', { harnessId: 'pi', modelId: 'sonnet-1' }),
    runtimeEntry(1, 'run-B', 'alice', { harnessId: 'pi', modelId: 'sonnet-2' }),
  ]
  const choice = recoveredRuntime(entries, 'run-A', 'alice')
  assert.ok(choice)
  assert.equal(choice.modelId, 'sonnet-1')
})