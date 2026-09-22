/**
 * ToolContext control-plane behavior tests (T-cluster wiring): the cron
 * surface runs the full chain over the real @qm/triggers memory store and
 * scheduler (create → fire → runs → patch → delete), the webhook surface
 * creates/lists/disables over the real store, and the share surface gates
 * through the grant ledger. MCP rides a stub service.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createCronScheduler, createMemoryCronStore } from '@qm/triggers'
import { createMemoryRunStore, createMemorySessionStore } from '@qm/store'
import type { ResolutionService, RunStore } from '@qm/types'
import {
  createCronControl,
  createMemoryBlobTransfer,
  createMemoryFileStore,
  createMemoryGrantLedger,
  createMemoryWebhookStore,
  createToolControlSurfaces,
  type CronControlDeps,
  type ToolControlDeps,
} from '../src/index.ts'

const T0 = 1_700_000_000_000

const RESOLUTION: ResolutionService = {
  resolve: async () => ({ systemPrompt: 'test', orgScopeId: 'org:test' }),
  scopeFor: () => 'org:test',
}

function cronDeps(): CronControlDeps & { runs: RunStore } {
  const crons = createMemoryCronStore()
  const runs = createMemoryRunStore()
  let clock = T0
  const scheduler = createCronScheduler({
    crons,
    runs,
    sessions: createMemorySessionStore(),
    resolution: RESOLUTION,
    now: () => clock,
  })
  return {
    crons,
    runs,
    scheduler,
    scopeFor: () => 'org:test',
    deliveries: () => undefined,
  }
}

function toolControl(over: Partial<ToolControlDeps> = {}): ReturnType<typeof createToolControlSurfaces> {
  const webhookStore = createMemoryWebhookStore()
  const fileStore = createMemoryFileStore({ blobTransfer: createMemoryBlobTransfer(), grants: createMemoryGrantLedger() })
  return createToolControlSurfaces({
    actorId: 'feishu:ada',
    cron: cronDeps,
    webhooks: () => webhookStore,
    orgScope: 'org:test',
    grants: () => createMemoryGrantLedger(),
    files: () => fileStore,
    ...over,
  })
}

test('cron surface: create → fire → runs → patch → setEnabled → delete over the real scheduler', async () => {
  const surfaces = toolControl()
  assert.ok(surfaces.crons)

  const refused = await surfaces.crons.cronCreate({ schedule: { everyMs: 500 }, action: 'x', destinationKey: 'd1' }, 'feishu:ada')
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.match(refused.message, /capability-mode/)

  const noTask = await surfaces.crons.cronCreate({ schedule: { everyMs: 500 } }, 'feishu:ada')
  assert.equal(noTask.ok, false)
  if (!noTask.ok) assert.match(noTask.message, /task \(what to do\) or text/)

  const world = cronDeps()
  const surfacesWithWorld = createToolControlSurfaces({
    actorId: 'feishu:ada',
    cron: () => world,
    orgScope: 'org:test',
  })
  assert.ok(surfacesWithWorld.crons)
  const created = await surfacesWithWorld.crons.cronCreate(
    { schedule: { everyMs: 60_000, firstFireAt: T0 + 60_000 }, title: 'standup notes', action: 'write the standup notes' },
    'feishu:ada',
  )
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(created.cron.title, 'standup notes')
  assert.equal(created.cron.owner, 'feishu:ada')
  assert.equal(created.cron.ownerScopeId, 'org:test')

  const fired = await surfacesWithWorld.crons.cronRun(created.cron.id)
  assert.equal(fired.ok, true)
  const submitted = await world.runs.list({ limit: 10 })
  assert.equal(submitted.length, 1, 'cronRun submits one run through the scheduler')
  await world.runs.complete(submitted[0]!.id, submitted[0]!.leaseToken!, { status: 'ok', reply: 'notes written' })

  const runs = await surfacesWithWorld.crons.cronRuns(created.cron.id, { limit: 5 }, 'feishu:ada')
  assert.equal(runs.ok, true)
  if (!runs.ok) return
  assert.equal(runs.total, 1)
  assert.equal(runs.runs.length, 1)
  assert.equal(runs.runs[0]!.reply, 'notes written')

  const patched = await surfacesWithWorld.crons.cronPatch(created.cron.id, { title: 'standup notes v2' }, 'feishu:ada')
  assert.equal(patched.ok, true)
  if (!patched.ok) return
  assert.equal(patched.cron.title, 'standup notes v2')

  const foreignPatch = await createCronControl(world).cronPatch(created.cron.id, { title: 'hijack' }, 'feishu:mallory')
  assert.equal(foreignPatch.ok, false)
  if (!foreignPatch.ok) assert.equal(foreignPatch.code, 'forbidden')

  const disabled = await surfacesWithWorld.crons.cronSetEnabled(created.cron.id, false, 'feishu:ada')
  assert.equal(disabled.ok, true)
  if (disabled.ok) assert.equal(disabled.cron.enabled, false)

  const pausedRun = await surfacesWithWorld.crons.cronRun(created.cron.id)
  assert.equal(pausedRun.ok, false)
  if (!pausedRun.ok) assert.equal(pausedRun.code, 'bad_request')

  const deleted = await surfacesWithWorld.crons.cronDelete(created.cron.id, 'feishu:ada')
  assert.equal(deleted.ok, true)
  const gone = await surfacesWithWorld.crons.cronGet(created.cron.id, 'feishu:ada')
  assert.equal(gone.ok, false)
  if (!gone.ok) assert.equal(gone.code, 'not_found')
})

test('webhook surface: create returns the inbound url once, list redacts, strangers stay blind', async () => {
  const surfaces = toolControl({ webhookPublicUrl: 'https://qm.example' })
  assert.ok(surfaces.webhooks)

  const created = await surfaces.webhooks.webhookCreate({
    action: 'dispatch the payload to the agent',
    verification: { scheme: 'hmac-sha256', secret: 's3cret' },
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.match(created.url, /^https:\/\/qm\.example\/v1\/webhooks\/incoming\//)
  assert.equal(created.secret, 's3cret')

  const listed = await surfaces.webhooks.webhookList()
  assert.equal(listed.length, 1)
  assert.equal(listed[0]!.verification.secret, '***', 'list redacts the secret like the route')

  const stranger = toolControl({ actorId: 'feishu:mallory', webhooks: () => createMemoryWebhookStore() })
  assert.ok(stranger.webhooks)
  const empty = await stranger.webhooks.webhookList()
  assert.equal(empty.length, 0, 'another actor sees none of ada\u2019s webhooks')
  const hijack = await stranger.webhooks.webhookDisable('whatever')
  assert.equal(hijack.ok, false)
  if (!hijack.ok) assert.equal(hijack.code, 'not_found')
})

test('share surface: absent without a grant ledger; non-file types answer not_found', async () => {
  const surfaces = toolControl()
  assert.ok(surfaces.share)

  const otherType = await surfaces.share.shareArtifact({ type: 'skill', id: 's1', scope: 'org' })
  assert.equal(otherType.ok, false)
  if (!otherType.ok) assert.match(otherType.message, /skill store wiring/)

  const missing = await surfaces.share.shareArtifact({ type: 'file', id: 'nope', scope: 'org' })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.code, 'not_found')

  const bare = createToolControlSurfaces({ actorId: 'feishu:ada', orgScope: 'org:test' })
  assert.equal(bare.share, undefined, 'share surface only exists when a grant ledger is wired')
})

test('unwired stores answer CONTROL_UNAVAILABLE instead of pretending success', async () => {
  const surfaces = createToolControlSurfaces({ actorId: 'feishu:ada', orgScope: 'org:test' })
  assert.equal(surfaces.crons, undefined)
  assert.equal(surfaces.webhooks, undefined)
  assert.equal(surfaces.mcp, undefined)
  assert.equal(surfaces.share, undefined)

  const noActor = createToolControlSurfaces({ cron: cronDeps, orgScope: 'org:test' })
  assert.ok(noActor.crons)
  const refused = await noActor.crons.cronList()
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.equal(refused.code, 'control_unavailable')
})
