/**
 * TriggersService cordis mount: the scheduler runs over the shared
 * im-bridge delivery queue, cron fires land as echo runs through the api
 * composition root with the fire log recording outcomes, and the trigger
 * sink submits keyed turns. Uses the real service graph (api + im-bridge
 * + triggers) with no sockets and no provider — delivery is asserted
 * through the fire log and run records.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiService, TriggerRuntimeCordisService } from '@qm/api'
import { Context } from '@qm/cordis'
import { ImTurnBridgeService } from '@qm/im-bridge'
import { TriggersService } from '../src/index.ts'

async function setup(config: { intervalMs?: number } = {}) {
  const ctx = new Context()
  const apiFiber = await ctx.plugin(ApiService, { secrets: ['test-triggers-secret'] })
  // Phase 4 composition: API exposes the minimal runtime contract; the
  // TriggersService injects it — never ApiService.
  const runtimeFiber = await ctx.plugin(TriggerRuntimeCordisService, {})
  const bridgeFiber = await ctx.plugin(ImTurnBridgeService, {})
  const triggersFiber = await ctx.plugin(TriggersService, config)
  return {
    ctx,
    dispose: async () => {
      await triggersFiber.dispose()
      await bridgeFiber.dispose()
      await runtimeFiber.dispose()
      await apiFiber.dispose()
    },
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return condition()
}

test('TriggersService mounts the scheduler: cron fires become runs and the fire log records outcomes', async () => {
  const t = await setup({ intervalMs: 25 })
  try {
    assert.ok(t.ctx.triggers.crons, 'the cron store is exposed on the service')
    const cron = await t.ctx.triggers.crons.create({
      scopeId: 'org:default',
      ownerId: 'cron:owner',
      createdBy: 'test',
      schedule: { everyMs: 100 },
      action: 'fire the e2e marker',
      title: 'scheduler mount smoke',
    })
    assert.ok(
      await waitFor(async () => (await t.ctx.triggers.crons.getFires(cron.id)).total >= 2),
      'the scheduler fires recurring slots',
    )
    const page = await t.ctx.triggers.crons.getFires(cron.id)
    const entry = page.runs[0]
    assert.ok(entry)
    assert.equal(entry.status, 'ok')
    assert.equal(entry.reply, '[reply echoed cron runtime context; omitted]', 'context echoes collapse in the fire log')
    assert.ok(entry.runId)
    const runs = await t.ctx.api.runs.list()
    const run = runs.find((candidate) => candidate.id === entry.runId)
    assert.ok(run, 'the fired turn is on the api run queue')
    assert.deepEqual(run.request.origin, { kind: 'automation' })
    assert.equal(run.request.surface, 'cron')
    assert.equal(run.status, 'done')
    assert.ok(run.request.text.includes('fire the e2e marker'), 'the fire carries the stored task')
  } finally {
    await t.dispose()
  }
})

test('TriggersService exposes the trigger sink: keyed fire becomes one turn routed to the run queue', async () => {
  const t = await setup({ intervalMs: 25 })
  try {
    const submission = await t.ctx.triggers.triggers.fire({
      key: 'evt-1',
      text: 'hello trigger',
      ownerId: 'trigger:owner',
    })
    assert.equal(submission.deduped, false)
    assert.ok(
      await waitFor(async () => {
        const run = (await t.ctx.api.runs.list()).find((candidate) => candidate.id === submission.runId)
        return run?.status === 'done'
      }),
      'the trigger turn completes',
    )
    const run = (await t.ctx.api.runs.list()).find((candidate) => candidate.id === submission.runId)
    assert.ok(run)
    assert.equal(run.request.surface, 'trigger')
    assert.equal(run.result?.reply, 'echo: hello trigger')
  } finally {
    await t.dispose()
  }
})
