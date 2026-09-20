/**
 * Profile smoke tests: boot a kernel from YAML entry lists via `bootProfile`,
 * covering mounting, `!!js` interpolation, failed imports, and the repository
 * profile.
 *
 * Fixtures are copied into `tests/.tmp/` before booting: each run gets a fresh
 * file (Include writes back on unmount), and the copy keeps module resolution
 * inside the workspace so `@qm/demo` resolves through `packages/boot`.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { mintSignedPayload } from '@qm/api'
import { bootProfile } from '@qm/boot'

async function stageFixture(name: string): Promise<string> {
  const tmpDir = new URL('./.tmp/', import.meta.url)
  await mkdir(tmpDir, { recursive: true })
  const target = new URL(`./.tmp/${name}-${randomBytes(4).toString('hex')}.yml`, import.meta.url)
  await copyFile(new URL(`./fixtures/${name}.yml`, import.meta.url), target)
  return fileURLToPath(target)
}

test('bootProfile mounts entries from a YAML profile', async () => {
  const profile = await stageFixture('basic')
  const ctx = await bootProfile(profile)
  assert.equal(ctx.demo.greet('qm'), 'config-loaded, qm! config-loaded, qm!')

  // Unmounting the include entry cascades through its nested tree.
  await ctx.loader.remove('include')
  assert.equal(ctx.reflect.get('demo'), undefined)
})

test('!!js interpolation evaluates against the loader context', async () => {
  const profile = await stageFixture('interpolate')
  const ctx = await bootProfile(profile)
  assert.equal(ctx.demo.greet('qm'), 'greeting-2, qm!')

  await ctx.loader.remove('include')
})

test('a failing import rejects boot with the entry error', async () => {
  const profile = await stageFixture('bad-import')
  await assert.rejects(
    () => bootProfile(profile),
    /failed to import loader entry demo-bad \(@qm\/nonexistent-plugin\)/,
  )
})

test('the repository profile boots end to end', async () => {
  const profile = fileURLToPath(new URL('../../../profiles/cordis.yml', import.meta.url))
  const ctx = await bootProfile(profile)
  assert.equal(ctx.demo.greet('qm'), 'hello-2, qm! hello-2, qm! hello-2, qm!')

  const { port } = ctx.api.address
  const health = await fetch(`http://127.0.0.1:${port}/healthz`)
  assert.equal(health.status, 200)
  const token = await mintSignedPayload({ p: 'user-1' }, 'dev-m1-secret')
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const turn = (body: Record<string, unknown>, query = '') =>
    fetch(`http://127.0.0.1:${port}/v1/turns${query}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const sync = await turn({ text: 'hi profile', surface: 'api', conversation: { kind: 'dm', threadRef: 'thread:profile' } })
  assert.equal(sync.status, 200)
  assert.equal(((await sync.json()) as { reply?: string }).reply, 'echo: hi profile')

  const queued = await turn(
    { text: 'hi profile async', surface: 'api', conversation: { kind: 'dm', threadRef: 'thread:profile-async' } },
    '?async=1',
  )
  assert.equal(queued.status, 202)
  const { runId } = (await queued.json()) as { runId?: string }
  assert.ok(runId)
  let run: { targetState?: string; result?: { reply?: string } } | undefined
  for (let i = 0; i < 100; i += 1) {
    const poll: Response = await fetch(`http://127.0.0.1:${port}/v1/runs/${runId}`, { headers })
    assert.equal(poll.status, 200)
    run = (await poll.json()) as { targetState?: string; result?: { reply?: string } }
    if (run.targetState === 'succeeded' || run.targetState === 'failed') break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  // Phase 7 cutover: terminal truth is `targetState` (the raw row keeps
  // the legacy `status` column at 'running' after a target completion).
  assert.equal(run?.targetState, 'succeeded')
  assert.equal(run?.result?.reply, 'echo: hi profile async')

  await ctx.loader.remove('include')
  assert.equal(ctx.reflect.get('demo'), undefined)
  assert.equal(ctx.reflect.get('api'), undefined)
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/healthz`))
})

test('the agent profile stanza boots the pi engine from env interpolation', async () => {
  const profile = await stageFixture('agent-api')
  const ctx = await bootProfile(profile)
  const deps = ctx.api.orchestrator.deps
  assert.deepEqual(deps.harness.ids().sort(), ['mock', 'pi'])
  const { port } = ctx.api.address
  const token = await mintSignedPayload({ p: 'user-1' }, 'dev-p1-agent-secret')
  const res = await fetch(`http://127.0.0.1:${port}/v1/turns`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'hi pi boot',
      surface: 'api',
      harness: 'mock',
      conversation: { kind: 'dm', threadRef: 'thread:agent-api' },
    }),
  })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { reply?: string }).reply, 'echo: hi pi boot')

  await ctx.loader.remove('include')
  assert.equal(ctx.reflect.get('api'), undefined)
})
